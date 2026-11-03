#!/usr/bin/env python3
"""Read-only verification of transferred C3 changed-source facts."""
import argparse, hashlib, json
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);a=p.parse_args()
bundle=Path(__file__).resolve().parent;m=json.loads((bundle/'source/source-manifest.json').read_text())
assert hashlib.sha256((bundle/'source/C3.patch').read_bytes()).hexdigest()==m['patchSha256']
facts={}
for rel,expected in m['sourceManifest'].items():
 file=a.root/rel
 assert file.is_file() and not file.is_symlink(),rel
 actual=hashlib.sha256(file.read_bytes()).hexdigest();assert actual==expected,rel;facts[rel]=actual
 # Git modes are recorded separately; this workspace filesystem may expose synthetic executable bits.
result=hashlib.sha256(json.dumps(facts,sort_keys=True,separators=(',',':')).encode()).hexdigest()
assert result==m['sourceChecksum'];print(json.dumps({'paths':len(facts),'sourceChecksum':result,'result':'all transferred changed-source facts verified','fullTreeOrIntegrationAcceptance':False}))
