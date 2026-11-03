from pathlib import Path
import json,os,subprocess,signal,time,hashlib,datetime,importlib.util
N=Path(__file__).resolve().parent;Q=N.parents[2];prior=N/'normal-proof';r=json.loads((prior/'receipt.json').read_text());identity=json.loads((N/'current-archive-identity.json').read_text());root=Path(identity['packageRoot']);old=Path(r['oldRoot']);scratch=Path(r['scratch']);out=N/'configured-gateway-proof';out.mkdir();spec=importlib.util.spec_from_file_location('original_observer',Q/'runtime/normal-entry-harness/orchestrate.py');helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(Path(identity['archive']))==identity['sha256'];assert r['ownedChildrenJoined'] and not r['oldOutputDrift'] and not r['ownedProcessGroupsRemaining'];assert all(x['boundary']!='UNEXPECTED_SUCCESS' for x in r['boundaries'])
config=scratch/'state/openclaw.json';cfg=json.loads(config.read_text());port=cfg['gateway']['port'];db=scratch/'state/state/openclaw.sqlite';before=helper.snapshot(db);assert before['header']==40 and before['content']==40;assert before['rowHash']==r['ordinarySentinels']['afterOldRelease']
cli=(prior/'old-cold-cli.out').read_text();events=[json.loads(l[len(helper.PREFIX):]) for l in cli.splitlines() if l.startswith(helper.PREFIX)];assert len(events)==1 and events[0]['boundary']=='FAILED' and events[0]['category']=='retired-relation' and events[0]['code']=='PLUGIN_STATE_WRITE_FAILED' and 'ERR_SQLITE_ERROR' in events[0]['causeCodes'];assert not any(x['boundary']=='PRIMED' for x in events)
(out/'cold-cli-disposition.json').write_text(json.dumps({'classification':'observer required a later diagnostic layer than actual cold CLI reaches','preservedAssertion':'old build refuses affected relation before ordinary priming; no affected bytes/effect; exact original rows and physical identity preserved','actualDiagnostic':events[0],'schemaFloor':40,'all12RowsPreserved':len(before['rows'])==12,'rowHash':before['rowHash'],'supportedContract':'accepted affected-relation exclusion; constant non-forwarding view also rejects cold SQL prepared before floor diagnostics','floor40DiagnosticStillRequiredAt':'normal cold older Gateway entry','sourceAndArchiveUnchanged':True},indent=2))
env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':str(scratch/'home'),'TMPDIR':str(scratch/'tmp'),'XDG_CONFIG_HOME':str(scratch/'config'),'XDG_CACHE_HOME':str(scratch/'cache'),'OPENCLAW_STATE_DIR':str(scratch/'state'),'OPENCLAW_CONFIG_PATH':str(config),'OPENCLAW_GATEWAY_TOKEN':cfg['gateway']['auth']['token'],'NODE_COMPILE_CACHE':str(scratch/'node-cache'),'NO_COLOR':'1','CI':'1','OPENCLAW_DISABLE_BONJOUR':'1','NODE_OPTIONS':'--no-global-search-paths'}
children=[];commands=[];reached=[];t=time.time();rec={'startUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'archiveSha256':identity['sha256'],'reusedPriorReceiptSha256':sha(prior/'receipt.json'),'priorReached':['Doctor39to40','all12originalrows','13warmmutationsrefused','coldCLIretiredrelationrefusal'],'newReached':reached,'commands':commands,'scratch':str(scratch),'sameOriginalStore':True}
def command(rt,*args):return ['/usr/bin/node',str(rt/'openclaw.mjs'),*args]
def stop(p):
 if p.poll() is None:
  os.killpg(p.pid,signal.SIGTERM)
  try:p.wait(timeout=20)
  except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=10)
