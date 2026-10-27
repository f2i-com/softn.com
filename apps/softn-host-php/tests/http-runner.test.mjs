/**
 * One request the whole way on this host: php-cgi (the SAPI a web server
 * hands a request to) -> api.php -> http.php -> the runner -> the engine and
 * SQLite, and the answer back. The other suites stop at one side of the
 * process http.php starts: request.test.mjs before it, and
 * route-declarations.test.mjs after it. What goes wrong between the two was
 * only seen by tests/apache-smoke.py, which needs Apache and a packaged
 * archive:
 *
 * - a 2 MiB body of numbers was 7.5 MB by the time PHP had decoded it and
 *   written it again, the runner refused it unread and uncounted, and the
 *   client was told 503 "please retry";
 * - a server that passes no DOCUMENT_ROOT was refused as though the backend
 *   were public (the fallback compared the backend with itself);
 * - slot files nobody could open were "the server is busy", for ever;
 * - the fifth of five calls made at once was "the server is busy" in the
 *   same instant, with a slot a fifth of a second from free;
 * - setup.php threw away what the runner said when the app did not start.
 *
 * The backend is assembled from this checkout: the runtime files, the ZIPP
 * release installed in packages/@softn/core/wasm-zipp, and `bin/node` a link
 * to the Node this test runs under. It needs a POSIX system: http.php starts
 * the runner with an environment of its own (PATH, TZ, NODE_NO_WARNINGS),
 * under which a Windows Node does not start. Skipped, visibly, otherwise.
 *
 * With SOFTN_TEST_RUNNER naming a Linux build of softn-runner
 * (apps/softn-runner), the backend carries a copy of it in bin/ and no Node
 * at all, so every request is answered by softn-runner or not answered: the
 * same suite, on the runner a release's backend starts.
 */
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,readFileSync,rmSync,existsSync,readdirSync,symlinkSync,realpathSync,chmodSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';

const here=dirname(fileURLToPath(import.meta.url));
const runtime=join(here,'../runtime');
const wasmDir=join(here,'../../../packages/@softn/core/wasm-zipp');
const [major,minor]=process.versions.node.split('.').map(Number);
const skip=process.platform==='win32'?'needs a POSIX system (http.php starts Node with an environment a Windows Node does not start under); run it on Linux'
  :spawnSync('php-cgi',['-v']).status!==0?'php-cgi is not on PATH (it ships with PHP; Debian/Ubuntu: php-cgi)'
  :!existsSync(join(wasmDir,'zipp_wasm_bg.wasm'))?'packages/@softn/core/wasm-zipp is not installed (npm run fetch:zipp)'
  :major<24||major===24&&minor<19?'Node 24.19 or newer (node:sqlite)':false;
if(skip)console.warn(`WARNING: tests/http-runner.test.mjs skipped: ${skip}. See apps/softn-host-php/README.md, Validation.`);
const test=(name,...rest)=>{const fn=rest.pop();return nodeTest(name,{...(rest[0]??{}),skip},fn);};
/** softn-runner's Linux build, when the suite runs on it (SOFTN_TEST_RUNNER). */
const softnRunner=process.env.SOFTN_TEST_RUNNER?realpathSync(process.env.SOFTN_TEST_RUNNER):null;
const RUNNER_FILE='bin/softn-runner-linux-x86_64';
if(!skip)console.log(`tests/http-runner.test.mjs runs on ${softnRunner?'softn-runner, '+softnRunner:'Node'}`);
/** Waits out the end of a minute, where the rate limiter starts counting again. */
function freshMinute() {
  const left=60000-Date.now()%60000;
  if(left<15000)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,left+200);
}

const SOURCE=`
function ping(req){return {status:200,body:{ok:true}};}
function count(req){var a=req.body.a;return {status:200,body:{n:a?a.length:0,first:a?a[0]:null,last:a?a[a.length-1]:null}};}
function signs(req){return {status:200,body:{negative:1/req.body.z<0,text:req.body.s,keys:Object.keys(req.body)}};}
`;
const ROUTES=[
  {method:'GET',path:'/api/ping',handler:'ping'},
  {method:'POST',path:'/api/count',handler:'count',maxBodySize:2097152},
  {method:'POST',path:'/api/signs',handler:'signs'},
];

