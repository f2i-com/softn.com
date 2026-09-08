from pathlib import Path
import zipfile,tempfile,subprocess,os,time,urllib.request,urllib.error,json,signal,fcntl,argparse
parser=argparse.ArgumentParser();parser.add_argument('--archive',required=True);args=parser.parse_args()
root=Path(tempfile.mkdtemp(prefix='softn-apache-php-'))
with zipfile.ZipFile(args.archive) as zipped:zipped.extractall(root/'counter')
counter=root/'counter/backend/app'
counter.mkdir()
manifest={'id':'org.example.counter','name':'Counter','version':'1.0.0','config':{'server':{'allowedOrigins':['https://counter.example']}},'server':{'entry':'main.logic','requires':{'apiVersion':1,'capabilities':['sql','transaction-scope']},'database':{'kind':'private-sqlite','migrations':['schema.sql']},'routes':[{'method':'POST','path':'/api/increment','handler':'increment','authorization':'application','transaction':'write'}]}}
manifest['server']['routes'].append({'method':'GET','path':'/api/counter','handler':'readCounter','authorization':'application','transaction':'read','poll':True})
(counter/'manifest.json').write_text(json.dumps(manifest))
(counter/'schema.sql').write_text('CREATE TABLE counter(value INTEGER); INSERT INTO counter VALUES(0);')
(counter/'main.logic').write_text('function increment(req){if(req.headers.authorization!=="Bearer fixture")return {status:401,body:{error:"unauthorized"},rollback:true};softn.sql.execute("UPDATE counter SET value=value+1",[]);return {status:200,body:softn.sql.first("SELECT value FROM counter",[])};}')
with (counter/'main.logic').open('a') as f:f.write('function readCounter(req){if(req.headers.authorization!=="Bearer fixture")return {status:401,body:{error:"unauthorized"}};return {status:200,body:softn.sql.first("SELECT value FROM counter",[])};}')
modules=['mpm_prefork','authz_core','authz_host','dir','mime','headers','rewrite','alias','actions','cgi']
for name in ['counter']:subprocess.run(['php',str(root/name/'backend/setup.php')],check=True)
config=f'ServerRoot "{root}"\nServerName localhost\nListen 127.0.0.1:8811\nPidFile "{root}/httpd.pid"\nErrorLog "{root}/error.log"\n'
config+='\n'.join(f'LoadModule {m}_module /usr/lib/apache2/modules/mod_{m}.so' for m in modules)
config+='\nTypesConfig /etc/mime.types\n<Directory />\nRequire all denied\n</Directory>\n'
config+='ScriptAlias /php-cgi /usr/bin/php-cgi\n<Directory /usr/bin>\nRequire all granted\nOptions +ExecCGI\n</Directory>\nAction application/x-httpd-php /php-cgi\nAddHandler application/x-httpd-php .php\n'
for name,port in [('counter',8811)]:
    web=root/name/'webroot'
    config+=f'<VirtualHost 127.0.0.1:{port}>\nServerName {name}.example\nDocumentRoot "{web}"\n<Directory "{web}">\nRequire all granted\nAllowOverride All\nOptions +ExecCGI\n</Directory>\n</VirtualHost>\n'
(root/'httpd.conf').write_text(config)
subprocess.run(['/usr/sbin/apache2','-t','-f',str(root/'httpd.conf')],check=True)
last_headers={}
def req(path,port=8811,method='GET',headers={},data=None):
    global last_headers
    try:
        with urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{port}'+path,method=method,headers=headers,data=data),timeout=32) as r:
            last_headers=dict(r.headers);return r.status,r.read()
    except urllib.error.HTTPError as e:return e.code,e.read()
with open(root/'apache.log','w') as log:
    server=subprocess.Popen(['/usr/sbin/apache2','-X','-f',str(root/'httpd.conf')],stdout=log,stderr=log,start_new_session=True)
    try:
        for _ in range(100):
            try:
                if req('/api/meta')[0]==200:break
            except Exception:pass
            time.sleep(.2)
        assert req('/api/meta')[0]==200,req('/api/meta')
        assert json.loads(req('/api/meta')[1])['appId']=='org.example.counter'
        assert req('/api/increment',method='POST')[0]==401
        for count in [1,2]:
            status,body=req('/api/increment',method='POST',headers={'Authorization':'Bearer fixture','Origin':'https://counter.example'})
            assert status==200,(status,body)
            assert json.loads(body)['value']==count
        assert req('/api/increment',method='POST',headers={'Origin':'https://evil.example'})[0]==403
        assert req('/api/counter',headers={'Authorization':'Bearer fixture'})[0]==200
        etag=last_headers['ETag']
        assert req('/api/counter',headers={'Authorization':'Bearer fixture','If-None-Match':etag})[0]==304
        assert req('/api/counter',headers={'Authorization':'Bearer wrong','If-None-Match':etag})[0]==401
        print('Conditional polling returns 304 only after the handler authorizes the request.',flush=True)
        for path in ['/backend/private/config.json','/server/main.logic','/private/config.json','/.htaccess']:
            assert req(path)[0] in [403,404],path
        print('Generic template with independent counter bundle: persistence, bearer forwarding, origins and private-file isolation passed.',flush=True)
        locks=[]
        for i in range(4):
            f=open(root/f'counter/backend/private/slot-{i}.lock','r+');fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB);locks.append(f)
        assert req('/api/meta')[0]==503
        for f in locks:f.close()
        worker=root/'counter/backend/request-worker.mjs';worker_source=worker.read_text()
        worker.write_text('import {DatabaseSync} from "node:sqlite"; import {fileURLToPath} from "node:url"; const d=new DatabaseSync(fileURLToPath(new URL("./private/data/application.sqlite",import.meta.url)));d.exec("BEGIN IMMEDIATE; UPDATE counter SET value=99");while(true){}')
        start=time.monotonic();assert req('/api/meta')[0]==503
        assert 19<=time.monotonic()-start<24
        worker.write_text(worker_source)
        status,body=req('/api/increment',method='POST',headers={'Authorization':'Bearer fixture'})
        assert status==200 and json.loads(body)['value']==3,(status,body)
        print('Independent runner deadline and SQLite rollback after forced exit passed.',flush=True)
        runner=root/'counter/backend/runner.mjs';original=runner.read_text()
        runner.write_text('process.stdout.write("x".repeat(4000000));')
        assert req('/api/meta')[0]==503
        runner.write_text('while(true){}')
        start=time.monotonic();assert req('/api/meta')[0]==503
        elapsed=time.monotonic()-start;assert 24<=elapsed<30,elapsed
        runner.write_text(original)
        assert req('/api/meta')[0]==200
        print('PHP supervisor: four-slot admission limit, output limit, 25-second timeout and recovery passed.',flush=True)
    finally:
        os.killpg(server.pid,signal.SIGTERM);server.wait(timeout=15)
print('Apache PHP test extraction: '+str(root))