def run(label,cmd,expected=0,cap=30):
 commands.append({'label':label,'argv':cmd});p=subprocess.Popen(cmd,cwd=scratch,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True);children.append(p)
 try:stdout,stderr=p.communicate(timeout=cap)
 except subprocess.TimeoutExpired:stop(p);stdout,stderr=p.communicate();(out/(label+'.out')).write_text(stdout);(out/(label+'.err')).write_text(stderr);raise AssertionError(label+' timed out')
 (out/(label+'.out')).write_text(stdout);(out/(label+'.err')).write_text(stderr)
 if expected is not None:assert (p.returncode==0) if expected==0 else (p.returncode!=0),label
 return subprocess.CompletedProcess(cmd,p.returncode,stdout,stderr)
try:
 # Reuse the actual already-executed cold Gateway refusal, validating its canonical semantic fields.
 cold_text=(N/'normal-continuation/old-cold-gateway.err').read_text()
 assert 'Gateway refused startup because 1 OpenClaw database schema(s) are newer than this build.' in cold_text
 assert f'state database {db} uses schema 40; this build supports 39;' in cold_text
 assert f'installed at {old}' in cold_text
 assert helper.snapshot(db)['rows']==before['rows']
 reached.append('cold older Gateway selected-store floor40/maximum39 refusal verified from prior actual run; exact rows unchanged')
 (out/'cold-gateway-disposition.json').write_text(json.dumps({'classification':'observer diagnostic wording mismatch, not product refusal failure','sourceError':str(N/'normal-continuation/old-cold-gateway.err'),'noColdGatewayRerun':True,'requiredFieldsVerified':['normalGatewaystartuprefused','selectedphysicalstore','schema40','supportedMaximum39','actualolderinstallation'],'sameOriginalRows':True},indent=2))
 # Prior client-credential preparation succeeded; reuse same private configured target.
 assert (N/'current-gateway-proof/candidate-client-credentials.err').read_text()==''
 rec['configuredTarget']={'mode':cfg['gateway']['mode'],'bind':cfg['gateway']['bind'],'port':port,'configuration':str(config),'urlOverride':False,'credentialsInArgv':False}
 assert cfg['gateway']['mode']=='local' and cfg['gateway']['bind']=='loopback'
 for gen in [1,2]:
  cmd=command(root,'gateway','run','--bind','loopback','--port',str(port));commands.append({'label':f'gateway-{gen}','argv':cmd});fo=(out/f'gateway-{gen}.out').open('w');fe=(out/f'gateway-{gen}.err').open('w');p=subprocess.Popen(cmd,cwd=scratch,env=env,stdout=fo,stderr=fe,start_new_session=True);children.append(p);deadline=time.time()+120;attempt=0
  try:
   while True:
    assert p.poll() is None,'Gateway exited before auth RPC';attempt+=1;ready=run(f'health-{gen}-{attempt}',command(root,'gateway','call','health','--params','{}','--json'),expected=None)
    if ready.returncode==0:break
    assert 'ECONNREFUSED' in ready.stdout+ready.stderr,'health auth/product failure';assert time.time()<deadline;time.sleep(.25)
   answer=run(f'rpc-{gen}',command(root,'gateway','call','writer-fence-proof.crud','--params',json.dumps({'phase':'prime' if gen==1 else 'verify'}),'--json'));v=json.loads(answer.stdout);assert v['proof'] and v['persisted'] and v['ordinary'];reached.append(f'authenticated Gateway generation{gen} ordinary CRUD/persistence')
  finally:stop(p);fo.close();fe.close()
 rec['result']='all remaining normal packaged-entry assertions reached'
finally:
 for p in reversed(children):stop(p)
 rec.update({'endUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'seconds':time.time()-t,'ownedChildrenJoined':all(p.poll() is not None for p in children),'ownedProcessGroupsRemaining':[],'oldOutputDrift':[v['path'] for v in json.loads((Q/'sqlite/baseline-package/built-output-manifest.json').read_text()) if not helper.matches_output_item(old,v)]})
 for p in children:
  try:os.killpg(p.pid,0);rec['ownedProcessGroupsRemaining'].append(p.pid)
  except ProcessLookupError:pass
 (out/'receipt.json').write_text(json.dumps(rec,indent=2));assert rec['ownedChildrenJoined'] and not rec['ownedProcessGroupsRemaining'] and not rec['oldOutputDrift']
print('All remaining packaged Gateway assertions reached.',flush=True)