/** webroot/ beside backend/, as the archive lays them out, set up as setup.php leaves it. */
function deployment(t,{appId='http-runner',ownNode=false,withNode=!softnRunner,config}={}) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'softn-http-runner-')));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const backend=join(root,'backend');
  mkdirSync(join(root,'webroot'));mkdirSync(join(backend,'wasm'),{recursive:true});
  copyFileSync(join(here,'../api.php'),join(root,'webroot/api.php'));
  for(const name of readdirSync(runtime))copyFileSync(join(runtime,name),join(backend,name));
  copyFileSync(join(wasmDir,'zipp_wasm.js'),join(backend,'wasm/zipp_wasm.mjs'));
  copyFileSync(join(wasmDir,'zipp_wasm_bg.wasm'),join(backend,'wasm/zipp_wasm_bg.wasm'));
  // A link, except where setup.php will run: setup makes bin/node 0700, and
  // through a link that would be the mode of the Node this machine runs.
  mkdirSync(join(backend,'bin'));
  if(withNode&&ownNode)copyFileSync(process.execPath,join(backend,'bin/node'));else if(withNode)symlinkSync(process.execPath,join(backend,'bin/node'));
  // softn-runner is a copy for the same reason, and executable, as setup leaves it.
  if(softnRunner){copyFileSync(softnRunner,join(backend,RUNNER_FILE));chmodSync(join(backend,RUNNER_FILE),0o755);}
  mkdirSync(join(backend,'app/server'),{recursive:true});mkdirSync(join(backend,'private/data'),{recursive:true});
  writeFileSync(join(backend,'app/manifest.json'),JSON.stringify({id:'http-runner',version:'1.0.0',main:'ui/main.ui',...(config?{config}:{}),server:{entry:'server/main.logic',requires:{apiVersion:1,capabilities:['sql']},routes:ROUTES}}));
  writeFileSync(join(backend,'app/server/main.logic'),SOURCE);
  writeFileSync(join(backend,'private/config.json'),JSON.stringify({appId,development:false,keyHex:'ab'.repeat(32),capabilities:['sql'],cryptoDomains:{hmac:'t:hmac:v1',seal:'t:seal:v1'},trustedProxies:[]}));
  /** What the web server tells PHP; `server` adds to it or, with undefined, leaves a name out. */
  const told=(method,uri,{body='',server={}}={})=>{
    const env={PATH:process.env.PATH,REQUEST_METHOD:method,REQUEST_URI:uri,QUERY_STRING:uri.split('?')[1]??'',SCRIPT_FILENAME:join(root,'webroot/api.php'),SCRIPT_NAME:'/api.php',
      DOCUMENT_ROOT:join(root,'webroot'),REDIRECT_STATUS:'200',HTTP_HOST:'site.example',REMOTE_ADDR:'203.0.113.10',GATEWAY_INTERFACE:'CGI/1.1',SERVER_PROTOCOL:'HTTP/1.1',
      ...(body!==''?{CONTENT_TYPE:'application/json',CONTENT_LENGTH:String(Buffer.byteLength(body))}:{}),...server};
    for(const name of Object.keys(env))if(env[name]===undefined)delete env[name];
    return env;
  };
  const answered=(stdout,log)=>{
    const at=stdout.search(/\r?\n\r?\n/),head=stdout.slice(0,at),text=stdout.slice(at).replace(/^\r?\n\r?\n/,''),headers={};
    for(const line of head.split(/\r?\n/)){const i=line.indexOf(':');headers[line.slice(0,i).toLowerCase()]=line.slice(i+1).trim();}
    // PHP's error log is php-cgi's stderr here: what an operator would read.
    return {status:Number((headers.status??'200').split(' ')[0]),headers,text,log};
  };
  const ask=(method,uri,{body='',server={}}={})=>{
    const r=spawnSync('php-cgi',[],{env:told(method,uri,{body,server}),input:body,encoding:'utf8',maxBuffer:64*1024*1024,timeout:60000});
    assert.equal(r.status,0,r.stderr);
    return answered(r.stdout,r.stderr);
  };
  /** The same request without waiting for it here, so that several can be in hand at once. */
  const asking=(method,uri)=>new Promise((resolve,reject)=>{
    const child=spawn('php-cgi',[],{env:told(method,uri),stdio:['ignore','pipe','pipe']});
    let out='',log='';child.stdout.on('data',chunk=>out+=chunk);child.stderr.on('data',chunk=>log+=chunk);
    child.on('error',reject);child.on('close',()=>resolve(answered(out,log)));
  });
  return {root,backend,ask,asking};
}

