"""Prepared only. Require final packer join, reviewed identities and coordinator GO."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import tarfile
import tempfile
import time
from datetime import datetime, timezone

def sha(data): return hashlib.sha256(data).hexdigest()
def manifest(root):
    result={}
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in dirs+files:
            file=Path(directory)/name; relative=str(file.relative_to(root))
            if file.is_symlink(): result[relative]={'link':os.readlink(file)}
            elif file.is_file(): result[relative]={'sha256':sha(file.read_bytes()),'bytes':file.stat().st_size}
    return result

def package_directory(path):
    return path.parent.name=='node_modules' or (path.parent.name.startswith('@') and path.parent.parent.name=='node_modules')

def dependency_manifest(start,name,boundary):
    metadata=json.loads((start/'package.json').read_text())
    if name==metadata.get('name'): return start/'package.json'
    cursor=start
    while cursor.is_relative_to(boundary):
        candidate=cursor/'node_modules'/name/'package.json'
        if candidate.is_file(): return candidate.resolve()
        if cursor==boundary: break
        cursor=cursor.parent
    return None

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--archive',type=Path,required=True)
    ap.add_argument('--archive-sha256',required=True)
    ap.add_argument('--source-receipt',type=Path,required=True)
    ap.add_argument('--source-receipt-sha256',required=True)
    ap.add_argument('--evidence',type=Path,required=True)
    args=ap.parse_args()
    here=Path(__file__).resolve().parent
    owners=json.loads((here/'workspace-owners.json').read_text())
    source=Path(owners['sourceRoot'])
    assert sha(args.archive.read_bytes())==args.archive_sha256
    assert sha(args.source_receipt.read_bytes())==args.source_receipt_sha256
    assert sha((source/'pnpm-lock.yaml').read_bytes())==owners['lockSha256']
    for data in owners['workspaceOwners'].values():
        assert sha((source/data['relativeRoot']/'package.json').read_bytes())==data['manifestSha256'], data['relativeRoot']
    assert not (source/'.artifacts/package-manifest/package.json.prepack-backup').exists(), 'packer-manifest-lifecycle-still-open'
    assert args.evidence.is_absolute() and args.evidence.resolve().is_relative_to(here.parents[1])
    assert not args.evidence.exists(); args.evidence.mkdir(mode=0o700,parents=True)
    for ambient in (Path('/tmp/node_modules'),Path('/node_modules')):
        assert not ambient.exists(), 'ambient-module-fallback-present'
    scratch=Path(tempfile.mkdtemp(prefix='writer-fence-package-',dir='/tmp'))
    assert stat.S_IMODE(scratch.stat().st_mode)==0o700
    receipt={'startUtc':datetime.now(timezone.utc).isoformat(),'startMonotonic':time.monotonic(),
        'archive':str(args.archive),'archiveSha256':args.archive_sha256,'sourceReceiptSha256':args.source_receipt_sha256,
        'sourceSnapshotSha256':owners['sourceSnapshotSha256'],'lockSha256':owners['lockSha256'],'scratch':str(scratch),
        'classification':'archive entry plus pinned copied registry fixture; not fresh install/release proof',
        'omittedWorkspaceLinks':[],'omittedWorkspacePackages':[],'omittedBinDirectories':[]}
    package=scratch/'package'; fixture=scratch/'node_modules'; fixture.mkdir(mode=0o700)
    with tarfile.open(args.archive,'r:gz') as archive:
        members=archive.getmembers()
        for member in members:
            path=PurePosixPath(member.name)
            assert not path.is_absolute() and '..' not in path.parts and path.parts[0]=='package', member.name
            assert member.isfile() or member.isdir() or member.issym() or member.islnk(), member.name
        archive.extractall(scratch,filter='data')
    before=manifest(package)
    for relative in ['openclaw.mjs','dist/plugin-sdk/plugin-state-store-runtime.js',
                     'dist/extensions/codex/native-session-binding-api.js',
                     'dist/extensions/matrix/doctor-contract-api.js','node_modules/@openclaw/ai/package.json']:
        assert (package/relative).is_file(), relative
    assert (package/'dist/entry.js').is_file() or (package/'dist/entry.mjs').is_file()
    for plugin in ('codex','matrix'):
        metadata=json.loads((package/f'dist/extensions/{plugin}/package.json').read_text())
        assert metadata.get('openclaw',{}).get('build',{}).get('bundledDist') is True, plugin
    workspace_names=set(owners['workspaceOwners'])
    workspace_roots=[(source/data['relativeRoot']).resolve() for data in owners['workspaceOwners'].values()]
    virtual=(source/'node_modules/.pnpm').resolve()
    assert virtual.is_dir() and virtual.is_relative_to(source)
    def ignore(directory,names):
        omitted=[]
        for name in names:
            path=Path(directory)/name
            if name=='.bin': receipt['omittedBinDirectories'].append(str(path.relative_to(source))); omitted.append(name); continue
            if path.is_symlink():
                target=path.resolve()
                if not target.is_relative_to(virtual):
                    assert any(target.is_relative_to(root) for root in workspace_roots), str(path)
                    receipt['omittedWorkspaceLinks'].append(str(path.relative_to(source))); omitted.append(name)
            elif path.is_dir() and package_directory(path) and (path/'package.json').is_file():
                metadata=json.loads((path/'package.json').read_text())
                if metadata.get('name') in workspace_names:
                    receipt['omittedWorkspacePackages'].append(str(path.relative_to(source))); omitted.append(name)
        return omitted
    target_virtual=fixture/'.pnpm'
    shutil.copytree(virtual,target_virtual,symlinks=True,ignore=ignore)
    # Recreate registry-only public links. Never overlay archive node_modules.
    for scope in sorted((source/'node_modules').iterdir()):
        if scope.name.startswith('.') : continue
        entries=list(scope.iterdir()) if scope.name.startswith('@') and scope.is_dir() and not scope.is_symlink() else [scope]
        for entry in entries:
            target=entry.resolve()
            if not target.is_relative_to(virtual):
                assert any(target.is_relative_to(root) for root in workspace_roots),str(entry)
                continue
            metadata=json.loads((target/'package.json').read_text())
            if metadata.get('name') in workspace_names: continue
            assert entry.is_symlink(), 'unexpected-physical-root-dependency'
            destination=fixture/entry.relative_to(source/'node_modules'); destination.parent.mkdir(exist_ok=True,parents=True)
            mapped=target_virtual/target.relative_to(virtual)
            destination.symlink_to(os.path.relpath(mapped,destination.parent))
    # Absolute links are rewritten only in our copy; every final link must stay inside it.
    for directory,dirs,files in os.walk(fixture,followlinks=False):
        for name in dirs+files:
            link=Path(directory)/name
            if link.is_symlink() and os.path.isabs(os.readlink(link)):
                source_target=Path(os.readlink(link)).resolve()
                assert source_target.is_relative_to(virtual),str(link)
                mapped=target_virtual/source_target.relative_to(virtual)
                link.unlink();link.symlink_to(os.path.relpath(mapped,link.parent))
    for directory,dirs,files in os.walk(fixture,followlinks=False):
        for name in dirs+files:
            file=Path(directory)/name
            if file.is_symlink(): assert file.exists() and file.resolve().is_relative_to(fixture),str(file)
            elif file.name=='package.json' and file.is_file() and package_directory(file.parent):
                metadata=json.loads(file.read_text());assert metadata.get('name') not in workspace_names,str(file)
    # Reconstruct previously qualified composition aliases from surviving exact owner edges.
    # No registry resolution, workspace fallback, or earlier archive is involved.
    promotions=json.loads((here/'qualified-promotions.json').read_text())
    root_metadata=json.loads((package/'package.json').read_text())
    receipt['promotedAliases']=[]
    for item in promotions:
        name=item['name'];pin=item['pin']
        assert root_metadata.get('dependencies',{}).get(name,root_metadata.get('optionalDependencies',{}).get(name))==pin,name
        candidates=[]
        for edge in item['sourceEdges']:
            edge=Path(edge);assert edge.exists(),str(edge)
            original=edge.resolve();assert original.is_relative_to(virtual)
            metadata=json.loads((original/'package.json').read_text());assert metadata['version']==pin
            mapped=target_virtual/original.relative_to(virtual)
            assert sha((mapped/'package.json').read_bytes())==sha((original/'package.json').read_bytes())
            candidates.append(mapped)
        assert candidates and len(set(candidates))==1,name
        destination=fixture/name
        if destination.exists():assert destination.resolve()==candidates[0]
        else:
            assert not destination.is_symlink();destination.parent.mkdir(parents=True,exist_ok=True)
            destination.symlink_to(os.path.relpath(candidates[0],destination.parent))
        receipt['promotedAliases'].append({'name':name,'pin':pin,'target':str(candidates[0].relative_to(fixture))})
    # Audit only the required manifest graph reached from the real archive.
    pending=[package/'package.json']; reached=set()
    while pending:
        package_json=pending.pop().resolve()
        if package_json in reached: continue
        reached.add(package_json)
        assert package_json.is_relative_to(package) or package_json.is_relative_to(fixture)
        metadata=json.loads(package_json.read_text())
        for name in metadata.get('dependencies',{}):
            if name in metadata.get('optionalDependencies',{}): continue
            target=dependency_manifest(package_json.parent,name,scratch)
            assert target is not None, 'missing-required-dependency:'+name
            assert target.is_relative_to(package) or target.is_relative_to(fixture),name
            if name in workspace_names: assert target.is_relative_to(package),'workspace-not-from-archive:'+name
            pending.append(target)
    copied=manifest(fixture)
    # Compare every regular registry byte with its frozen M occurrence.
    for relative,data in copied.items():
        if 'sha256' not in data: continue
        assert relative.startswith('.pnpm/'),relative
        original=virtual/Path(relative).relative_to('.pnpm')
        assert sha(original.read_bytes())==data['sha256'],relative
    assert manifest(package)==before,'archive-bytes-changed'
    for directory,dirs,files in os.walk(fixture,topdown=False,followlinks=False):
        for name in files:
            file=Path(directory)/name
            if not file.is_symlink(): file.chmod(0o555 if file.stat().st_mode&0o111 else 0o444)
        Path(directory).chmod(0o555)
    (args.evidence/'archive-manifest.json').write_text(json.dumps(before,sort_keys=True)+'\n')
    (args.evidence/'registry-fixture-manifest.json').write_text(json.dumps(copied,sort_keys=True)+'\n')
    receipt.update({'candidateRoot':str(package),'registryFixture':str(fixture),'archiveFiles':len(before),
        'fixtureEntries':len(copied),'endUtc':datetime.now(timezone.utc).isoformat(),'seconds':time.monotonic()-receipt['startMonotonic'],
        'archiveManifestSha256':sha((args.evidence/'archive-manifest.json').read_bytes()),
        'fixtureManifestSha256':sha((args.evidence/'registry-fixture-manifest.json').read_bytes()),
        'normalEntryExecuted':False,'dependencyVersionsResolved':False,
        'fixtureFilesystemClosureAudited':True,'requiredManifestGraphAudited':len(reached),
        'dynamicRuntimeImportsProven':False})
    (args.evidence/'identity.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps({'candidateRoot':str(package),'identity':str(args.evidence/'identity.json')}))

if __name__=='__main__': main()
