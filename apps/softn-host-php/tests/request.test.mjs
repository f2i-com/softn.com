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
 * - every IPv6 address had its own rate-limit bucket.
 *
 * Skipped, with the reason, when PHP is not on PATH.
 */
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,mkdtempSync,mkdirSync,copyFileSync,writeFileSync,rmSync} from 'node:fs';
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
  const r=spawnSync('php',['-d','display_errors=stderr','-r',script],{input:JSON.stringify(calls),encoding:'utf8'});
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
function cgi(method,origin,t) {
  const root=mkdtempSync(join(tmpdir(),'softn-cgi-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'webroot'));mkdirSync(join(root,'backend/app'),{recursive:true});
  copyFileSync(new URL('../api.php',import.meta.url),join(root,'webroot/api.php'));
  for(const name of ['http.php','request.php','client-ip.php'])copyFileSync(runtime+name,join(root,'backend',name));
  writeFileSync(join(root,'backend/app/manifest.json'),JSON.stringify({id:'cgi',config:{server:{allowedOrigins:['https://app.example']}},server:{routes:[]}}));
  const env={...process.env,REQUEST_METHOD:method,REQUEST_URI:'/api/ping',SCRIPT_FILENAME:join(root,'webroot/api.php'),REDIRECT_STATUS:'200',
    HTTP_HOST:'site.example',REMOTE_ADDR:'127.0.0.1',GATEWAY_INTERFACE:'CGI/1.1',SERVER_PROTOCOL:'HTTP/1.1',...(origin?{HTTP_ORIGIN:origin}:{})};
  const r=spawnSync('php-cgi',[],{env,encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
  const [head,body]=r.stdout.split(/\r?\n\r?\n/,2),headers={};
  for(const line of head.split(/\r?\n/)){const i=line.indexOf(':');headers[line.slice(0,i).toLowerCase()]=line.slice(i+1).trim();}
  return {status:Number((headers.status??'200').split(' ')[0]),headers,body};
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

test('http.php passes the runner\'s body through and never re-encodes it',()=>{
  const http=readFileSync(new URL('../runtime/http.php',import.meta.url),'utf8');
  assert.match(http,/softn_runner_result\(\$output\)/);
  assert.doesNotMatch(http,/json_decode\(\$output/);
  assert.match(http,/'query'=>\(object\)softn_query\(/);
  assert.doesNotMatch(http,/\$_GET/);
});

test('api.php refuses an old PHP or a wrong backend path with JSON, not a parse error',()=>{
  const api=readFileSync(new URL('../api.php',import.meta.url),'utf8');
  assert.match(api,/PHP_VERSION_ID < 80100/);
  const r=spawnSync('php',['-d','display_errors=1',fileURLToPath(new URL('../api.php',import.meta.url))],{encoding:'utf8'});
  // Run from the checkout there is no sibling backend/ directory.
  assert.equal(JSON.parse(r.stdout).diagnostic,'backend_path');
});