test('a body of numbers reaches the handler as the text the client sent',t=>{
  const d=deployment(t);
  const ping=d.ask('GET','/api/ping');
  assert.equal(ping.status,200,JSON.stringify(ping));
  assert.equal(ping.text,'{"ok":true}');
  assert.equal(ping.log,'','a request that succeeds logs nothing');
  // As large as the route allows, of a number PHP spells longer than the
  // client did (`1.0e+16`). It was answered 503 runner_unavailable: no retry
  // could mend it, each one cost a Node process, and none was counted
  // against the rate limit, since the runner died before it counted.
  const body='{"a":['+Array.from({length:419428},()=>'1e16').join(',')+']}';
  assert.ok(Buffer.byteLength(body)<=2097152);
  const counted=d.ask('POST','/api/count',{body});
  assert.equal(counted.status,200,counted.text+counted.log);
  assert.deepEqual(JSON.parse(counted.text),{n:419428,first:1e16,last:1e16});
  // The text is what the handler is handed: `-0` keeps its sign, as on the
  // Rust host (PHP wrote it back as `0`), non-ASCII is itself, and the keys
  // are in the client's order.
  const signs=d.ask('POST','/api/signs',{body:'{"z":-0,"s":"café \\ud83d\\ude00","b":1.0,"a":[]}'});
  assert.equal(signs.status,200,signs.text+signs.log);
  assert.deepEqual(JSON.parse(signs.text),{negative:true,text:'café \u{1F600}',keys:['z','s','b','a']});
  // One byte more than the route takes is still refused before a runner is started.
  assert.equal(d.ask('POST','/api/count',{body:body.slice(0,-2)+' '.repeat(40)+']}'}).status,413);
});

test('a body that is not JSON is refused 415, a multipart one too, which PHP reads before http.php sees it',t=>{
  const d=deployment(t);
  // PHP parses a multipart POST into $_POST and $_FILES and leaves
  // php://input empty: the handler was run with {} and answered 200.
  const form='--XB\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--XB--\r\n';
  const multipart=d.ask('POST','/api/signs',{body:form,server:{CONTENT_TYPE:'multipart/form-data; boundary=XB'}});
  assert.equal(multipart.status,415,multipart.text+multipart.log);
  assert.equal(JSON.parse(multipart.text).code,'unsupported_media_type');
  assert.equal(d.ask('POST','/api/signs',{body:'a=1',server:{CONTENT_TYPE:'application/x-www-form-urlencoded'}}).status,415);
  assert.equal(d.ask('POST','/api/signs',{body:'{"z":1}'}).status,200);
});

test('a server that passes no DOCUMENT_ROOT is served, and a backend beside api.php is still refused',t=>{
  const d=deployment(t);
  // The fallback for a missing DOCUMENT_ROOT was http.php's own directory,
  // which is the backend: compared with itself, it was always "public".
  const bare=d.ask('GET','/api/ping',{server:{DOCUMENT_ROOT:undefined}});
  assert.equal(bare.status,200,bare.text+bare.log);
  // Told the site's root is the folder above both: that is a public backend.
  const inside=d.ask('GET','/api/ping',{server:{DOCUMENT_ROOT:d.root}});
  assert.equal(inside.status,503);
  assert.equal(JSON.parse(inside.text).diagnostic,'backend_public');
});

test('slot files nobody can open are a fault of the installation, not a busy server',t=>{
  const d=deployment(t);
  // private/ this account may not write in (setup run as another account),
  // stood in for by directories where the four slot files would be.
  for(let i=0;i<4;i++)mkdirSync(join(d.backend,'private/slot-'+i+'.lock'));
  const r=d.ask('GET','/api/ping');
  assert.equal(r.status,503);
  // It was `database_busy`, "please retry", however long the client retried.
  assert.deepEqual(JSON.parse(r.text),{error:'The private backend folder is not writable by the account this web server runs PHP as. Run setup as that account.',code:'backend_unavailable',diagnostic:'private_permissions'});
});

