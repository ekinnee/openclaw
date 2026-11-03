"""Prepared only. Run after coordinator review and explicit packaged-proof GO."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import queue
import secrets
import shutil
import signal
import socket
import sqlite3
import stat
import subprocess
import tempfile
import threading
import time
from datetime import datetime, timezone

PREFIX = "WRITER_FENCE_PROOF "
OLD_MANIFEST_SHA = "e3b242ae89613816bcccd73a1203f0eccc760d4d4752b2d4439bf8d8750da08e"

def digest(data):
    return hashlib.sha256(data).hexdigest()

def matches_output_item(root, item):
    file = root / item["path"]
    if "link" in item:
        return file.is_symlink() and os.readlink(file) == item["link"]
    return not file.is_symlink() and file.is_file() and digest(file.read_bytes()) == item["sha256"]

def snapshot(database):
    # Supporting observer only: never opens writable state or supplies production admission.
    physical = database.stat()
    with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as db:
        catalog = dict(db.execute("SELECT name,type FROM sqlite_schema WHERE name IN ('plugin_state_entries','plugin_state_records')"))
        tables = [name for name, kind in catalog.items() if kind == "table"]
        assert len(tables) == 1, "mixed-or-missing-plugin-relation"
        relation = tables[0]
        assert relation in ("plugin_state_entries", "plugin_state_records")
        rows = list(db.execute("SELECT plugin_id,namespace,entry_key,value_json,created_at,expires_at FROM " + relation + " WHERE plugin_id='writer-fence-proof' ORDER BY namespace,entry_key"))
        floor = db.execute("PRAGMA user_version").fetchone()[0]
        content = db.execute("SELECT value_json FROM config_machine_state WHERE state_key='state.schema.contentVersion'").fetchone()
        content = json.loads(content[0]) if content else 0
        assert isinstance(content, int) and not isinstance(content, bool) and content >= 0
        if relation == "plugin_state_records":
            assert catalog.get("plugin_state_entries") == "view"
            sql = db.execute("SELECT sql FROM sqlite_schema WHERE name='plugin_state_entries'").fetchone()[0]
            assert " ".join(sql.replace('"', '').rstrip(';').split()).lower() == "create view plugin_state_entries as select 'upgrade-required' as unsupported_format"
            assert not db.execute("SELECT 1 FROM sqlite_schema WHERE type='trigger' AND tbl_name='plugin_state_entries'").fetchone()
        return {"relation": relation, "header": floor, "content": content, "rows": rows,
                "physicalIdentity": [physical.st_dev,physical.st_ino],
                "rowHash": digest(json.dumps(rows, separators=(',', ':')).encode())}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--old-root", type=Path, required=True)
    ap.add_argument("--candidate-root", type=Path, required=True)
    ap.add_argument("--old-manifest", type=Path, required=True)
    ap.add_argument("--candidate-identity", type=Path, required=True)
    ap.add_argument("--evidence", type=Path, required=True)
    args = ap.parse_args()
    assert args.old_root.resolve() != args.candidate_root.resolve()
    old_inputs=json.loads((Path(__file__).parent/'old-entry-inputs.json').read_text())
    assert str(args.old_root.resolve())==old_inputs['root'], 'old-root-is-not-sealed-built-baseline'
    for relative, expected in old_inputs['files'].items():
        assert digest((args.old_root/relative).read_bytes())==expected, relative
    assert digest(args.old_manifest.read_bytes()) == OLD_MANIFEST_SHA
    for item in json.loads(args.old_manifest.read_text()):
        assert matches_output_item(args.old_root, item), item["path"]
    for root in (args.old_root, args.candidate_root):
        assert root.is_absolute() and (root / "openclaw.mjs").is_file()
    assert args.candidate_identity.is_file(), "candidate-packaged-identity-required"
    assert args.evidence.is_absolute() and args.evidence.resolve().is_relative_to(Path(__file__).resolve().parents[2]), 'evidence-must-stay-in-task-artifacts'
    assert not args.evidence.exists(), "fresh-owned-evidence-required"
    args.evidence.mkdir(mode=0o700, parents=True)
    scratch = Path(tempfile.mkdtemp(prefix="writer-fence-built-proof-", dir="/tmp"))
    assert stat.S_IMODE(scratch.stat().st_mode) == 0o700 and scratch.resolve().parent == Path('/tmp')
    dirs = {name: scratch / name for name in ('home', 'state', 'tmp', 'config', 'cache', 'workspace', 'node-cache')}
    for directory in dirs.values():
        directory.mkdir(mode=0o700)
        assert stat.S_IMODE(directory.stat().st_mode) == 0o700
    plugin = scratch / "plugin"
    shutil.copytree(Path(__file__).parent / "plugin", plugin)
    # Artifact mounts may be 0777; normal discovery must receive safe owned files.
    for copied in [plugin, *plugin.rglob('*')]:
        copied.chmod(0o700 if copied.is_dir() else 0o600)
        assert stat.S_IMODE(copied.stat().st_mode) == (0o700 if copied.is_dir() else 0o600)
    token = secrets.token_hex(32)
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]
    config = dirs['state'] / 'openclaw.json'
    config.write_text(json.dumps({
        'gateway': {'mode': 'local', 'port': port, 'bind': 'loopback', 'auth': {'mode': 'token', 'token': token}, 'controlUi': {'enabled': False}, 'reload': {'mode': 'off'}},
        'agents': {'defaults': {'workspace': str(dirs['workspace'])}},
        'plugins': {'allow': ['writer-fence-proof'], 'load': {'paths': [str(plugin)]}, 'entries': {'writer-fence-proof': {'enabled': True}, 'codex': {'enabled': False}, 'matrix': {'enabled': False}}}
    }))
    config.chmod(0o600)
    env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': str(dirs['home']),
        'TMPDIR': str(dirs['tmp']), 'XDG_CONFIG_HOME': str(dirs['config']),
        'XDG_CACHE_HOME': str(dirs['cache']), 'OPENCLAW_STATE_DIR': str(dirs['state']),
        'OPENCLAW_CONFIG_PATH': str(config), 'OPENCLAW_GATEWAY_TOKEN': token,
        'NODE_COMPILE_CACHE': str(dirs['node-cache']), 'NO_COLOR': '1', 'CI': '1',
        'OPENCLAW_DISABLE_BONJOUR': '1',
        'NODE_OPTIONS': '--no-global-search-paths'}
    node = shutil.which('node', path=env['PATH']); assert node
    children = []
    threads = []
    receipts = {'startUtc': datetime.now(timezone.utc).isoformat(), 'startMonotonic': time.monotonic(),
        'scratch': str(scratch), 'oldRoot': str(args.old_root.resolve()), 'candidateRoot': str(args.candidate_root.resolve()),
        'oldManifestSha256': OLD_MANIFEST_SHA, 'candidateIdentitySha256': digest(args.candidate_identity.read_bytes()),
        'credentialValuesOmitted': True, 'commands': [], 'boundaries': []}
    def command(root, *argv):
        return [node, str(root / 'openclaw.mjs'), *argv]
    def run(label, cmd, timeout=180, expected=0):
        receipts['commands'].append({'label': label, 'argv': cmd})
        child = subprocess.Popen(cmd, env=env, cwd=scratch, text=True, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, start_new_session=True)
        children.append(child)
        timed_out = False
        try: stdout, stderr = child.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True; stop(child); stdout, stderr = child.communicate(timeout=10)
        (args.evidence / (label+'.out')).write_text(stdout)
        (args.evidence / (label+'.err')).write_text(stderr)
        assert not timed_out, label+'-timeout-unreached'
        if expected is not None:
            assert (child.returncode == 0) if expected == 0 else (child.returncode != 0), label
        return subprocess.CompletedProcess(cmd,child.returncode,stdout,stderr)
    def stop(child):
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            try: child.wait(timeout=30)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL); child.wait(timeout=10)
        assert child.poll() is not None
    events = queue.Queue()
    def drain(child, label):
        with (args.evidence / (label+'.out')).open('w') as output:
            for line in child.stdout:
                output.write(line); output.flush()
                if line.startswith(PREFIX): events.put(json.loads(line[len(PREFIX):]))
    def until(boundary, timeout=180):
        deadline = time.monotonic()+timeout
        while True:
            assert time.monotonic() < deadline, 'old-writer-boundary-timeout:'+boundary
            try:
                event = events.get(timeout=min(0.5, max(0.1, deadline-time.monotonic())))
            except queue.Empty:
                assert held.poll() is None or thread.is_alive(), 'old-writer-exited-before:'+boundary
                continue
            receipts['boundaries'].append(event)
            assert event['boundary'] not in ('FAILED','UNEXPECTED_SUCCESS'), 'old-writer-proof-failed-stop'
            if event['boundary'] == boundary: return event
            assert time.monotonic() < deadline
    try:
        olderr = (args.evidence / 'old-held.err').open('w')
        heldcmd = command(args.old_root, 'writer-fence-proof')
        receipts['commands'].append({'label': 'old-held', 'argv': heldcmd})
        held = subprocess.Popen(heldcmd, env=env, cwd=scratch, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=olderr, text=True, bufsize=1, start_new_session=True)
        children.append(held)
        thread = threading.Thread(target=drain,args=(held,'old-held')); threads.append(thread); thread.start()
        assert until('PRIMED')['ordinaryPositive'] is True
        database = dirs['state']/'state'/'openclaw.sqlite'
        before = snapshot(database); assert before['relation']=='plugin_state_entries' and max(before['header'],before['content'])==39
        run('candidate-doctor', command(args.candidate_root,'doctor','--repair','--non-interactive','--yes','--no-workspace-suggestions'))
        upgraded = snapshot(database)
        assert upgraded['relation']=='plugin_state_records' and max(upgraded['header'],upgraded['content'])==40
        assert upgraded['physicalIdentity']==before['physicalIdentity'], 'doctor-replaced-selected-physical-file'
        assert [row for row in before['rows'] if row[5] is None]==[row for row in upgraded['rows'] if row[5] is None], 'doctor-changed-nonexpiring-originals'
        receipts['doctorExpiredRowDelta']=len(upgraded['rows'])-len(before['rows'])
        held.stdin.write('RELEASE_AFTER_DOCTOR\n'); held.stdin.flush(); held.stdin.close()
        until('SETTLED'); assert held.wait(timeout=30)==0; thread.join(timeout=10); assert not thread.is_alive(); olderr.close()
        expected = {'sync.register','sync.delete','sync.clear','sync.expiry-trigger',
                    'legacy.register','legacy.delete','legacy.clear','v2.register','v2.cas',
                    'v2.delete','v2.clear','v2.expiry-trigger','v2.move'}
        invoked = [e['operation'] for e in receipts['boundaries'] if e['boundary']=='INVOKED']
        outcomes = [e['operation'] for e in receipts['boundaries'] if e['boundary'] in ('REFUSED','NO_EFFECT')]
        assert len(invoked)==13 and set(invoked)==expected
        assert len(outcomes)==13 and set(outcomes)==expected
        after = snapshot(database); assert after['rows']==upgraded['rows'], 'old-writer-changed-originals'
        assert all(e.get('category')!='unqualified-refusal' for e in receipts['boundaries']), 'unqualified-denial-not-fence-proof'
        receipts['ordinarySentinels']={'beforeDoctor':before['rowHash'],'afterDoctorBeforeOldRelease':upgraded['rowHash'],'afterOldRelease':after['rowHash'],'exactPreservation':True,'rowCount':len(before['rows'])}
        cold = run('old-cold-cli', command(args.old_root,'writer-fence-proof'), timeout=30, expected=1)
        cold_events=[json.loads(line[len(PREFIX):]) for line in cold.stdout.splitlines() if line.startswith(PREFIX)]
        assert not any(e['boundary']=='PRIMED' for e in cold_events)
        assert 'newer schema version 40' in cold.stdout+cold.stderr or any(e.get('category')=='schema-admission' and e.get('newerFloor')==40 and e.get('supportedMax')==39 for e in cold_events), 'cold-floor-refusal-unreached'
        cold_gateway = run('old-cold-gateway', command(args.old_root,'gateway','run','--bind','loopback','--port',str(port)), timeout=30, expected=1)
        assert 'newer schema version 40' in cold_gateway.stdout+cold_gateway.stderr
        assert snapshot(database)['rows']==upgraded['rows'], 'cold-old-entry-changed-originals'
        run('candidate-client-credentials', command(args.candidate_root,'doctor','--client-credentials','--repair','--non-interactive'))
        for generation in (1,2):
            gwerr = (args.evidence/f'gateway-{generation}.err').open('w')
            gwout = (args.evidence/f'gateway-{generation}.out').open('w')
            gwcmd = command(args.candidate_root,'gateway','run','--bind','loopback','--port',str(port))
            receipts['commands'].append({'label':f'gateway-{generation}','argv':gwcmd})
            gateway = subprocess.Popen(gwcmd,env=env,cwd=scratch,stdout=gwout,stderr=gwerr,start_new_session=True)
            children.append(gateway)
            deadline=time.monotonic()+120
            health_attempt=0
            while True:
                assert gateway.poll() is None, 'gateway-exited-before-authenticated-rpc'
                healthcmd=command(args.candidate_root,'gateway','call','health','--url',f'ws://127.0.0.1:{port}','--params','{}','--json')
                # Only this read-only startup probe repeats. Never replay an uncertain mutation.
                health_attempt+=1
                ready=run(f'health-{generation}-attempt-{health_attempt}',healthcmd,timeout=30,expected=None)
                if ready.returncode==0: break
                assert 'ECONNREFUSED' in ready.stderr or 'connect ECONNREFUSED' in ready.stdout, 'health-auth-or-product-failure'
                assert time.monotonic()<deadline, 'gateway-readiness-timeout'
                time.sleep(0.25)
            receipts['commands'].append({'label':f'health-{generation}','argv':healthcmd})
            (args.evidence/f'health-{generation}.out').write_text(ready.stdout)
            (args.evidence/f'health-{generation}.err').write_text(ready.stderr)
            callcmd=command(args.candidate_root,'gateway','call','writer-fence-proof.crud','--url',f'ws://127.0.0.1:{port}','--params',json.dumps({'phase':'prime' if generation==1 else 'verify'}),'--json')
            result=run(f'rpc-{generation}',callcmd,timeout=30)
            (args.evidence/f'rpc-{generation}.out').write_text(result.stdout)
            (args.evidence/f'rpc-{generation}.err').write_text(result.stderr)
            payload=json.loads(result.stdout); assert payload['proof'] and payload['persisted'] and payload['ordinary']
            stop(gateway); gwout.close(); gwerr.close()
        receipts['result']='reached-selected-normal-entry-assertions'
    finally:
        for child in reversed(children): stop(child)
        for reader in threads:
            reader.join(timeout=10)
            assert not reader.is_alive(), 'owned-output-reader-not-joined'
        receipts['endUtc']=datetime.now(timezone.utc).isoformat(); receipts['seconds']=time.monotonic()-receipts['startMonotonic']
        receipts['ownedChildrenJoined']=all(child.poll() is not None for child in children)
        receipts['oldOutputDrift']=[item['path'] for item in json.loads(args.old_manifest.read_text()) if not matches_output_item(args.old_root, item)]
        receipts['ownedProcessGroupsRemaining']=[]
        for child in children:
            try: os.killpg(child.pid,0)
            except ProcessLookupError: pass
            else: receipts['ownedProcessGroupsRemaining'].append(child.pid)
        receipts['scratchPreserved']=True
        (args.evidence/'receipt.json').write_text(json.dumps(receipts,indent=2)+'\n')
        assert not receipts['oldOutputDrift'], 'old-built-output-drift'
        assert not receipts['ownedProcessGroupsRemaining'], 'owned-process-group-not-joined'


if __name__ == '__main__': main()
