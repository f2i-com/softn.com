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
 *   Node said so with a TypeError, a JsonException or a chmod() warning.
 *
 * Skipped, with the reason, when PHP is not on PATH.
 */
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,mkdtempSync,mkdirSync,copyFileSync,writeFileSync,rmSync,existsSync,realpathSync,chmodSync} from 'node:fs';
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
function cgi(method,origin,t,{routes=[],prepare=()=>{},remote='127.0.0.1',uri='/api/ping',php=[],server=()=>({})}={}) {
  const root=mkdtempSync(join(tmpdir(),'softn-cgi-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'webroot'));mkdirSync(join(root,'backend/app'),{recursive:true});
  copyFileSync(new URL('../api.php',import.meta.url),join(root,'webroot/api.php'));
  for(const name of ['http.php','request.php','client-ip.php'])copyFileSync(runtime+name,join(root,'backend',name));
  writeFileSync(join(root,'backend/app/manifest.json'),JSON.stringify({id:'cgi',config:{server:{allowedOrigins:['https://app.example']}},server:{routes}}));
  prepare(join(root,'backend'));
  // `php`: settings for this php-cgi, as a host's php.ini would make them.
  // `server`: more of what the web server tells PHP (DOCUMENT_ROOT, say), given the deployment's root.
  const env={...process.env,REQUEST_METHOD:method,REQUEST_URI:uri,SCRIPT_FILENAME:join(root,'webroot/api.php'),REDIRECT_STATUS:'200',
    HTTP_HOST:'site.example',REMOTE_ADDR:remote,GATEWAY_INTERFACE:'CGI/1.1',SERVER_PROTOCOL:'HTTP/1.1',...(origin?{HTTP_ORIGIN:origin}:{}),...server(root)};
  const r=spawnSync('php-cgi',typeof php==='function'?php(root):php,{env,encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
  const [head,body]=r.stdout.split(/\r?\n\r?\n/,2),headers={};
  for(const line of head.split(/\r?\n/)){const i=line.indexOf(':');headers[line.slice(0,i).toLowerCase()]=line.slice(i+1).trim();}
  return {status:Number((headers.status??'200').split(' ')[0]),headers,body,root};
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
  // A second run keeps the key it made.
  setup();
  assert.equal(JSON.parse(readFileSync(join(root,'private/config.json'),'utf8')).keyHex,config.keyHex);
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
  // Set up as far as http.php looks before it turns to the upload: a
  // configuration, and a bin/node it could start (it never does here).
  const prepare=backend=>{
    mkdirSync(join(backend,'private'));writeFileSync(join(backend,'private/config.json'),'{}');
    mkdirSync(join(backend,'bin'));copyFileSync(process.execPath,join(backend,'bin/node'));
    if(process.platform!=='win32')chmodSync(join(backend,'bin/node'),0o755);
  };
  // -n: no php.ini, so no extension that is not built in.
  const r=cgi('POST',null,t,{routes,uri:'/api/photo',prepare,php:['-n'],server:root=>({DOCUMENT_ROOT:join(root,'webroot')})});
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

test('a request and setup start the runner by one rule, with no request data in it',()=>{
  const [command]=php([['softn_runner_command','/srv/backend']]);
  assert.equal(command[0],'/srv/backend/bin/node');
  assert.equal(command.at(-1),'/srv/backend/runner.mjs');
  // Between the two, flags and nothing else. What they do to the engine is
  // in route-declarations.test.mjs: no optimizing compile outlives the answer.
  const flags=command.slice(1,-1);
  for(const flag of flags)assert.match(flag,/^--[a-z0-9=-]+$/);
  for(const flag of ['--max-old-space-size=128','--disable-proto=throw','--no-wasm-tier-up','--no-wasm-dynamic-tiering'])assert.ok(flags.includes(flag),flag);
  // One definition: a Node that will not take a flag fails setup's check,
  // not every request after a setup that passed.
  const http=readFileSync(new URL('../runtime/http.php',import.meta.url),'utf8'),setup=readFileSync(new URL('../runtime/setup.php',import.meta.url),'utf8');
  assert.match(http,/proc_open\(softn_runner_command\(\$backend\),/);
  assert.match(setup,/\$run\(softn_runner_command\(\$root\),/);
  assert.doesNotMatch(http+setup,/--max-old-space-size/,'the flags are written once, in request.php');
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