test('a page that makes five calls at once is answered five times by four workers',async t=>{
  const d=deployment(t);
  // One alone first, so that the five find a database that is already made.
  assert.equal(d.ask('GET','/api/ping').status,200);
  // Four take the slots. The fifth was told `503 database_busy` in the same
  // instant; it now waits the fifth of a second until one of the four is
  // done (request.php SOFTN_SLOT_WAIT_MS is how long it would wait).
  const answers=await Promise.all(Array.from({length:5},()=>d.asking('GET','/api/ping')));
  assert.deepEqual(answers.map(a=>a.status),[200,200,200,200,200],answers.map(a=>a.text).join(' '));
  for(const a of answers){assert.equal(a.text,'{"ok":true}');assert.equal(a.log,'');}
});

test('a migration the deadline stopped is said where the operator looks: /api/meta, the log and setup.php',t=>{
  // After three stops no request starts the migration again, so the app is
  // down until somebody changes the file or removes the note. The answer was
  // `database_migrations`, the label of a migration that failed or does not
  // match the ledger, and setup.php said to check bin/node when its own
  // check was the request the deadline ended.
  const d=deployment(t,{ownNode:true});
  const slow='CREATE TABLE slow(n INTEGER); WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 4000000000) INSERT INTO slow SELECT count(*) FROM c;';
  mkdirSync(join(d.backend,'app/server/migrations'));
  writeFileSync(join(d.backend,'app/server/migrations/001.sql'),slow);
  writeFileSync(join(d.backend,'app/manifest.json'),JSON.stringify({id:'http-runner',version:'1.0.0',main:'ui/main.ui',server:{entry:'server/main.logic',requires:{apiVersion:1,capabilities:['sql']},
    database:{kind:'private-sqlite',migrations:['server/migrations/001.sql']},routes:ROUTES}}));
  const setup=()=>spawnSync('php',[join(d.backend,'setup.php')],{encoding:'utf8',timeout:60000});
  // setup's own check is a request: its runner is ended at the twenty seconds.
  const first=setup();
  assert.equal(first.status,1,first.stdout+first.stderr);
  assert.match(first.stderr,/WARNING: A database migration did not finish before the runner's deadline and was rolled back; after three such stops it is not started again\. Run setup with --migration-deadline=SECONDS to give it longer \(see README-RUNTIME\.md, Startup diagnostics, migration_stopped\)\. It said: softn: startup stage database_migrations: migration 001\.sql was stopped at the 20 s deadline \(1 of 3\)/);
  assert.doesNotMatch(first.stderr,/bin\/node and runner\.mjs are intact/);
  // The third stop, written as the runner writes it.
  const note=join(d.backend,'private/data/migration-stopped.json');
  assert.equal(JSON.parse(readFileSync(note,'utf8')).stops,1);
  writeFileSync(note,JSON.stringify({...JSON.parse(readFileSync(note,'utf8')),stops:3}));
  const meta=d.ask('GET','/api/meta');
  assert.equal(meta.status,503);
  assert.deepEqual(JSON.parse(meta.text),{error:'The backend is unavailable. Check its private configuration.',code:'backend_unavailable',diagnostic:'migration_stopped'});
  assert.match(meta.log,/softn-host GET \/api\/meta: softn: startup stage migration_stopped: Migration 001\.sql was stopped at the deadline 3 times and is not started again until it changes or migration-stopped\.json is removed from the private data folder/);
  const told=setup();
  assert.equal(told.status,1,told.stdout+told.stderr);
  assert.match(told.stderr,/WARNING: The application does not start: migration_stopped \(see README-RUNTIME\.md, Startup diagnostics\)\. Run setup again with --migration-deadline=SECONDS, long enough for the migration, to apply it\. It said: softn: startup stage migration_stopped: Migration 001\.sql was stopped at the deadline 3 times/);
  // Changed, it runs, and the app answers.
  writeFileSync(join(d.backend,'app/server/migrations/001.sql'),'CREATE TABLE slow(n INTEGER);');
  assert.equal(d.ask('GET','/api/ping').status,200);
  assert.ok(!existsSync(note));
});

test('setup.php --migration-deadline gives its own run longer and applies a migration stopped three times',t=>{
  // A migration that needs longer than a request's twenty seconds is stopped
  // on every request, and setup's check ran under the same deadline: after
  // three stops the app was down until the migration changed. The option is
  // passed to setup's run alone. Three stops are written here as the runner
  // writes them, for a migration that is quick, so the test does not wait.
  const d=deployment(t,{ownNode:true});
  const sql='CREATE TABLE quick(n INTEGER); INSERT INTO quick VALUES (7);';
  mkdirSync(join(d.backend,'app/server/migrations'));
  writeFileSync(join(d.backend,'app/server/migrations/001.sql'),sql);
  writeFileSync(join(d.backend,'app/manifest.json'),JSON.stringify({id:'http-runner',version:'1.0.0',main:'ui/main.ui',server:{entry:'server/main.logic',requires:{apiVersion:1,capabilities:['sql']},
    database:{kind:'private-sqlite',migrations:['server/migrations/001.sql']},routes:ROUTES}}));
  const note=join(d.backend,'private/data/migration-stopped.json');
  writeFileSync(note,JSON.stringify({name:'server/migrations/001.sql',sha256:createHash('sha256').update(sql).digest('hex'),stops:3}));
  const setup=(...args)=>spawnSync('php',[join(d.backend,'setup.php'),...args],{encoding:'utf8',timeout:60000});
  // Without it, as before: refused, and told how to apply it.
  const plain=setup();
  assert.equal(plain.status,1,plain.stdout+plain.stderr);
  assert.match(plain.stderr,/WARNING: The application does not start: migration_stopped/);
  // A request is refused too; it never carries setup's deadline.
  assert.equal(JSON.parse(d.ask('GET','/api/meta').text).diagnostic,'migration_stopped');
  for(const wrong of ['--migration-deadline','--migration-deadline=0','--migration-deadline=86401','--migration-deadline=ten']) {
    const refused=setup(wrong);
    assert.equal(refused.status,1,wrong);
    assert.match(refused.stderr,/^--migration-deadline takes a whole number of seconds from 1 to 86400, for example --migration-deadline=600\.\n$/,wrong);
  }
  const given=setup('--migration-deadline=600');
  assert.equal(given.status,0,given.stdout+given.stderr);
  assert.match(given.stdout,/Migrations may run for up to 600 s in this run's check of the app, a migration stopped three times included\./);
  assert.match(given.stdout,/Application http-runner 1\.0\.0 answers \/api\/meta\./);
  assert.ok(!existsSync(note),'the note of the stops is left behind');
  assert.equal(d.ask('GET','/api/ping').status,200);
});

test('setup.php starts the runner as a request does and says why an app does not start',t=>{
  // A configuration left from another app: the runner refuses it at the
  // application_identity stage and says why on stderr, which setup sent to
  // /dev/null. The operator was given the label and nothing else.
  const wrong=deployment(t,{appId:'another-app',ownNode:true});
  const failed=spawnSync('php',[join(wrong.backend,'setup.php')],{encoding:'utf8',timeout:60000});
  assert.equal(failed.status,1,failed.stdout+failed.stderr);
  assert.match(failed.stderr,/WARNING: The application does not start: application_identity \(see README-RUNTIME\.md, Startup diagnostics\)\. It said: softn: startup stage application_identity: Operator configuration belongs to another app/);
  // And one that starts is said to answer, by a runner started with the flags a request gets.
  const right=deployment(t,{ownNode:true});
  const ready=spawnSync('php',[join(right.backend,'setup.php')],{encoding:'utf8',timeout:60000});
  assert.equal(ready.status,0,ready.stdout+ready.stderr);
  assert.match(ready.stdout,/Application http-runner 1\.0\.0 answers \/api\/meta\./);
  assert.doesNotMatch(ready.stderr,/WARNING/);
  // And which runner that was: said where softn-runner is there, nothing where Node is all there is.
  if(softnRunner) {
    assert.match(ready.stdout,/Requests run on softn-runner \(bin\/softn-runner-linux-x86_64\), without Node\. To run them on Node instead, set "runner": "node" in private\/config\.json\./);
    assert.match(ready.stdout,/Each request may take up to 256 MiB for the app's engine \(a script's heap 192 MiB of it\) and 256 MiB for SQLite: "requestMemoryMb" in private\/config\.json, 128 to 1024\./);
  } else assert.doesNotMatch(ready.stdout,/softn-runner/);
});

nodeTest('softn-runner locks itself down before a request, and proves what this kernel refuses it',{skip:skip||(softnRunner?false:'needs SOFTN_TEST_RUNNER (a Linux build of softn-runner)')},t=>{
  const d=deployment(t);
  const check=spawnSync(join(d.backend,RUNNER_FILE),['--check-lockdown'],{env:{PATH:'/usr/bin:/bin',SOFTN_BACKEND_ROOT:d.backend},encoding:'utf8'});
  assert.equal(check.status,0,check.stderr);
  const report=JSON.parse(check.stdout);
  console.log(`lockdown here: Landlock ABI ${report.landlock.abi}, ${report.landlock.enforced}; seccomp ${report.seccomp}; probes ${JSON.stringify(report.probes)}`);
  // seccomp is in every kernel this runs on: other programs, processes,
  // sockets, signals to other processes, a mode changed by path, a symbolic
  // link and an x32 call are refused, each tried.
  assert.equal(report.seccomp,true,check.stdout);
  assert.equal(report.noNewPrivs,true);
  for(const probe of ['socket','fork','exec','signal','chmod','symlink','x32'])assert.equal(report.probes[probe],'denied',probe);
  // A folder outside the backend, listed before the lockdown, is refused
  // after it where the kernel enforces Landlock.
  const landlock=['full','partial'].includes(report.landlock.enforced);
  assert.equal(report.probes.outside,landlock?'denied':'allowed');
  // The probe's link was refused, so none is left.
  assert.ok(!existsSync(join(d.backend,'private/data/.softn-runner-probe')));
  // And setup says so. Every other test here, and route-declarations, runs
  // its requests under the same lockdown: migrations, SQL, the database's
  // log files, the rate-limit notes and a stopped migration's note.
  const setup=spawnSync('php',[join(d.backend,'setup.php')],{encoding:'utf8',timeout:60000});
  assert.equal(setup.status,0,setup.stdout+setup.stderr);
  assert.match(setup.stdout,/softn-runner locks itself down before every request: (Landlock \(ABI \d+(; a newer kernel refuses more)?\) keeps its files to the backend folder; )?seccomp refuses it other programs, new processes, network sockets, signals to other processes, and links, devices and file modes or owners changed by path\./);
  assert.match(setup.stdout,/Tried on this system and refused: .*a socket, a new process, running a program, a signal to another process, a mode changed by path, a symbolic link, an x32 system call\./);
  assert.doesNotMatch(setup.stdout,/not refused/);
});

nodeTest('the operator\'s requestMemoryMb is the memory a request on softn-runner may take, and setup says when it is not a number it takes',{skip:skip||(softnRunner?false:'needs SOFTN_TEST_RUNNER (a Linux build of softn-runner)')},t=>{
  const d=deployment(t);
  // 100 MB in one allocation: past the script heap of 128 MiB (64 MiB), the
  // engine stops the script, which no catch sees, and the log says why;
  // within 512 MiB's (448 MiB), made.
  const routes=[...ROUTES,{method:'GET',path:'/api/big',handler:'big'}];
  writeFileSync(join(d.backend,'app/manifest.json'),JSON.stringify({id:'http-runner',version:'1.0.0',main:'ui/main.ui',server:{entry:'server/main.logic',requires:{apiVersion:1,capabilities:['sql']},routes}}));
  writeFileSync(join(d.backend,'app/server/main.logic'),SOURCE+'function big(req){try{return {status:200,body:{length:new ArrayBuffer(100*1024*1024).byteLength}};}catch(e){return {status:200,body:{caught:String(e)}};}}\n');
  const config=JSON.parse(readFileSync(join(d.backend,'private/config.json'),'utf8'));
  const big=mb=>{writeFileSync(join(d.backend,'private/config.json'),JSON.stringify({...config,requestMemoryMb:mb}));return d.ask('GET','/api/big');};
  const small=big(128);
  assert.equal(small.status,500,small.text+small.log);
  assert.match(small.log,/softn: handler big: RangeError: script exceeded its memory budget/);
  const large=big(512);
  assert.equal(large.status,200,large.text+large.log);
  assert.deepEqual(JSON.parse(large.text),{length:100*1024*1024});
  // One that is not a whole number from 128 to 1024 is the 256 and a setup warning.
  writeFileSync(join(d.backend,'private/config.json'),JSON.stringify({...config,requestMemoryMb:'512'}));
  const setup=spawnSync('php',[join(d.backend,'setup.php')],{encoding:'utf8',timeout:60000});
  assert.equal(setup.status,1,setup.stdout+setup.stderr);
  assert.match(setup.stderr,/WARNING: "requestMemoryMb" in private\/config\.json must be a whole number of MiB from 128 to 1024; requests on softn-runner take 256 until it is\./);
  assert.match(setup.stdout,/Each request may take up to 256 MiB/);
});

test('a client past its limit is told 429 with Retry-After, and then by PHP before any runner starts',t=>{
  // The runner counts and leaves a note for the minute (request-worker.mjs
  // markLimited, worker.rs mark_limited) at the path http.php looks at
  // before it starts one (request.php softn_rate_marker): both runners must
  // write it there, or every request past the limit costs a process.
  const d=deployment(t,{config:{server:{requestsPerMinute:2}}});
  freshMinute();
  assert.equal(d.ask('GET','/api/ping').status,200);
  assert.equal(d.ask('GET','/api/ping').status,200);
  const limited=d.ask('GET','/api/ping');
  assert.equal(limited.status,429,limited.text+limited.log);
  assert.deepEqual(JSON.parse(limited.text),{error:'Too many requests.',code:'rate_limited'});
  assert.ok(Number(limited.headers['retry-after'])>=1,JSON.stringify(limited.headers));
  // With no runner left to start, the next is still answered 429: by PHP, from the note.
  renameSync(join(d.backend,softnRunner?RUNNER_FILE:'bin/node'),join(d.backend,'bin/gone'));
  const again=d.ask('GET','/api/ping');
  assert.equal(again.status,429,again.text+again.log);
  assert.ok(Number(again.headers['retry-after'])>=1);
});

nodeTest('with softn-runner and Node both there, softn-runner answers, and Node where the operator asks or a hook needs it',{skip:skip||(softnRunner?false:'needs SOFTN_TEST_RUNNER (a Linux build of softn-runner)')},t=>{
  const d=deployment(t,{withNode:true,ownNode:true});
  // Node's runner.mjs answers in a way softn-runner never would, so whichever starts is seen.
  writeFileSync(join(d.backend,'runner.mjs'),'process.stdout.write(\'{"status":200,"body":{"node":true}}\');');
  const config=JSON.parse(readFileSync(join(d.backend,'private/config.json'),'utf8'));
  const answer=settings=>{writeFileSync(join(d.backend,'private/config.json'),JSON.stringify({...config,...settings}));return d.ask('GET','/api/ping').text;};
  assert.equal(answer({}),'{"ok":true}');
  assert.equal(answer({runner:'node'}),'{"node":true}');
  // A request hook is a module of the operator's that only Node runs; softn-runner refuses the configuration.
  assert.equal(answer({enableRequestHook:true}),'{"node":true}');
  assert.equal(answer({enableAfterRequestHook:true}),'{"node":true}');
  assert.equal(answer({runner:'auto'}),'{"ok":true}');
  // setup.php checks the one a request starts, and says which, and why Node.
  const setup=()=>spawnSync('php',[join(d.backend,'setup.php')],{encoding:'utf8',timeout:60000});
  writeFileSync(join(d.backend,'private/config.json'),JSON.stringify({...config,runner:'node'}));
  const node=setup();
  assert.equal(node.status,0,node.stdout+node.stderr);
  assert.match(node.stdout,/Requests run on Node \(bin\/node and runner\.mjs\), not on softn-runner: "runner" is "node" in private\/config\.json\./);
  writeFileSync(join(d.backend,'private/config.json'),JSON.stringify({...config,enableRequestHook:true}));
  assert.match(setup().stdout,/not on softn-runner: a request hook is enabled in private\/config\.json, and only Node runs one\./);
  // softn-runner alone, without Node or runner.mjs at all: setup and requests.
  writeFileSync(join(d.backend,'private/config.json'),JSON.stringify(config));
  rmSync(join(d.backend,'bin/node'));rmSync(join(d.backend,'runner.mjs'));
  const alone=setup();
  assert.equal(alone.status,0,alone.stdout+alone.stderr);
  assert.match(alone.stdout,/Requests run on softn-runner/);
  assert.equal(d.ask('GET','/api/ping').text,'{"ok":true}');
});
