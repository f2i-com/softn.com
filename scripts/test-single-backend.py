"""Verify the generic optional-backend archive on Linux using its bundled Node."""
import argparse,zipfile,tempfile,json,subprocess,os,hashlib
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--archive',required=True);args=p.parse_args()
repo=Path(__file__).resolve().parent.parent
assert Path(args.archive+'.sha256').read_text().split()[0]==hashlib.sha256(Path(args.archive).read_bytes()).hexdigest()
root=Path(tempfile.mkdtemp(prefix='softn-backend-package-'))
with zipfile.ZipFile(args.archive) as z:
    names=z.namelist()
    for name in ['webroot/index.html','webroot/app.softn','webroot/runtime.config.json','backend/bin/node','backend/runner.mjs','backend/wasm/zipp_wasm_bg.wasm','START-HERE.md']:
        assert name in names,name
    assert not any('/private/' in n or n.endswith('.sqlite') for n in names)
    assert not any(n.startswith('backend/app/') or n.startswith('backend/operator/') for n in names)
    info=json.loads(z.read('BUILD-INFO.json'));assert info['backendOptional'] is True
    for line in z.read('SHA256SUMS.txt').decode().splitlines():
        digest,name=line.split('  ',1);assert hashlib.sha256(z.read(name)).hexdigest()==digest,name
    z.extractall(root)
b=root/'backend';app=b/'app';app.mkdir()
(app/'manifest.json').write_text(json.dumps({'id':'org.example.counter','name':'Counter','version':'1.0.0','server':{'entry':'main.logic','requires':{'apiVersion':1,'capabilities':['sql','transaction-scope']},'database':{'migrations':['schema.sql']},'routes':[{'path':'/api/increment','method':'POST','handler':'increment','authorization':'anonymous','transaction':'write'}]}}))
(app/'schema.sql').write_text('CREATE TABLE counter(value INTEGER); INSERT INTO counter VALUES(0);')
(app/'main.logic').write_text('function increment(){softn.sql.execute("UPDATE counter SET value=value+1",[]);return {status:200,body:softn.sql.first("SELECT value FROM counter",[])};}')
subprocess.run(['php',str(b/'setup.php')],check=True)
tests=['runtime.test.mjs','request-hook.test.mjs','package.test.mjs','startup-diagnostics.test.mjs','websocket.test.mjs']
subprocess.run([str(b/'bin/node'),'--test',*[str(repo/'apps/softn-php/tests'/t) for t in tests]],env={**os.environ,'SOFTN_PHP_TEST_BACKEND':str(b)},check=True)
print('Optional backend archive verified:',root,flush=True)
