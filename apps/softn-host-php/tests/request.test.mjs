/**
 * The request and response rules http.php applies (runtime/request.php), run
 * with the PHP on PATH. Each case is a difference from the Rust host a
 * deployed app could see, or a way this host mangled an answer:
 *
 * - the handler's JSON came back re-encoded by PHP: `{}` became `[]`, and a
 *   lone UTF-16 surrogate or a NUL-led key turned a committed write into a
 *   503 "please retry";
 * - the query was PHP's $_GET (`a.b` renamed `a_b`, `a[]` an array);
 * - only two headers reached the handler, where the Rust host forwards all
 *   but Cookie and Proxy-Authorization;
 * - a route's maxBodySize ignored the app-wide config.server.maxBodySize;
 * - a same-origin page was refused unless its own origin was listed;
 * - `If-None-Match` compared byte for byte, so a tag Apache's mod_deflate
 *   suffixed with -gzip never matched;
 * - every IPv6 address had its own rate-limit bucket;
 * - a body with a number out of range (`1e999`) was answered 503 "please
 *   retry" after a runner had been started for it, where it is a 400;
 * - a client past its rate limit was refused by a runner started for the
 *   purpose, at the cost of a request that was served;
 * - nothing that failed was written anywhere an operator could read it;
 * - setup.php on an archive with no app died with a TypeError;
 * - a body was decoded and written again on its way to the runner, so a
 *   2 MiB body of numbers was 7.5 MB when it got there and the client was
 *   told 503 "please retry", outside the rate limit;
 * - api.php printed the server's paths where open_basedir kept it out of the
 *   backend, and an operator whose backend sat inside the document root was
 *   told to run setup there before being told to move it;
 * - a private/ made by another account was "run setup first", and slot
 *   files nobody could open were "the server is busy", both for ever;
 * - setup.php that could not write its folder, read its manifest or find its
 *   Node said so with a TypeError, a JsonException or a chmod() warning;
 * - a request that found every worker slot held was told 503 in the same
 *   instant, so the fifth call of a page that made five was refused though
 *   a slot would be free a fifth of a second later.
 *
 * Skipped, with the reason, when PHP is not on PATH.
 */
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync,spawn} from 'node:child_process';
import {readFileSync,mkdtempSync,mkdirSync,copyFileSync,writeFileSync,rmSync,existsSync,realpathSync,chmodSync,symlinkSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const runtime=fileURLToPath(new URL('../runtime/',import.meta.url));
const skip=spawnSync('php',['-v']).status===0?false:'php is not on PATH (install PHP 8.1+ to run this test)';
if(skip)console.warn('WARNING: tests/request.test.mjs skipped: '+skip);
const test=(name,...rest)=>{const fn=rest.pop();return nodeTest(name,{...(rest[0]??{}),skip},fn);};

/** Calls each [function, ...args] in PHP and returns the results. */
function php(calls) {
  const script=`require ${JSON.stringify(runtime+'client-ip.php')};require ${JSON.stringify(runtime+'request.php')};$out=[];foreach(json_decode(stream_get_contents(STDIN),false) as $c){$f=array_shift($c);$c=array_map(fn($a)=>is_object($a)?(array)$a:$a,$c);$out[]=$f(...$c);}echo json_encode($out,JSON_PRESERVE_ZERO_FRACTION|JSON_UNESCAPED_SLASHES|JSON_INVALID_UTF8_SUBSTITUTE);`;
  const r=spawnSync('php',['-d','display_errors=stderr','-r',script],{input:JSON.stringify(calls),encoding:'utf8',maxBuffer:64*1024*1024});
  assert.equal(r.status,0,r.stderr);
  assert.equal(r.stderr,'',r.stderr);
  return JSON.parse(r.stdout);
}

test('the handler\'s JSON reaches the client exactly as the runner wrote it',()=>{
  const bodies=['{}','{"empty":{},"list":[],"nested":{"a":{}}}','{"s":"x\\ud83d"}','{"\\u0000key":1,"":2}','{"f":1.0,"big":12345678901234567890}','"text"','null'];
  const got=php(bodies.map(b=>['softn_runner_result',`{"status":200,"body":${b}}`]));
  bodies.forEach((b,i)=>assert.deepEqual(got[i],{status:200,body:b},b));
  const [created,busy]=php([['softn_runner_result','{"status":201,"body":{"id":1}}'],['softn_runner_result','{"status":503,"body":{"code":"database_busy"}}']]);
  assert.deepEqual(created,{status:201,body:'{"id":1}'});assert.equal(busy.status,503);
  // Anything else is not the runner's answer, and the host says so.
  const bad=php(['','{"body":{},"status":200}','{"status":200}','{"status":99,"body":{}}','{"status":200,"body":}','{"status":200,"body":{}}x'].map(o=>['softn_runner_result',o]));
  bad.forEach(r=>assert.equal(r,null));
});

test('the query string is a map of decoded strings, as the Rust host gives it',()=>{
  const [q,empty,many]=php([
    ['softn_query','a%5B%5D=1&b.c=2&d=x&d=y&e&sp=a+b%20c&&=v&u=%ff'],
    ['softn_query',''],
    ['softn_query',Array.from({length:300},(_,i)=>'k'+i+'=1').join('&')],
  ]);
  assert.deepEqual(q,{'a[]':'1','b.c':'2',d:'y',e:'',sp:'a b c','':'v',u:'\ufffd'});
  // In the order the names first appear, which the Rust host keeps too.
  assert.deepEqual(Object.keys(q),['a[]','b.c','d','e','sp','','u']);
  assert.deepEqual(empty,[]);
  assert.equal(Object.keys(many).length,256);
});

test('every request header but Cookie and Proxy-Authorization reaches the handler',()=>{
  const [h,none,redirected]=php([
    ['softn_request_headers',{HTTP_USER_AGENT:'probe',HTTP_ACCEPT_LANGUAGE:'en',HTTP_COOKIE:'session=1',HTTP_PROXY_AUTHORIZATION:'Basic x',HTTP_AUTHORIZATION:'Bearer t',HTTP_X_REQUEST_ID:'r1',CONTENT_TYPE:'application/json',CONTENT_LENGTH:'2',REMOTE_ADDR:'1.2.3.4',DOCUMENT_ROOT:'/srv'}],
    ['softn_request_headers',{}],
    ['softn_request_headers',{REDIRECT_REDIRECT_HTTP_AUTHORIZATION:'Bearer deep'}],
  ]);
  assert.deepEqual(h,{'user-agent':'probe','accept-language':'en','x-request-id':'r1','content-type':'application/json','content-length':'2',authorization:'Bearer t','idempotency-key':''});
  assert.deepEqual(none,{authorization:'','idempotency-key':''});
  assert.equal(redirected.authorization,'Bearer deep');
});

test('a route\'s body limit is also bounded by the app-wide limit',()=>{
  const got=php([
    ['softn_body_limit',null,null,false],['softn_body_limit',null,null,true],
    ['softn_body_limit',1_000_000,null,false],['softn_body_limit',null,100_000,false],
    ['softn_body_limit',1_000_000,100_000,false],['softn_body_limit',50_000,100_000,false],
    ['softn_body_limit',16_000_000,null,false],['softn_body_limit',16_000_000,null,true],
    ['softn_body_limit',-1,null,false],['softn_body_limit','lots',null,false],['softn_body_limit','4096',null,false],
  ]);
  assert.deepEqual(got,[262144,5600100,1_000_000,100_000,100_000,50_000,2097152,5600100,null,null,4096]);
});

test('a page on this site may call its API without listing its own origin; other sites must be listed',()=>{
  const server={HTTP_HOST:'app.example',HTTPS:'on'};
  const [own,plain,proxied,unproxied,badHost]=php([
    ['softn_own_origin',server,false],
    ['softn_own_origin',{HTTP_HOST:'App.Example:8080'},false],
    ['softn_own_origin',{HTTP_HOST:'app.example',HTTP_X_FORWARDED_PROTO:'https'},true],
    ['softn_own_origin',{HTTP_HOST:'app.example',HTTP_X_FORWARDED_PROTO:'https'},false],
    ['softn_own_origin',{HTTP_HOST:'evil.example/x'},false],
  ]);
  assert.equal(own,'https://app.example');assert.equal(plain,'http://app.example:8080');
  assert.equal(proxied,'https://app.example');assert.equal(unproxied,'http://app.example');assert.equal(badHost,null);
  const allowed=php([
    ['softn_origin_allowed',null,[],own],
    ['softn_origin_allowed','https://app.example',[],own],
    ['softn_origin_allowed','http://app.example',[],own],
    ['softn_origin_allowed','https://evil.example',[],own],
    ['softn_origin_allowed','https://partner.example',['https://partner.example'],own],
    ['softn_origin_allowed','null',['https://partner.example'],own],
    ['softn_origin_allowed','https://app.example',[],null],
  ]);
  assert.deepEqual(allowed,[true,true,false,false,true,false,false]);
});

test('a conditional poll matches weak, listed and compression-suffixed entity tags',()=>{
  const tag='"abc"';
  const got=php(['"abc"','W/"abc"','"x", "abc"','"abc-gzip"','W/"abc-br"','*','"abcd"','','"ab"'].map(v=>['softn_etag_matches',v,tag]));
  assert.deepEqual(got,[true,true,true,true,true,true,false,false,false]);
});

test('an IPv6 client shares a rate-limit bucket with its /64',()=>{
  const got=php([['softn_rate_key','2001:db8:1:2:aaaa::1'],['softn_rate_key','2001:db8:1:2:ffff::9'],['softn_rate_key','2001:db8:1:3::1'],['softn_rate_key','203.0.113.9'],['softn_rate_key','0.0.0.0']]);
  assert.equal(got[0],'2001:db8:1:2::/64');assert.equal(got[1],got[0]);assert.notEqual(got[2],got[0]);
  assert.equal(got[3],'203.0.113.9');assert.equal(got[4],'0.0.0.0');
});

test('a preflight approves the header names asked for, and nothing that is not one',()=>{
  const got=php([['softn_preflight_headers','x-custom, content-type'],['softn_preflight_headers',null],['softn_preflight_headers','x\r\nSet-Cookie: a=b']]);
  assert.equal(got[0],'x-custom, content-type');
  assert.match(got[1],/Authorization/);assert.match(got[2],/^Content-Type, Authorization/);
});

/**
 * api.php → http.php for one request, through php-cgi (the SAPI Apache uses
 * here), with a manifest allowing https://app.example. The runner is never
 * reached: OPTIONS and Origin refusals are answered before it.
 */
const cgiSkip=skip||(spawnSync('php-cgi',['-v']).status===0?false:'php-cgi is not on PATH (it ships with PHP; Debian/Ubuntu: php-cgi)');
if(cgiSkip&&!skip)console.warn('WARNING: tests/request.test.mjs OPTIONS test skipped: '+cgiSkip);
/** webroot/api.php beside backend/ with http.php and a manifest of `routes`: what one request needs before a runner. */
function deployment(t,{routes=[],prepare=()=>{}}={}) {
  const root=mkdtempSync(join(tmpdir(),'softn-cgi-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'webroot'));mkdirSync(join(root,'backend/app'),{recursive:true});
  copyFileSync(new URL('../api.php',import.meta.url),join(root,'webroot/api.php'));
  for(const name of ['http.php','request.php','client-ip.php'])copyFileSync(runtime+name,join(root,'backend',name));
  writeFileSync(join(root,'backend/app/manifest.json'),JSON.stringify({id:'cgi',config:{server:{allowedOrigins:['https://app.example']}},server:{routes}}));
  prepare(join(root,'backend'));
  return root;
}
/** What the web server tells php-cgi of a request, and php-cgi's answer taken apart. */
const told=(root,method,origin,{remote='127.0.0.1',uri='/api/ping',server=()=>({})}={})=>({...process.env,REQUEST_METHOD:method,REQUEST_URI:uri,SCRIPT_FILENAME:join(root,'webroot/api.php'),REDIRECT_STATUS:'200',
  HTTP_HOST:'site.example',REMOTE_ADDR:remote,GATEWAY_INTERFACE:'CGI/1.1',SERVER_PROTOCOL:'HTTP/1.1',...(origin?{HTTP_ORIGIN:origin}:{}),...server(root)});
function answered(stdout,root) {
  const [head,body]=stdout.split(/\r?\n\r?\n/,2),headers={};
  for(const line of head.split(/\r?\n/)){const i=line.indexOf(':');headers[line.slice(0,i).toLowerCase()]=line.slice(i+1).trim();}
  return {status:Number((headers.status??'200').split(' ')[0]),headers,body,root};
}
function cgi(method,origin,t,{routes=[],prepare=()=>{},remote='127.0.0.1',uri='/api/ping',php=[],server=()=>({}),root=deployment(t,{routes,prepare})}={}) {
  // `php`: settings for this php-cgi, as a host's php.ini would make them.
  // `server`: more of what the web server tells PHP (DOCUMENT_ROOT, say), given the deployment's root.
  // `root`: a deployment made earlier, for a second request to the same one.
  const r=spawnSync('php-cgi',typeof php==='function'?php(root):php,{env:told(root,method,origin,{remote,uri,server}),encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
  return answered(r.stdout,root);
}
/** The same request without waiting for it here: its answer when it comes, and how long it took. */
function cgiStarted(root,method,options={}) {
  const began=performance.now();
  return new Promise((resolve,reject)=>{
    const child=spawn('php-cgi',[],{env:told(root,method,null,options),stdio:['ignore','pipe','ignore']});
    let out='';child.stdout.on('data',chunk=>out+=chunk);
    child.on('error',reject);
    child.on('close',()=>resolve({...answered(out,root),ms:performance.now()-began}));
  });
}

nodeTest('OPTIONS is always a 204, as on the Rust host, and only an allowed Origin is given Access-Control-Allow-Origin',{skip:cgiSkip},t=>{
  // No Origin: not a CORS preflight (browsers always send one), so not refused either; it was a 403 "Origin required".
  const bare=cgi('OPTIONS',null,t);
  assert.equal(bare.status,204,JSON.stringify(bare));
  assert.equal(bare.headers['access-control-allow-origin'],undefined);
  assert.match(bare.headers.allow,/POST/);
  const allowed=cgi('OPTIONS','https://app.example',t);
  assert.equal(allowed.status,204);
  assert.equal(allowed.headers['access-control-allow-origin'],'https://app.example');
  assert.match(allowed.headers['access-control-allow-methods'],/DELETE/);
  // A foreign page's preflight gets no Allow-Origin, so its browser stops there; the Rust host's CORS layer answers it the same way.
  const foreign=cgi('OPTIONS','https://evil.example',t);
  assert.equal(foreign.status,204);
  assert.equal(foreign.headers['access-control-allow-origin'],undefined);
  assert.equal(foreign.headers.vary,'Origin');
  // Any other method from a foreign page is still refused before the runner.
  const post=cgi('POST','https://evil.example',t);
  assert.equal(post.status,403);
  assert.equal(JSON.parse(post.body).code,'origin_not_allowed');
});

nodeTest('a method a path does not declare is 405, a path nobody declared is 404, and HEAD is its GET, as on the Rust host',{skip:cgiSkip},t=>{
  const routes=[{method:'GET',path:'/api/ping',handler:'ping'},{method:'POST',path:'/api/save',handler:'save'},{method:'PUT',path:'/api/save',handler:'save'}];
  const ask=(method,uri)=>cgi(method,null,t,{routes,uri});
  // A path that is declared, asked with a method it is not declared for. It
  // was 404 "Endpoint not found", as though the path were not there.
  const wrong=ask('POST','/api/ping');
  assert.equal(wrong.status,405,JSON.stringify(wrong));
  assert.deepEqual(JSON.parse(wrong.body),{error:'Method not allowed.',code:'method_not_allowed'});
  assert.equal(wrong.headers.allow,'GET, HEAD');
  assert.equal(ask('DELETE','/api/save').headers.allow,'POST, PUT');
  assert.equal(ask('PATCH','/api/ping').status,405);
  // The host's own /api/meta is a GET.
  assert.equal(ask('POST','/api/meta').status,405);
  // A path nobody declared is not found, whatever the method: PATCH there was 405.
  for(const method of ['GET','POST','PATCH','HEAD'])assert.equal(ask(method,'/api/nothing').status,404,method);
  // With the Rust host's code (http.rs not_found); it had none here.
  assert.deepEqual(JSON.parse(ask('GET','/api/nothing').body),{error:'Endpoint not found.',code:'not_found'});
  assert.deepEqual(JSON.parse(ask('GET','/elsewhere').body),{error:'Not found.',code:'not_found'});
  // HEAD on a GET route goes where its GET goes (to the runner, of which
  // there is none here) and was 405; on a path with no GET it still is.
  const get=ask('GET','/api/ping'),head=ask('HEAD','/api/ping');
  assert.equal(get.status,503,JSON.stringify(get));
  assert.equal(JSON.parse(get.body).diagnostic,'setup_required');
  assert.equal(head.status,503,JSON.stringify(head));
  assert.equal(ask('HEAD','/api/save').status,405);
});

test('http.php hands the runner a HEAD as the GET it is, and leaves the body off the answer',()=>{
  // The runner (and so the handler) is asked what it is asked for the GET.
  const http=readFileSync(new URL('../runtime/http.php',import.meta.url),'utf8');
  assert.match(http,/\$head=\$method==='HEAD';if\(\$head\)\$method='GET';/);
  assert.ok(http.indexOf("$head=$method==='HEAD'")<http.indexOf("'method'=>$method"));
  assert.match(http,/if\(!\$head\)echo \$responseBody;/);
});

test('a body is a JSON object the runner can be handed, or it is refused',()=>{
  const good=['','{}','{"a":1,"nested":{"list":[1,2,{"deep":true}]}}','{"n":1.5e308,"big":12345678901234567890,"s":"x\\ud83d\\ude00"}'];
  const bad=['{"n":1e999}','{"a":[1,{"b":-1e999}]}','[1,2]','"text"','7','null','{"a":','not json','{"a":1}x','['.repeat(70)+']'.repeat(70)];
  const got=php([...good,...bad].map(raw=>['softn_request_body',raw]));
  good.forEach((raw,i)=>assert.notEqual(got[i],null,raw));
  assert.deepEqual(got[0],{});
  assert.deepEqual(got[2],{a:1,nested:{list:[1,2,{deep:true}]}});
  bad.forEach((raw,i)=>assert.equal(got[good.length+i],null,raw.slice(0,40)));
  // 62 levels deep, the body itself the first, and no deeper: the engine
  // hands a handler nothing below that. A 63rd level was accepted here and
  // reached the handler as null (the runner's half is in
  // route-declarations.test.mjs); the Rust host has the same limit.
  const nested=(levels,leaf)=>'{"a":'.repeat(levels)+leaf+'}'.repeat(levels);
  const depths=php([[62,'"leaf"'],[61,'{}'],[61,'[[]]'],[63,'1'],[62,'{}'],[62,'[1]'],[64,'1']].map(([levels,leaf])=>['softn_request_body',nested(levels,leaf)]));
  assert.deepEqual(depths.map(body=>body!==null),[true,true,false,false,false,false,false]);
  // http.php decides with it, before any runner is started.
  const http=readFileSync(new URL('../runtime/http.php',import.meta.url),'utf8');
  assert.match(http,/\$body=softn_request_body\(\$raw\);/);
  assert.ok(http.indexOf('softn_request_body($raw)')<http.indexOf('proc_open('));
});

nodeTest('a bucket the runner refused this minute is answered 429 before the body, a slot or a runner',{skip:cgiSkip},t=>{
  const routes=[{method:'GET',path:'/api/ping',handler:'ping'}];
  // The note the runner leaves (request-worker.mjs markLimited), for this
  // minute and the next, in case the clock turns while the test runs.
  const note=remote=>backend=>{
    const [key]=php([['softn_rate_key',remote]]);
    const minute=Math.floor(Date.now()/60000),bucket=createHash('sha256').update(key).digest('hex');
    for(const m of [minute,minute+1]){mkdirSync(join(backend,'private/limited',String(m)),{recursive:true});writeFileSync(join(backend,'private/limited',String(m),bucket),'');}
  };
  const limited=cgi('GET',null,t,{routes,prepare:note('127.0.0.1')});
  assert.equal(limited.status,429,JSON.stringify(limited));
  assert.deepEqual(JSON.parse(limited.body),{error:'Too many requests.',code:'rate_limited'});
  const wait=Number(limited.headers['retry-after']);
  assert.ok(Number.isInteger(wait)&&wait>=1&&wait<=60,'Retry-After says when the minute turns: '+limited.headers['retry-after']);
  // Another address is not that bucket, and with no note nobody is: the
  // request goes on to where a runner would be started (there is none here).
  for(const other of [cgi('GET',null,t,{routes,prepare:note('127.0.0.1'),remote:'203.0.113.7'}),cgi('GET',null,t,{routes})]) {
    assert.equal(other.status,503,JSON.stringify(other));
    assert.equal(JSON.parse(other.body).diagnostic,'setup_required');
    assert.equal(other.headers['retry-after'],undefined);
  }
  // An IPv6 client is refused by its /64, the bucket the runner counts.
  const v6=cgi('GET',null,t,{routes,prepare:note('2001:db8:1:2::9'),remote:'2001:db8:1:2:aaaa:bbbb:cccc:dddd'});
  assert.equal(v6.status,429,JSON.stringify(v6));
});

test('http.php hands a photo it refuses to the runner to be counted, and does not answer it itself',()=>{
  // It answered 400 on the spot, holding a worker slot and with the image
  // already decoded, and no runner ever counted the request: refused uploads
  // were outside the rate limit altogether. (The runner's half is in
  // route-declarations.test.mjs.)
  const http=readFileSync(new URL('../runtime/http.php',import.meta.url),'utf8');
  const sanitize=http.indexOf('sanitize_photo('),spawn=http.indexOf('proc_open(');
  assert.ok(sanitize>0&&sanitize<spawn);
  const between=http.slice(sanitize,spawn);
  assert.match(between,/catch\(Throwable \$e\)\{\$request\['refused'\]='photo';\}/);
  assert.doesNotMatch(between,/reply\(400/,'the refusal is the runner\'s to answer, after it has counted it');
  // The image itself is not sent on, taken or refused: the body the runner is handed is `{}`.
  assert.match(between,/\$bodyJson='\{\}';/);
});

test('the marker is where the runner writes it, and Retry-After counts down the minute',()=>{
  const [marker,atStart,atEnd]=php([['softn_rate_marker','/srv/backend','203.0.113.9',125],['softn_retry_after',120],['softn_retry_after',179]]);
  assert.equal(marker,'/srv/backend/private/limited/2/'+createHash('sha256').update('203.0.113.9').digest('hex'));
  assert.equal(atStart,60);
  assert.equal(atEnd,1);
});

test('what the runner said becomes a few bounded lines for the error log',()=>{
  const [lines,none,many]=php([
    ['softn_log_lines','softn: handler save: no such table: notes\r\n\n  bell\u0007and\ttab\n'+'x'.repeat(900)+'\n'],
    ['softn_log_lines',' \n\n'],
    ['softn_log_lines',Array.from({length:30},(_,i)=>'line '+i).join('\n')],
  ]);
  assert.deepEqual(lines,['softn: handler save: no such table: notes','bell and tab','x'.repeat(400)]);
  assert.deepEqual(none,[]);
  assert.equal(many.length,8);
  // http.php hands them to error_log, and says which step failed without saying more.
  const http=readFileSync(new URL('../runtime/http.php',import.meta.url),'utf8');
  assert.match(http,/foreach\(softn_log_lines\(\$errors\) as \$line\)error_log\(/);
  assert.match(http,/'diagnostic'=>\$reason/);
});

test('setup.php says there is no app to set up, and prepares one that is there',t=>{
  const root=mkdtempSync(join(tmpdir(),'softn-setup-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  // request.php with it: setup starts the runner by the rule a request does.
  for(const name of ['setup.php','request.php'])copyFileSync(runtime+name,join(root,name));
  const setup=()=>spawnSync('php',['-d','display_errors=stderr',join(root,'setup.php')],{encoding:'utf8'});
  // The archive before an app is installed in it: this was a TypeError and a stack of paths.
  const empty=setup();
  assert.equal(empty.status,1);
  assert.match(empty.stderr,/^No application is installed at app\/ yet/);
  assert.doesNotMatch(empty.stdout+empty.stderr,/TypeError|Fatal|Warning/);
  assert.equal(existsSync(join(root,'private/config.json')),false);
  // With an app: the operator's configuration is written from its manifest.
  mkdirSync(join(root,'app'));mkdirSync(join(root,'bin'));writeFileSync(join(root,'bin/node'),'');
  writeFileSync(join(root,'app/manifest.json'),JSON.stringify({id:'com.example.setup',server:{requires:{apiVersion:1,capabilities:['sql','time']}}}));
  const ready=setup();
  const config=JSON.parse(readFileSync(join(root,'private/config.json'),'utf8'));
  assert.equal(config.appId,'com.example.setup');
  assert.deepEqual(config.capabilities,['sql','time']);
  assert.equal(config.development,false);
  assert.match(config.keyHex,/^[a-f0-9]{64}$/);
  assert.deepEqual(config.cryptoDomains,{hmac:'com.example.setup:hmac:v1',seal:'com.example.setup:seal:v1'});
  assert.ok(existsSync(join(root,'private/data'))&&existsSync(join(root,'private/slot-3.lock')));
  // This bin/node is an empty file, so the check that starts it says so.
  assert.equal(ready.status,1);
  assert.match(ready.stderr,/WARNING: The bundled Node \(bin\/node\) does not run on this machine/);
  // What no check can see is said: how many of the web server's PHP workers
  // this app may hold at once, running and waiting for a slot
  // (request.php softn_slot_waiters), and what the operator has to see to:
  // under php-fpm nothing, since nobody waits there until they say how
  // many may (softn_pool_has_room); everywhere else, the size of the pool.
  assert.match(ready.stdout,/Up to 4 requests run at once, each holding one of the web server's PHP workers, and a request past them may wait for one, or not, by where PHP runs\. Under php-fpm none waits \(a request past the 4 is told at once that the server is busy\) until "slotWaiters" in private\/config\.json says how many may: a php-fpm pool is small as it comes \(Ubuntu's package ships pm\.max_children = 5\), which leaves none to wait with, so write a number only for a pm\.max_children larger than 4 plus that number\. Under any other PHP \(Apache's own, CGI, FastCGI\) 2 may wait: there the pool \(Apache's MaxRequestWorkers, a shared host's process limit\) must be larger than 6, and if it is not, set "slotWaiters": 0\./);
  // A second run keeps the key it made, and reads the operator's own number:
  // none to wait, or as many as they say their pool can hold, php-fpm's included.
  writeFileSync(join(root,'private/config.json'),JSON.stringify({...config,slotWaiters:0}));
  const again=setup();
  assert.equal(JSON.parse(readFileSync(join(root,'private/config.json'),'utf8')).keyHex,config.keyHex);
  assert.match(again.stdout,/Up to 4 requests run at once, each holding one of the web server's PHP workers; none waits for a slot \("slotWaiters": 0 in private\/config\.json\), so a request past them is told at once that the server is busy\./);
  writeFileSync(join(root,'private/config.json'),JSON.stringify({...config,slotWaiters:8}));
  assert.match(setup().stdout,/Up to 4 requests run at once and 8 more may wait for one of them \("slotWaiters" in private\/config\.json\), each holding one of the web server's PHP workers\. That number is taken at its word, under php-fpm too: the pool \(php-fpm's pm\.max_children, Apache's MaxRequestWorkers, a shared host's process limit\) must be larger than 12\./);
  // The operator's `workers` holds the manifest's number to it, and only lowers it.
  writeFileSync(join(root,'private/config.json'),JSON.stringify({...config,slotWaiters:0,workers:2}));
  assert.match(setup().stdout,/Up to 2 requests run at once, each holding/);
  writeFileSync(join(root,'private/config.json'),JSON.stringify({...config,slotWaiters:0,workers:12}));
  assert.match(setup().stdout,/Up to 4 requests run at once, each holding/);
});

test('the number of runners at once is the manifest\'s, held to the operator\'s workers, one to sixteen',()=>{
  const php=`require ${JSON.stringify(runtime+'request.php')};`
    +`foreach([[null,null],[['config'=>['server'=>['workers'=>16]]],null],[['config'=>['server'=>['workers'=>16]]],['workers'=>3]],`
    +`[['config'=>['server'=>['workers'=>2]]],['workers'=>8]],[['config'=>['server'=>['workers'=>99]]],['workers'=>'1']],[null,['workers'=>0]]] as [$m,$o])echo softn_workers($m,$o),',';`;
  const r=spawnSync('php',['-r',php],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
  // The default; the manifest's 16; held to 3; the manifest's lower 2; a
  // text "1" is no operator number; 0 is none either.
  assert.equal(r.stdout,'4,16,3,2,16,4,');
});

test('a photo the bundled GD could not decode within memory_limit is refused, not a fatal error',t=>{
  // A 16 megapixel PNG of one colour is about 70 KB and takes some 126 MB to
  // decode in the GD PHP bundles, which counts it against memory_limit: at
  // 128M (where http.php may not raise it) PHP died, the request uncounted.
  const php=`if(!extension_loaded('gd')){echo 'no gd';exit;}`
    +`if(!str_contains(strtolower(gd_info()['GD Version']),'bundled')){echo 'system gd';exit;}`
    +`require ${JSON.stringify(runtime+'photos.php')};`
    +`$i=imagecreatetruecolor(4000,4000);imagealphablending($i,false);imagesavealpha($i,true);imagefill($i,0,0,imagecolorallocatealpha($i,10,20,30,60));`
    +`ob_start();imagepng($i,null,9);$png=ob_get_clean();imagedestroy($i);unset($i);`
    +`ini_set('memory_limit','128M');`
    +`try{sanitize_photo('data:image/png;base64,'.base64_encode($png));echo 'decoded';}catch(RuntimeException $e){echo 'refused:'.$e->getMessage();}`;
  const r=spawnSync('php',['-d','memory_limit=512M','-r',php],{encoding:'utf8',timeout:60000});
  assert.equal(r.status,0,r.stdout+r.stderr);
  if(r.stdout==='no gd'||r.stdout==='system gd'){t.skip(`${r.stdout}: the check is for PHP's bundled GD`);return;}
  assert.equal(r.stdout,'refused:memory');
});

test('setup.php writes no config.json it cannot encode, and says why',t=>{
  const root=mkdtempSync(join(tmpdir(),'softn-setup-inf-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  for(const name of ['setup.php','request.php'])copyFileSync(runtime+name,join(root,name));
  mkdirSync(join(root,'app'),{recursive:true});
  // A number past the doubles: PHP reads it as INF, which JSON cannot hold.
  writeFileSync(join(root,'app/manifest.json'),'{"id":"com.example.inf","server":{"requires":{"capabilities":1e999}}}');
  const r=spawnSync('php',[join(root,'setup.php')],{encoding:'utf8',timeout:60000});
  assert.equal(r.status,1,r.stdout+r.stderr);
  assert.match(r.stderr,/app\/manifest\.json holds a value private\/config\.json cannot be written from/);
  assert.ok(!existsSync(join(root,'private/config.json')),'a config.json was written anyway');
});

test('http.php passes the runner\'s body through and never re-encodes it',()=>{
  const http=readFileSync(new URL('../runtime/http.php',import.meta.url),'utf8');
  assert.match(http,/softn_runner_result\(\$output\)/);
  assert.doesNotMatch(http,/json_decode\(\$output/);
  assert.match(http,/'query'=>\(object\)softn_query\(/);
  assert.doesNotMatch(http,/\$_GET/);
  // Text goes to the runner as itself: \uXXXX tripled a query or a header of two-byte characters.
  assert.match(http,/\$input=softn_runner_input\(\$request,\$bodyJson\);/);
  const [input]=php([['softn_runner_input',{query:{q:'café/☃'}},'{}']]);
  assert.equal(input,'{"query":{"q":"café/☃"}}');
});

test('api.php refuses an old PHP or a wrong backend path with JSON, not a parse error',()=>{
  const api=readFileSync(new URL('../api.php',import.meta.url),'utf8');
  assert.match(api,/PHP_VERSION_ID < 80100/);
  const r=spawnSync('php',['-d','display_errors=1',fileURLToPath(new URL('../api.php',import.meta.url))],{encoding:'utf8'});
  // Run from the checkout there is no sibling backend/ directory.
  assert.equal(JSON.parse(r.stdout).diagnostic,'backend_path');
});

nodeTest('api.php prints no path where open_basedir keeps PHP out of the backend, and says that is why',{skip:cgiSkip},t=>{
  // A host that shows errors and confines PHP to the site's own folder
  // (Plesk's default open_basedir). is_file() on the backend was then a
  // warning naming the backend's path and every allowed one, printed above
  // the JSON: the very thing the check is there to prevent. The answer
  // also said "not found, set $backend", for a backend that was where
  // $backend said and that PHP was not allowed to look at.
  const r=cgi('GET',null,t,{php:root=>['-d','display_errors=1','-d','html_errors=0','-d','open_basedir='+join(root,'webroot')]});
  assert.equal(r.status,503,JSON.stringify(r));
  assert.deepEqual(JSON.parse(r.body),{error:'PHP on this site may not read the private backend directory: add it to open_basedir.',code:'backend_unavailable',diagnostic:'open_basedir'});
  assert.doesNotMatch(r.body,/Warning|restriction in effect/);
  assert.ok(!r.body.includes('webroot')&&!r.body.includes(r.root),'no path of this server is in the answer');
});

nodeTest('a backend inside the document root is refused before anything is said about setup',{skip:cgiSkip},t=>{
  const routes=[{method:'GET',path:'/api/ping',handler:'ping'}];
  // The whole archive unpacked into the site: backend/ and webroot/ both
  // under the document root. "Run the private backend setup first" was the
  // answer, and setup makes the key and the database: in a public
  // directory, to be told only then that it had to move.
  const inside=cgi('GET',null,t,{routes,server:root=>({DOCUMENT_ROOT:root})});
  assert.equal(inside.status,503,JSON.stringify(inside));
  assert.equal(JSON.parse(inside.body).diagnostic,'backend_public');
  // Beside the document root, as the archive lays it out: now it is setup's turn.
  const beside=cgi('GET',null,t,{routes,server:root=>({DOCUMENT_ROOT:join(root,'webroot')})});
  assert.equal(JSON.parse(beside.body).diagnostic,'setup_required',JSON.stringify(beside));
});

test('the backend is public inside the document root or beside api.php, whatever the server calls its root',t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'softn-public-')));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  for(const dir of ['webroot/backend','backend','webroot-backend','elsewhere'])mkdirSync(join(root,dir),{recursive:true});
  const at=p=>join(root,p);
  const got=php([
    // As the archive lays it out.
    ['softn_backend_is_public',at('backend'),{DOCUMENT_ROOT:at('webroot'),SCRIPT_FILENAME:at('webroot/api.php')}],
    ['softn_backend_is_public',at('webroot/backend'),{DOCUMENT_ROOT:at('webroot')}],
    ['softn_backend_is_public',at('webroot'),{DOCUMENT_ROOT:at('webroot')}],
    // A sibling whose name only begins like the root's is not inside it.
    ['softn_backend_is_public',at('webroot-backend'),{DOCUMENT_ROOT:at('webroot')}],
    // A site mounted with Alias or as a user directory: DOCUMENT_ROOT is the
    // main site's, and the backend beside api.php is as public as api.php.
    // Only DOCUMENT_ROOT was looked at, so this one passed.
    ['softn_backend_is_public',at('webroot/backend'),{DOCUMENT_ROOT:at('elsewhere'),SCRIPT_FILENAME:at('webroot/api.php')}],
    ['softn_backend_is_public',at('webroot/backend'),{DOCUMENT_ROOT:at('elsewhere'),CONTEXT_DOCUMENT_ROOT:at('webroot')}],
    // A server that passes no DOCUMENT_ROOT. The fallback was http.php's own
    // directory, which is the backend: it was compared with itself and
    // every request refused as public.
    ['softn_backend_is_public',at('backend'),{SCRIPT_FILENAME:at('webroot/api.php')}],
    ['softn_backend_is_public',at('backend'),{}],
    ['softn_backend_is_public',at('backend'),{DOCUMENT_ROOT:at('no-such-directory')}],
  ]);
  assert.deepEqual(got,[false,true,true,false,true,true,false,false,false]);
  // http.php asks before it says anything about setup.
  const http=readFileSync(new URL('../runtime/http.php',import.meta.url),'utf8');
  assert.match(http,/softn_backend_is_public\(\$backend,\$_SERVER\)/);
  assert.ok(http.indexOf("'diagnostic'=>'backend_public'")<http.indexOf("'diagnostic'=>'setup_required'"));
});

nodeTest('a host with proc_close disabled is told so before a runner is started for it',{skip:cgiSkip},t=>{
  // proc_open, proc_get_status and proc_terminate were checked and this one
  // was not: with it alone disabled the request ran, and PHP died in the
  // clean-up with the answer unsent.
  const routes=[{method:'GET',path:'/api/ping',handler:'ping'}];
  for(const name of ['proc_close','proc_open']) {
    const r=cgi('GET',null,t,{routes,php:['-d','disable_functions='+name]});
    assert.equal(r.status,503,JSON.stringify(r));
    assert.equal(JSON.parse(r.body).diagnostic,'php_process_functions',name);
  }
  const setup=readFileSync(new URL('../runtime/setup.php',import.meta.url),'utf8');
  assert.match(setup,/foreach\(\['proc_open','proc_get_status','proc_terminate','proc_close'\] as \$name\)/);
});

const gdSkip=cgiSkip||(spawnSync('php-cgi',['-n','-m'],{encoding:'utf8'}).stdout.split(/\r?\n/).includes('gd')?'GD is built into this php-cgi, so it cannot be started without it':false);
nodeTest('a photo route on a PHP without GD says which extension is missing, and which package has it',{skip:gdSkip},t=>{
  // A stock Debian or Ubuntu PHP has no GD. The answer was
  // {"error":"Enable PHP GD for photo uploads."}: no code, unlike every
  // other refusal of this host, and no word of where GD comes from.
  const routes=[{method:'POST',path:'/api/photo',handler:'save',upload:'photo'}];
  // Set up as far as http.php looks before it turns to the upload (it
  // never starts the bin/node it finds). -n: no php.ini, so no extension
  // that is not built in.
  const r=cgi('POST',null,t,{routes,uri:'/api/photo',prepare:readyForSlots,php:['-n'],server:root=>({DOCUMENT_ROOT:join(root,'webroot')})});
  assert.equal(r.status,503,JSON.stringify(r));
  assert.deepEqual(JSON.parse(r.body),{error:'Enable the PHP GD extension for photo uploads (Debian/Ubuntu: the php-gd package).',code:'backend_unavailable',diagnostic:'php_gd'});
});

const posixSkip=cgiSkip||(process.platform==='win32'?'needs POSIX file modes (run it on Linux)':typeof process.getuid==='function'&&process.getuid()===0?'root reads any directory':false);
if(posixSkip&&!cgiSkip)console.warn('WARNING: tests/request.test.mjs private/ ownership test skipped: '+posixSkip);
nodeTest('a private/ this account cannot look into is said to be another account\'s, not "run setup first"',{skip:posixSkip},t=>{
  // Setup run as root, say: private/ is 0700 and root's, and the web
  // server's PHP finds no config.json in it however often setup is run.
  const routes=[{method:'GET',path:'/api/ping',handler:'ping'}];
  let locked,closed;
  // Opened again whatever happens, or the temporary directory could not be removed.
  try{closed=cgi('GET',null,t,{routes,prepare:backend=>{locked=join(backend,'private');mkdirSync(locked);writeFileSync(join(locked,'config.json'),'{}');chmodSync(locked,0o000);}});}
  finally{if(locked)chmodSync(locked,0o700);}
  assert.equal(closed.status,503,JSON.stringify(closed));
  assert.equal(JSON.parse(closed.body).diagnostic,'private_permissions');
  assert.match(JSON.parse(closed.body).error,/belongs to another account/);
});

test('a worker slot is the first nobody holds; slots nobody can open are not "the server is busy"',t=>{
  const root=mkdtempSync(join(tmpdir(),'softn-slots-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  // private/ this account may not write in: stood in for by directories
  // where the slot files would be, which cannot be opened either.
  for(const name of ['blocked/slot-0.lock','blocked/slot-1.lock','free'])mkdirSync(join(root,name),{recursive:true});
  const script=`require ${JSON.stringify(runtime+'request.php')};$d=$argv[1];
    $shape=fn($s)=>['held'=>is_resource($s['slot']),'usable'=>$s['usable']];
    $out=[$shape(softn_worker_slot("$d/blocked",2))];
    $first=softn_worker_slot("$d/free",2);$second=softn_worker_slot("$d/free",2);$third=softn_worker_slot("$d/free",2);
    array_push($out,$shape($first),$shape($second),$shape($third));
    // The first request ends, and its slot is there for the next.
    fclose($first['slot']);$out[]=$shape(softn_worker_slot("$d/free",2));
    echo json_encode($out);`;
  const r=spawnSync('php',['-d','display_errors=stderr','-r',script,root],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);assert.equal(r.stderr,'');
  const [blocked,first,second,third,again]=JSON.parse(r.stdout);
  // Nothing could be opened: nobody is holding them, and waiting will not help.
  assert.deepEqual(blocked,{held:false,usable:false});
  // Two workers, two slots, and a third request finds them both held: that is busy.
  assert.deepEqual([first,second],[{held:true,usable:true},{held:true,usable:true}]);
  assert.deepEqual(third,{held:false,usable:true});
  assert.deepEqual(again,{held:true,usable:true});
  assert.ok(existsSync(join(root,'free/slot-0.lock'))&&existsSync(join(root,'free/slot-1.lock')),'a slot file setup did not make is made');
  // http.php answers the first as a fault of the installation and the second as busy.
  const http=readFileSync(new URL('../runtime/http.php',import.meta.url),'utf8');
  assert.match(http,/if\(!\$slot&&!\$slotsUsable\)reply\(503,\[[^\]]*'diagnostic'=>'private_permissions'\]\);/);
  assert.match(http,/if\(!\$slot\)reply\(503,\[[^\]]*'code'=>'database_busy'\]\);/);
});

/**
 * Other requests' hold on the worker slots: a PHP process that locks the
 * first `count` slot files of `dir` and keeps them for `ms`. Resolves once
 * they are locked.
 */
function holding(t,dir,count,ms) {
  const script=`$held=[];for($i=0;$i<(int)$argv[2];$i++){$f=fopen($argv[1].'/slot-'.$i.'.lock','c');flock($f,LOCK_EX);$held[]=$f;}echo "held\\n";usleep((int)$argv[3]*1000);`;
  const child=spawn('php',['-r',script,dir,String(count),String(ms)],{stdio:['ignore','pipe','inherit']});
  t.after(()=>child.kill());
  return new Promise((resolve,reject)=>{
    child.stdout.once('data',()=>resolve(child));
    child.once('error',reject);
    child.once('exit',code=>reject(new Error('the slots were let go before they were held: exit '+code)));
  });
}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

/** softn_worker_slot in a PHP of its own, as a request would call it: its answer, here or when it comes. */
const wantScript=`require ${JSON.stringify(runtime+'request.php')};$r=softn_worker_slot($argv[1],(int)$argv[2],(int)$argv[3],(int)$argv[4]);echo json_encode(['held'=>is_resource($r['slot']),'usable'=>$r['usable'],'waited'=>$r['waited']??null]);`;
function wanting(dir,workers,wait,room) {
  const r=spawnSync('php',['-d','display_errors=stderr','-r',wantScript,dir,String(workers),String(wait),String(room)],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);assert.equal(r.stderr,'');
  return JSON.parse(r.stdout);
}
function wantingMeanwhile(dir,workers,wait,room) {
  return new Promise((resolve,reject)=>{
    const child=spawn('php',['-r',wantScript,dir,String(workers),String(wait),String(room)],{stdio:['ignore','pipe','inherit']});
    let out='';child.stdout.on('data',chunk=>out+=chunk);
    child.on('error',reject);child.on('close',()=>resolve(JSON.parse(out)));
  });
}
/** The places taken in a private directory's waiting room. */
const places=dir=>existsSync(join(dir,'waiting'))?readdirSync(join(dir,'waiting')):[];

test('with every slot held a request waits for one, for as long as it is given and no longer',async t=>{
  const root=mkdtempSync(join(tmpdir(),'softn-slots-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  for(const name of ['soon','long','blocked/slot-0.lock','blocked/slot-1.lock'])mkdirSync(join(root,name),{recursive:true});
  // Both slots held by requests that end in 0.8 s, and one and a half
  // seconds to wait: the slot is had when they let go. It was refused at
  // once, however soon a slot was coming.
  await holding(t,join(root,'soon'),2,800);
  const served=wanting(join(root,'soon'),2,1500,2);
  assert.equal(served.held,true,JSON.stringify(served));
  assert.ok(served.waited>100&&served.waited<1400,'it waited for the slot, and not for the whole bound: '+served.waited+' ms');
  assert.deepEqual(places(join(root,'soon')),[],'its place in the waiting room went with it');
  // Held for longer than the request is given: refused when its time is up,
  // not sooner and not much later.
  const others=await holding(t,join(root,'long'),2,6000);
  const shed=wanting(join(root,'long'),2,300,2);
  assert.deepEqual({held:shed.held,usable:shed.usable},{held:false,usable:true});
  assert.ok(shed.waited>=300&&shed.waited<600,'refused after about 300 ms: '+shed.waited+' ms');
  assert.deepEqual(places(join(root,'long')),[],'and nothing is left of a request that gave up');
  // Given no time, or no room to wait in, it is refused at once, as every request was.
  for(const [wait,room] of [[0,2],[1500,0]]) {
    const hurried=wanting(join(root,'long'),2,wait,room);
    assert.equal(hurried.held,false);
    assert.ok(hurried.waited<100,wait+' ms, room for '+room+': '+hurried.waited+' ms');
  }
  others.kill();
  // And slots nobody can open are nothing to wait for.
  const blocked=wanting(join(root,'blocked'),2,1500,2);
  assert.deepEqual({held:blocked.held,usable:blocked.usable},{held:false,usable:false});
  assert.ok(blocked.waited<100,blocked.waited+' ms');
});

test('no more requests wait for a slot than there is room for: the next is refused at once',async t=>{
  // The bound that keeps an overload from the rest of the site. Each waiting
  // request holds one of the web server's PHP workers; with any number
  // allowed to wait, 40 requests a second filled a pool of eight with them
  // and a static file of the same site took seconds to come.
  const root=mkdtempSync(join(tmpdir(),'softn-slots-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const others=await holding(t,root,2,8000);
  // Room for two, and two take it.
  const first=wantingMeanwhile(root,2,1500,2),second=wantingMeanwhile(root,2,1500,2);
  for(let i=0;i<100&&places(root).length<2;i++)await pause(20);
  assert.equal(places(root).length,2,'two requests stand waiting, each with a place: '+places(root).join(' '));
  // The third finds no room and is told so in the same instant, where the
  // two are told after their second and a half.
  const third=wanting(root,2,1500,2);
  assert.deepEqual({held:third.held,usable:third.usable},{held:false,usable:true});
  assert.ok(third.waited<100,'refused at once: '+third.waited+' ms');
  // With room for three it would have waited too.
  const fourth=wanting(root,2,300,3);
  assert.ok(fourth.waited>=300,'a place, and the wait: '+fourth.waited+' ms');
  for(const waited of await Promise.all([first,second])){assert.equal(waited.held,false);assert.ok(waited.waited>=1500&&waited.waited<2300,waited.waited+' ms');}
  assert.deepEqual(places(root),[],'every place is given back');
  // A place whose owner died as it waited (PHP was killed) is no place taken
  // once it is older than any wait, and is cleared; a fresh one counts.
  const now=Math.floor(Date.now()/1000);
  writeFileSync(join(root,'waiting',(now-120)+'-abandoned'),'');writeFileSync(join(root,'waiting',(now-90)+'-abandoned'),'');
  const afterTheDead=wanting(root,2,200,2);
  assert.ok(afterTheDead.waited>=200,'two abandoned places do not fill a room for two: '+afterTheDead.waited+' ms');
  assert.deepEqual(places(root),[]);
  writeFileSync(join(root,'waiting',now+'-another'),'');writeFileSync(join(root,'waiting',now+'-request'),'');
  assert.ok(wanting(root,2,1500,2).waited<100,'two that are waiting now do');
  others.kill();
  // How many: the operator's number, or half the workers.
  const got=php([[null,4],[null,1],[null,16],[null,5],[0,4],[8,4],[1000,4],['8',4],[-1,4],[2.5,4]].map(([configured,workers])=>['softn_slot_waiters',configured,workers]));
  assert.deepEqual(got,[2,1,8,3,0,8,64,2,2,2]);
  const http=readFileSync(new URL('../runtime/http.php',import.meta.url),'utf8');
  assert.match(http,/\$slotWaiters=is_array\(\$operator\)\?\(\$operator\['slotWaiters'\]\?\?null\):null;/);
  assert.match(http,/\$waiters=softn_slot_waiters\(\$slotWaiters,\$workers\);/);
  assert.match(http,/softn_worker_slot\(\$backend\.'\/private',\$workers,SOFTN_SLOT_WAIT_MS,\$waiters\)/);
});

test('under php-fpm nobody waits unless the operator says how many may: its pool cannot be seen, and is taken to have no worker to spare',()=>{
  // php-fpm's own pool is five children, one more than the four workers.
  // With two requests allowed to wait, the fifth child stood waiting where
  // it used to refuse, nothing was left to refuse with, and an overload of
  // the API queued every PHP page of the site behind it for three seconds
  // (measured on php-fpm 8.3.6, pm.max_children = 5, static and dynamic).
  // fpm_get_status() is the one place a request could see its pool, and
  // softn_pool_has_room is how its answer would be read; but where it was
  // tried the call itself ended php-fpm 8.3.6 children with SIGSEGV, in
  // some runs, when requests made it together, so http.php makes no such
  // call and hands the reader nothing.
  const idle=(n,queue=0,more={})=>({'idle-processes':n,'active-processes':5-n,'total-processes':5,'listen-queue':queue,...more});
  const cases=[
    // Not php-fpm: nothing to look at, and the default stands (the operator of a small pool has slotWaiters).
    ['cgi-fcgi',null,true],['apache2handler',null,true],['litespeed',null,true],['cli-server',idle(0),true],['cli',null,true],
    // php-fpm: another process idle and nothing queued for a child.
    ['fpm-fcgi',idle(1),true],['fpm-fcgi',idle(4),true],
    // Every other child busy: this one is the last, and it refuses, as it always did.
    ['fpm-fcgi',idle(0),false],
    // Requests already queued for a child.
    ['fpm-fcgi',idle(2,1),false],['fpm-fcgi',idle(1,300),false],
    // No status to read (the function missing or disabled, or its answer no array): no waiting.
    ['fpm-fcgi',null,false],['fpm-fcgi',false,false],['fpm-fcgi','idle',false],['fpm-fcgi',{},false],
    // A status that does not say what is asked of it is not read as good news.
    ['fpm-fcgi',{'idle-processes':3},false],['fpm-fcgi',{'listen-queue':0},false],
    ['fpm-fcgi',{'idle-processes':'3','listen-queue':0},false],['fpm-fcgi',{'idle-processes':3,'listen-queue':'0'},false],
    ['fpm-fcgi',{'idle-processes':3,'listen-queue':null},false],['fpm-fcgi',idle(-1),false],
    // What php-fpm 8.3 answers at rest on a pool of five, as it was read from one.
    ['fpm-fcgi',{pool:'www','process-manager':'static','start-time':1791577899,'start-since':0,'accepted-conn':2,'listen-queue':0,'max-listen-queue':0,'listen-queue-len':0,'idle-processes':4,'active-processes':1,'total-processes':5,'max-active-processes':1,'max-children-reached':0,'slow-requests':0},true],
  ];
  // A status array reaches PHP as an array; php() hands a JSON object over as one.
  assert.deepEqual(php(cases.map(([sapi,status])=>['softn_pool_has_room',sapi,status])),cases.map(([,,room])=>room));
  // The operator's own number is a number: 0 or more, whole. Anything else is no number of theirs.
  assert.deepEqual(php([[0],[8],[64],[null],['8'],[-1],[2.5],[true]].map(([configured])=>['softn_slot_waiters_set',configured])),[true,true,true,false,false,false,false,false]);

  // http.php: with no number of the operator's, a pool that is not seen to
  // have room has nobody waiting. It is handed no status (null), so under
  // php-fpm that is always; and fpm_get_status() is nowhere called.
  const http=readFileSync(new URL('../runtime/http.php',import.meta.url),'utf8');
  assert.match(http,/if\(!softn_slot_waiters_set\(\$slotWaiters\)&&!softn_pool_has_room\(PHP_SAPI,null\)\)\$waiters=0;/);
  assert.ok(http.indexOf('softn_pool_has_room(PHP_SAPI,null)')<http.indexOf('softn_worker_slot($backend'),'decided before the slots are looked at');
  for(const name of ['http.php','request.php','setup.php'])assert.doesNotMatch(readFileSync(new URL('../runtime/'+name,import.meta.url),'utf8').replace(/^\s*(\/\/|\*).*$/gm,''),/fpm_get_status\s*\(/,name+' does not call fpm_get_status()');
  // What that comes to, for the SAPIs a host runs PHP under, with the
  // default four workers: two may wait everywhere but under php-fpm, and
  // the operator's number stands wherever it is written.
  const decide=(sapi,written)=>`$w=softn_slot_waiters(${written},4);if(!softn_slot_waiters_set(${written})&&!softn_pool_has_room('${sapi}',null))$w=0;$out[]=$w;`;
  const decided=spawnSync('php',['-d','display_errors=stderr','-r',`require ${JSON.stringify(runtime+'request.php')};$out=[];`+[['apache2handler','null'],['cgi-fcgi','null'],['litespeed','null'],['fpm-fcgi','null'],['fpm-fcgi','2'],['fpm-fcgi','8'],['fpm-fcgi','0'],['cgi-fcgi','0'],['cgi-fcgi','8']].map(([sapi,written])=>decide(sapi,written)).join('')+'echo json_encode($out);'],{encoding:'utf8'});
  assert.equal(decided.status,0,decided.stderr);
  assert.deepEqual(JSON.parse(decided.stdout),[2,2,2,0,2,8,0,0,8]);
});
/** How long http.php waits for a slot (request.php), for the tests that wait with it. */
const SLOT_WAIT=skip?0:Number(spawnSync('php',['-d','display_errors=stderr','-r',`require ${JSON.stringify(runtime+'request.php')};echo SOFTN_SLOT_WAIT_MS;`],{encoding:'utf8'}).stdout)||0;
/**
 * Set up as far as http.php looks before it takes a slot: a configuration,
 * and a bin/node it could start. A link to this Node where there are links
 * (nothing here runs setup.php, which would change the mode of what it
 * points at). On Windows is_executable() wants the file itself: a small
 * program of the system's stands in, since nothing here needs it to be
 * Node (started, it exits at once, which is a runner that failed), and a
 * copy of Node is 88 MB that the machine may stop to look over.
 */
function readyForSlots(backend) {
  mkdirSync(join(backend,'private'));writeFileSync(join(backend,'private/config.json'),'{}');
  mkdirSync(join(backend,'bin'));
  if(process.platform!=='win32'){symlinkSync(process.execPath,join(backend,'bin/node'));return;}
  const small=join(process.env.SystemRoot??'C:\\Windows','System32','hostname.exe');
  copyFileSync(existsSync(small)?small:process.execPath,join(backend,'bin/node'));
}
/** Resolves when `count` requests stand waiting for a slot there: each has its place by then, and is past everything http.php does before. */
async function standing(privateDir,count) {
  for(let i=0;i<500&&places(privateDir).length<count;i++)await pause(20);
  assert.equal(places(privateDir).length,count,count+' waiting');
}
const besideWebroot=root=>({DOCUMENT_ROOT:join(root,'webroot')});

nodeTest('a request that finds all four slots held waits for one, where it was told at once that the server was busy',{skip:cgiSkip},async t=>{
  // A page that makes five calls as it loads: four take the slots, and the
  // fifth was a 503 `database_busy` in the same instant, though a slot
  // would be free a fifth of a second later.
  const routes=[{method:'GET',path:'/api/ping',handler:'ping'}];
  const root=deployment(t,{routes,prepare:readyForSlots});
  const others=await holding(t,join(root,'backend/private'),4,60000);
  const asked=cgiStarted(root,'GET',{server:besideWebroot});
  // It stands waiting; then one of the four is done.
  await standing(join(root,'backend/private'),1);
  others.kill();
  const r=await asked;
  // It took the slot and went on to start a runner. This deployment
  // has none to start (no runner.mjs; and http.php's environment starts no
  // Node on Windows), so that is how it ends here: what matters is that it
  // was not turned away at the door. tests/http-runner.test.mjs has the
  // same five calls answered 200, where a runner can run.
  assert.equal(r.status,503,JSON.stringify(r));
  assert.equal(JSON.parse(r.body).code,'runner_unavailable',r.body);
  assert.deepEqual(places(join(root,'backend/private')),[],'and its place in the line is given back');
});

nodeTest('slots held for longer than the wait are still "the server is busy": after the wait, and not long after',{skip:cgiSkip},async t=>{
  assert.ok(SLOT_WAIT>=500&&SLOT_WAIT<=3000,'a wait this test can sit through: '+SLOT_WAIT+' ms');
  const routes=[{method:'GET',path:'/api/ping',handler:'ping'},{method:'POST',path:'/api/save',handler:'save'}];
  const root=deployment(t,{routes,prepare:readyForSlots});
  await holding(t,join(root,'backend/private'),4,SLOT_WAIT+6000);
  const r=await cgiStarted(root,'GET',{server:besideWebroot});
  assert.equal(r.status,503,JSON.stringify(r));
  assert.deepEqual(JSON.parse(r.body),{error:'The server is busy. Please retry.',code:'database_busy'});
  // php-cgi's own start is in the time measured, and a busy machine can
  // take a second over that, which is why "not long after" is generous
  // here; softn_worker_slot's own clock is held to the bound above.
  assert.ok(r.ms>=SLOT_WAIT,'not before the wait was up: '+Math.round(r.ms)+' ms');
  assert.ok(r.ms<SLOT_WAIT+2500,'and not long after it: '+Math.round(r.ms)+' ms');
  // What is refused without a runner is refused before the slots are looked
  // at, and so without waiting, however busy they are: a path nobody
  // declared, a method the path does not take, another site's page.
  for(const [method,options,status] of [['GET',{uri:'/api/nothing'},404],['PUT',{uri:'/api/ping'},405],['POST',{uri:'/api/save',origin:'https://evil.example'},403]]) {
    const began=performance.now();
    const refused=cgi(method,options.origin??null,t,{root,uri:options.uri,server:besideWebroot});
    assert.equal(refused.status,status,method+' '+options.uri);
    assert.ok(performance.now()-began<SLOT_WAIT/2,method+' '+options.uri+' did not wait for a slot');
  }
});

nodeTest('past the two that may wait a request is refused at once, and an operator can have none wait',{skip:cgiSkip},async t=>{
  const routes=[{method:'GET',path:'/api/ping',handler:'ping'}];
  const root=deployment(t,{routes,prepare:readyForSlots});
  const privateDir=join(root,'backend/private');
  await holding(t,privateDir,4,SLOT_WAIT+8000);
  // Four workers by default, so room for two to wait: the fifth and sixth
  // calls of a page. They stand in line.
  const standing=[cgiStarted(root,'GET',{server:besideWebroot}),cgiStarted(root,'GET',{server:besideWebroot})];
  for(let i=0;i<150&&places(privateDir).length<2;i++)await pause(20);
  assert.equal(places(privateDir).length,2,'two requests wait');
  // The seventh does not: each one waiting holds a PHP worker of the web
  // server's, and the pool they come from is not this host's to fill.
  let began=performance.now();
  const seventh=cgi('GET',null,t,{root,server:besideWebroot});
  assert.equal(seventh.status,503,JSON.stringify(seventh));
  assert.deepEqual(JSON.parse(seventh.body),{error:'The server is busy. Please retry.',code:'database_busy'});
  assert.ok(performance.now()-began<SLOT_WAIT/2,'refused without waiting');
  for(const r of await Promise.all(standing)) {
    assert.equal(JSON.parse(r.body).code,'database_busy',r.body);
    assert.ok(r.ms>=SLOT_WAIT,'the two that waited were told when their wait was up: '+Math.round(r.ms)+' ms');
  }
  assert.deepEqual(places(privateDir),[]);
  // private/config.json "slotWaiters": 0, for a PHP pool with no worker to
  // spare: every request past the slots is refused at once, as all were.
  writeFileSync(join(privateDir,'config.json'),JSON.stringify({slotWaiters:0}));
  began=performance.now();
  const none=cgi('GET',null,t,{root,server:besideWebroot});
  assert.equal(JSON.parse(none.body).code,'database_busy',none.body);
  assert.ok(performance.now()-began<SLOT_WAIT/2,'no waiting where the operator wants none');
  assert.deepEqual(places(privateDir),[]);
});

nodeTest('a bucket refused while its request stood waiting is answered 429, and no runner is started to say so',{skip:cgiSkip},async t=>{
  // A flood from one address: the requests that got slots are counted, the
  // runner notes the bucket (request-worker.mjs markLimited), and the rest
  // are still standing in line. Each used to be handed a slot and a Node
  // process only to be told what the note already said.
  const routes=[{method:'GET',path:'/api/ping',handler:'ping'}];
  const root=deployment(t,{routes,prepare:readyForSlots});
  const remote='203.0.113.7';
  const others=await holding(t,join(root,'backend/private'),4,60000);
  const waiting=cgiStarted(root,'GET',{server:besideWebroot,remote});
  // It is past the look it took at the note on arrival, and waiting.
  await standing(join(root,'backend/private'),1);
  const [key]=php([['softn_rate_key',remote]]);
  const minute=Math.floor(Date.now()/60000),bucket=createHash('sha256').update(key).digest('hex');
  for(const m of [minute,minute+1]){mkdirSync(join(root,'backend/private/limited',String(m)),{recursive:true});writeFileSync(join(root,'backend/private/limited',String(m),bucket),'');}
  // Now a slot comes free, and it is this request's turn.
  others.kill();
  const r=await waiting;
  assert.equal(r.status,429,JSON.stringify(r));
  assert.deepEqual(JSON.parse(r.body),{error:'Too many requests.',code:'rate_limited'});
  assert.ok(Number(r.headers['retry-after'])>=1);
});

test('a request and setup start the runner by one rule, with no request data in it',()=>{
  const [command]=php([['softn_runner_command','/srv/backend']]);
  assert.equal(command[0],'/srv/backend/bin/node');
  assert.equal(command.at(-1),'/srv/backend/runner.mjs');
  // Between the two, flags and nothing else. What they do to the engine is
  // in route-declarations.test.mjs: no optimizing compile outlives the answer.
  const flags=command.slice(1,-1);
  for(const flag of flags)assert.match(flag,/^--[a-z0-9=-]+$/);
  for(const flag of ['--max-old-space-size=128','--disable-proto=throw','--no-wasm-tier-up','--no-wasm-dynamic-tiering'])assert.ok(flags.includes(flag),flag);
  // One rule: a Node that will not take a flag, or a softn-runner this
  // machine cannot run, fails setup's check, not every request after a setup
  // that passed. Each starts what softn_runner_choice chose, in the
  // environment softn_runner_environment gives.
  const http=readFileSync(new URL('../runtime/http.php',import.meta.url),'utf8'),setup=readFileSync(new URL('../runtime/setup.php',import.meta.url),'utf8');
  assert.match(http,/\$runner=\$backend\?softn_runner_choice\(\$backend,\$operator\):null;/);
  assert.match(http,/proc_open\(\$runner\['command'\],\s*\[0=>\['pipe','r'\],1=>\['pipe','w'\],2=>\['pipe','w'\]\],\$pipes,\$backend,\s*softn_runner_environment\(\$backend,\$operator\)\);/);
  assert.match(setup,/\$runner=softn_runner_choice\(\$root,\$settings\);/);
  assert.match(setup,/\$run\(\$runner\['command'\],/);
  assert.match(setup,/softn_runner_environment\(\$root,\$settings\)\+\$env/);
  assert.doesNotMatch(http+setup,/--max-old-space-size|NODE_NO_WARNINGS|'\/usr\/bin:\/bin'/,'the flags and the environment are written once, in request.php');
});

test('setup says what softn-runner locks itself down to on this kernel, and what it does not',()=>{
  const report=(...reports)=>{
    const script=`require ${JSON.stringify(runtime+'request.php')};echo json_encode(array_map(fn($r)=>softn_lockdown_report($r),json_decode(stream_get_contents(STDIN),true)));`;
    const r=spawnSync('php',['-d','display_errors=stderr','-r',script],{input:JSON.stringify(reports),encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);
    return JSON.parse(r.stdout);
  };
  const denied={outside:'denied',socket:'denied',fork:'denied',exec:'denied',signal:'denied'};
  const [full,noLandlock,nothing,silent]=report(
    {landlock:{abi:6,enforced:'full'},seccomp:true,noNewPrivs:true,errors:[],probes:denied},
    {landlock:{abi:0,enforced:'none'},seccomp:true,noNewPrivs:true,errors:[],probes:{...denied,outside:'allowed'}},
    {landlock:{abi:0,enforced:'none'},seccomp:false,noNewPrivs:true,errors:['seccomp: invalid argument'],probes:{outside:'allowed',socket:'allowed',fork:'allowed',exec:'allowed',signal:'allowed'}},
    null,
  );
  assert.deepEqual(full,[
    'softn-runner locks itself down before every request: Landlock (ABI 6) keeps its files to the backend folder; seccomp refuses it other programs, new processes, network sockets and signals to other processes.',
    'Tried on this system and refused: a file outside the backend, a socket, a new process, running a program, a signal to another process.',
  ]);
  // A kernel without Landlock: seccomp alone, and a note; with neither, two notes and nothing claimed.
  assert.match(noLandlock[0],/^softn-runner locks itself down before every request: seccomp refuses/);
  assert.equal(noLandlock[1],'Tried on this system and refused: a socket, a new process, running a program, a signal to another process.');
  assert.match(noLandlock[2],/^NOTE: this kernel enforces no Landlock/);
  assert.deepEqual(nothing,['NOTE: this kernel enforces no Landlock, so it is not the kernel that keeps softn-runner to the backend folder (Linux 5.13 or newer with Landlock enabled does).','NOTE: softn-runner could not apply its seccomp filter here (seccomp: invalid argument).']);
  assert.match(silent[0],/^NOTE: softn-runner did not say what it locks itself down to/);
});

test('softn-runner answers where the backend carries it for this server, and Node where the operator wants Node',t=>{
  const backend=realpathSync(mkdtempSync(join(tmpdir(),'softn-choice-'))).replace(/\\/g,'/');
  t.after(()=>rmSync(backend,{recursive:true,force:true}));
  mkdirSync(join(backend,'bin'));
  const choose=(config,os='Linux',machine='x86_64')=>['softn_runner_choice',backend,config,os,machine];
  const runner=backend+'/bin/softn-runner-linux-x86_64',node=backend+'/bin/node';
  // Not there: Node, whatever the server.
  const [absent]=php([choose({})]);
  assert.equal(absent.runner,'node');
  assert.equal(absent.binary,node);
  assert.deepEqual(absent.command,php([['softn_runner_command',backend]])[0]);
  writeFileSync(runner,'');
  const got=php([
    choose({}),choose(null),choose({runner:'auto'}),choose({},'Linux','AMD64'),
    // php_uname disabled in the web server's PHP and not in the command
    // line's: a machine not named is the backend's own, or a request would
    // run on Node where setup had checked softn-runner.
    choose({},'Linux',''),
    choose({runner:'node'}),choose({enableRequestHook:true}),choose({enableAfterRequestHook:true}),
    choose({enableRequestHook:'yes'}),choose({},'Linux','aarch64'),choose({},'Windows','AMD64'),choose({},'Darwin','x86_64'),
  ]);
  // There, on Linux x86-64: softn-runner alone, no arguments, whatever else the configuration says.
  for(const chosen of got.slice(0,5))assert.deepEqual(chosen,{runner:'softn-runner',binary:runner,command:[runner]});
  // The operator asked for Node, or enabled a request hook (a module of
  // theirs that only Node runs; softn-runner refuses the configuration).
  for(const chosen of got.slice(5,8))assert.equal(chosen.runner,'node',JSON.stringify(chosen));
  // A hook is enabled by true alone, as both runners read it.
  assert.equal(got[8].runner,'softn-runner');
  // Another server than the one it is built for: Node, which there is no more
  // likely to run, and setup says so.
  for(const chosen of got.slice(9))assert.equal(chosen.runner,'node',JSON.stringify(chosen));
  // Either is started with the backend named: softn-runner is in bin/, not
  // beside runner.mjs. And softn-runner is told how much memory a request may
  // take: 256 MiB, as Node's engine is held to here, or the operator's
  // `requestMemoryMb`, a whole number from 128 to 1024.
  assert.deepEqual(php([['softn_runner_environment',backend]])[0],{PATH:'/usr/bin:/bin',TZ:'UTC',NODE_NO_WARNINGS:'1',SOFTN_BACKEND_ROOT:backend,SOFTN_RUNNER_MEMORY_MB:'256'});
  const told=php([128,512,1024,100,2000,'512',256.5,null,true].map(mb=>['softn_runner_environment',backend,{requestMemoryMb:mb}])).map(env=>env.SOFTN_RUNNER_MEMORY_MB);
  assert.deepEqual(told,['128','512','1024','256','256','256','256','256','256']);
});

test('the body goes to the runner as the text the client sent, whatever numbers are in it',()=>{
  const request={path:'/api/echo',method:'POST',query:{q:'1'},headers:{authorization:''},body:null,client_ip:'203.0.113.9',rate_key:'203.0.113.9',photos:false};
  // 2 MiB of a number PHP spells longer than the client did: decoded and
  // written again it was 7.5 MB, past the 6 MB the runner reads, and the
  // runner died before it had counted the request.
  const numbers='{"a":['+Array.from({length:419428},()=>'1e16').join(',')+']}';
  assert.ok(numbers.length<=2*1024*1024);
  const text='{"z":-0,"one":1.0,"e":1e2,"big":12345678901234567890,"s":"café \\ud83d\\ude00 a\\/b","dup":1,"dup":2}';
  const [large,small,none,upload]=php([
    ['softn_runner_input',request,numbers],
    ['softn_runner_input',request,text],
    ['softn_runner_input',request,'{}'],
    ['softn_runner_input',{...request,upload:{sanitized:true}},'{}'],
  ]);
  assert.ok(Buffer.byteLength(large)<numbers.length+400,'the body is not rewritten: '+Buffer.byteLength(large)+' bytes');
  assert.ok(Buffer.byteLength(large)<6_000_000,'and stays within what the runner reads');
  // The text itself, between the members http.php wrote, in their order.
  assert.equal(small,'{"path":"/api/echo","method":"POST","query":{"q":"1"},"headers":{"authorization":""},"body":'+text+',"client_ip":"203.0.113.9","rate_key":"203.0.113.9","photos":false}');
  assert.deepEqual(Object.keys(JSON.parse(small)),['path','method','query','headers','body','client_ip','rate_key','photos']);
  assert.ok(Object.is(JSON.parse(small).body.z,-0),'-0 keeps its sign, as on the Rust host; PHP wrote it back as 0');
  assert.deepEqual(JSON.parse(none).body,{});
  assert.deepEqual(JSON.parse(upload).upload,{sanitized:true});
  // http.php hands over the raw text it checked, `{}` for no body and for an upload.
  const http=readFileSync(new URL('../runtime/http.php',import.meta.url),'utf8');
  assert.match(http,/\$bodyJson=\$raw===''\?'\{\}':\$raw;/);
  assert.ok(http.indexOf('softn_request_body($raw)')<http.indexOf("$bodyJson=$raw===''"),'only a body softn_request_body took is handed on');
  assert.doesNotMatch(http,/json_encode\(\$request/);
});

test('setup.php says what is wrong and what to do when it cannot go on',t=>{
  const made=[];
  t.after(()=>{for(const root of made)rmSync(root,{recursive:true,force:true});});
  const app={id:'com.example.setup',server:{requires:{apiVersion:1,capabilities:['sql']}}};
  const fresh=(manifest=JSON.stringify(app))=>{
    const root=mkdtempSync(join(tmpdir(),'softn-setup-'));made.push(root);
    for(const name of ['setup.php','request.php'])copyFileSync(runtime+name,join(root,name));
    if(manifest!==null){mkdirSync(join(root,'app'));writeFileSync(join(root,'app/manifest.json'),manifest);}
    return root;
  };
  const setup=(root,args=[])=>spawnSync('php',['-d','display_errors=stderr',...args,join(root,'setup.php')],{encoding:'utf8'});
  // One line to act on: never PHP's own words and a stack of this server's paths.
  const clean=r=>assert.doesNotMatch(r.stdout+r.stderr,/TypeError|JsonException|Fatal error|Warning:|Uncaught|Stack trace/,r.stdout+r.stderr);

  // private/ cannot be made: a folder this account may not write in, stood
  // in for by a file where the directory would go. It was a mkdir() warning
  // and then "flock(): Argument #1 ($stream) must be of type resource".
  let root=fresh();writeFileSync(join(root,'private'),'');
  let r=setup(root);
  assert.equal(r.status,1);clean(r);
  assert.match(r.stderr,/^Cannot create private\/: .* is not writable by the account running setup/);
  assert.match(r.stderr,/Run setup as the account the web server runs PHP as/);

  // A manifest that is not JSON was an uncaught JsonException.
  root=fresh('{"id":');
  r=setup(root);
  assert.equal(r.status,1);clean(r);
  assert.match(r.stderr,/^app\/manifest\.json is not a JSON object \(Syntax error\)/);
  assert.equal(existsSync(join(root,'private/config.json')),false,'no configuration is written for an app that cannot be read');
  // And one whose id is no text can never match the configuration made from it.
  root=fresh(JSON.stringify({...app,id:7}));
  r=setup(root);
  assert.equal(r.status,1);clean(r);
  assert.match(r.stderr,/^app\/manifest\.json has no usable "id"/);

  // bin/node not uploaded: a chmod() warning, and then "does not run on this
  // machine", which sends the operator looking at the wrong thing.
  root=fresh();
  r=setup(root);
  assert.equal(r.status,1);clean(r);
  assert.match(r.stderr,/WARNING: bin\/node is missing from the backend folder/);
  assert.doesNotMatch(r.stderr,/does not run on this machine/);
  // The command-line PHP is not the web server's: setup says whose checks these were.
  assert.match(r.stdout,/These checks ran with the command-line PHP/);

  // An app that takes photos on a PHP without GD: nothing said so until someone uploaded.
  const bare=spawnSync('php',['-n','-r','echo extension_loaded("gd")?"gd":"none";'],{encoding:'utf8'}).stdout==='none';
  if(bare) {
    root=fresh(JSON.stringify({...app,server:{requires:{apiVersion:1,capabilities:['sql','photos']}}}));
    r=setup(root,['-n']);
    assert.equal(r.status,1);clean(r);
    assert.match(r.stderr,/WARNING: The application takes photo uploads and this PHP has no GD extension.*php-gd/);
    // An app that takes none is not told about GD.
    assert.doesNotMatch(setup(fresh(),['-n']).stderr,/GD extension/);
  } else t.diagnostic('GD is built into this PHP: the setup-without-GD case was not run');

  // Half an upload: setup.php without the file it reads the runner's command from.
  root=mkdtempSync(join(tmpdir(),'softn-setup-'));made.push(root);
  copyFileSync(runtime+'setup.php',join(root,'setup.php'));
  r=setup(root);
  assert.equal(r.status,1);clean(r);
  assert.match(r.stderr,/^request\.php is missing beside setup\.php/);
});
