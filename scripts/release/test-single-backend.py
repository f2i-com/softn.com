"""Verify an optional-backend archive on Linux using its bundled Node, and
the softn-runner beside it where the archive carries one.

Without --private: the static single-app runtime with a backend. With
--private: the PHP-served runtime, whose page is index.php and whose archive
lives under private/ rather than webroot/."""
import argparse,zipfile,tempfile,json,subprocess,os,hashlib
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--archive',required=True);p.add_argument('--private',action='store_true');args=p.parse_args()
repo=Path(__file__).resolve().parents[2]  # scripts/release/ -> the repository
assert Path(args.archive+'.sha256').read_text().split()[0]==hashlib.sha256(Path(args.archive).read_bytes()).hexdigest()
root=Path(tempfile.mkdtemp(prefix='softn-backend-package-'))
with zipfile.ZipFile(args.archive) as z:
    names=z.namelist()
    expected=['webroot/index.php','webroot/softn-serve.php','webroot/api.php','webroot/.htaccess','private/app.softn','private/serve.config.php','private/shell.html','private/.htaccess','DEPLOYMENT-SERVE.md'] if args.private else ['webroot/index.html','webroot/app.softn','webroot/runtime.config.json']
    for name in expected+['backend/bin/node','backend/runner.mjs','backend/wasm/zipp_wasm_bg.wasm','README.md','DEPLOYMENT.md','README-RUNTIME.md']:
        assert name in names,name
    if args.private:
        assert not any(n in ['webroot/index.html','webroot/app.softn','webroot/runtime.config.json','private/secret.key','private/digest.cache'] for n in names)
        assert not any(n.startswith('webroot/') and n.endswith('.softn') for n in names)
        rules=z.read('webroot/.htaccess').decode();assert 'RewriteRule ^api' in rules and 'softn-serve' in rules
    assert not any('/private/' in n or n.endswith('.sqlite') for n in names)
    assert not any(n.startswith('backend/app/') or n.startswith('backend/operator/') for n in names)
    info=json.loads(z.read('BUILD-INFO.json'));assert info['backendOptional'] is True;assert info.get('privateArchive',False) is args.private
    # softn-runner, where the archive carries it (a release's do): recorded, licensed, and the binary recorded.
    runner='backend/bin/softn-runner-linux-x86_64';softn_runner=runner in names
    assert (info.get('softnRunner') is not None)==softn_runner,info.get('softnRunner')
    if softn_runner:
        assert 'backend/licenses/SOFTN-RUNNER-THIRD-PARTY-LICENSES.txt' in names
        assert info['softnRunner']['sha256']==hashlib.sha256(z.read(runner)).hexdigest()
        assert z.getinfo(runner).external_attr>>16==0o100755,oct(z.getinfo(runner).external_attr>>16)
    for line in z.read('SHA256SUMS.txt').decode().splitlines():
        digest,name=line.split('  ',1);assert hashlib.sha256(z.read(name)).hexdigest()==digest,name
    z.extractall(root)
b=root/'backend';app=b/'app';app.mkdir()
(app/'manifest.json').write_text(json.dumps({'id':'org.example.counter','name':'Counter','version':'1.0.0','server':{'entry':'main.logic','requires':{'apiVersion':1,'capabilities':['sql','transaction-scope']},'database':{'migrations':['schema.sql']},'routes':[{'path':'/api/increment','method':'POST','handler':'increment','authorization':'anonymous','transaction':'write'}]}}))
(app/'schema.sql').write_text('CREATE TABLE counter(value INTEGER); INSERT INTO counter VALUES(0);')
(app/'main.logic').write_text('function increment(){softn.sql.execute("UPDATE counter SET value=value+1",[]);return {status:200,body:softn.sql.first("SELECT value FROM counter",[])};}')
setup=subprocess.run(['php',str(b/'setup.php')],check=True,capture_output=True,text=True);print(setup.stdout,end='',flush=True)
# Setup checks the runner a request starts, and says which.
assert ('Requests run on softn-runner' in setup.stdout)==softn_runner,setup.stdout
tests=['runtime.test.mjs','request-hook.test.mjs','package.test.mjs','startup-diagnostics.test.mjs','websocket.test.mjs']
subprocess.run([str(b/'bin/node'),'--test',*[str(repo/'apps/softn-host-php/tests'/t) for t in tests]],env={**os.environ,'SOFTN_PHP_TEST_BACKEND':str(b)},check=True)
print('Optional backend archive verified:',root,flush=True)
