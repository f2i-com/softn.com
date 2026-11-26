import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
const root=process.env.SOFTN_PHP_TEST_BACKEND;
const skip=root?false:'Set SOFTN_PHP_TEST_BACKEND to an extracted backend';
// Without the backend fixture these tests are SKIPPED, visibly, not thrown
// out of: the suite runs in every checkout and CI, and the fixture-bound
// cases report why they did not run.
if(skip)console.warn(`WARNING: tests/websocket.test.mjs skipped: ${skip}. See apps/softn-host-php/README.md, Validation.`);
const test=(name,...rest)=>{const fn=rest.pop();return nodeTest(name,{...(rest[0]??{}),skip},fn);};
const {createLiveServer}=skip?{}:await import(pathToFileURL(join(root,'websocket.mjs')));
const {default:WebSocket}=skip?{}:await import(pathToFileURL(join(root,'vendor/ws/wrapper.mjs')));
test('optional WebSocket bridge checks auth on every poll, delivers changes and closes revoked sessions',{timeout:10000},async t=>{
  let revoked=false,checks=0;
  const upstream=http.createServer((req,res)=>{
    checks++;
    if(req.headers.authorization!=='Bearer fixture'||revoked){res.writeHead(401,{'Content-Type':'application/json'});res.end('{"error":"private rejection"}');return;}
    assert.equal(req.headers.origin,'https://app.example');
    if(req.headers['if-none-match']==='"one"'){res.writeHead(304);res.end();return;}
    res.writeHead(200,{'Content-Type':'application/json',ETag:'"one"'});res.end('{"value":1}');
  });upstream.listen(0,'127.0.0.1');await once(upstream,'listening');t.after(()=>upstream.close());
  const live=createLiveServer({upstream:'http://127.0.0.1:'+upstream.address().port,origins:['https://app.example'],routes:[{path:'/api/counter',method:'GET',transaction:'read',poll:true}],intervalMs:20});
  live.server.listen(0,'127.0.0.1');await once(live.server,'listening');t.after(()=>live.close());
  const url='ws://127.0.0.1:'+live.server.address().port+'/events';
  const socket=new WebSocket(url,{origin:'https://app.example'});await once(socket,'open');
  const messages=[];
  socket.on('message',bytes=>{const m=JSON.parse(bytes);messages.push(m);if(m.type==='unchanged')revoked=true;});
  socket.send(JSON.stringify({type:'subscribe',path:'/api/counter',authorization:'Bearer fixture'}));await once(socket,'close');
  assert.deepEqual(messages[0],{type:'update',body:{value:1}});assert.ok(messages.some(m=>m.type==='unchanged'));assert.deepEqual(messages.at(-1),{type:'error',status:401});assert.ok(checks>=3);
  const invalid=new WebSocket(url,{origin:'https://app.example'});await once(invalid,'open');invalid.send(JSON.stringify({type:'subscribe',path:'/api/private',authorization:'Bearer fixture'}));const [code]=await once(invalid,'close');assert.equal(code,1008);
  await new Promise((resolve,reject)=>{const foreign=new WebSocket(url,{origin:'https://evil.example'});foreign.on('unexpected-response',(req,res)=>{assert.equal(res.statusCode,403);req.destroy();resolve();});foreign.on('error',()=>{});setTimeout(()=>reject(Error('Origin check timeout')),1000).unref();});
});
test('the bridge takes the polling routes the runner serves: a GET declared `none` or not at all is a read',{timeout:10000},async t=>{
  const upstream=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json',ETag:'"one"'});res.end(JSON.stringify({path:req.url}));});
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');t.after(()=>upstream.close());
  // `none` is the Rust host's word for "no transaction declared", and the
  // runner reads both as `read` for a GET. The bridge read only `read` and
  // an absent one, so a route that polled over HTTP was "Invalid
  // subscription" over the socket.
  const routes=[
    {path:'/api/feed',method:'GET',transaction:'none',poll:true},
    {path:'/api/plain',method:'GET',poll:true},
    {path:'/api/read',method:'GET',transaction:'read',poll:true},
    // Not polling routes, on either transport.
    {path:'/api/write',method:'GET',transaction:'write',poll:true},
    {path:'/api/post',method:'POST',transaction:'none',poll:true},
    {path:'/api/quiet',method:'GET',transaction:'none'},
  ];
  const live=createLiveServer({upstream:'http://127.0.0.1:'+upstream.address().port,origins:['https://app.example'],routes,intervalMs:1000,maxPerClient:8});
  live.server.listen(0,'127.0.0.1');await once(live.server,'listening');t.after(()=>live.close());
  const url='ws://127.0.0.1:'+live.server.address().port+'/events';
  const subscribe=async path=>{
    const socket=new WebSocket(url,{origin:'https://app.example'});await once(socket,'open');
    const answer=new Promise(resolve=>{socket.once('message',bytes=>resolve(JSON.parse(bytes)));socket.once('close',code=>resolve({closed:code}));});
    socket.send(JSON.stringify({type:'subscribe',path,authorization:'Bearer fixture'}));
    const got=await answer;socket.terminate();return got;
  };
  for(const path of ['/api/feed','/api/plain','/api/read'])assert.deepEqual(await subscribe(path),{type:'update',body:{path}},path);
  for(const path of ['/api/write','/api/post','/api/quiet','/api/nothing'])assert.deepEqual(await subscribe(path),{closed:1008},path);
});
test('WebSocket upstream refuses remote plaintext and embedded credentials',()=>{
  for(const upstream of ['http://example.com','https://user:secret@example.com','https://example.com/path'])assert.throws(()=>createLiveServer({upstream,origins:[],routes:[]}));
});

test('the bridge accepts its own HTTPS site without a listing, and still refuses others',{timeout:5000},async t=>{
  const live=createLiveServer({upstream:'https://app.example',origins:[],routes:[]});
  live.server.listen(0,'127.0.0.1');await once(live.server,'listening');t.after(()=>live.close());
  const url='ws://127.0.0.1:'+live.server.address().port+'/events';
  const own=new WebSocket(url,{origin:'https://app.example'});await once(own,'open');own.close();
  await new Promise((resolve,reject)=>{const other=new WebSocket(url,{origin:'https://evil.example'});other.on('unexpected-response',(req,res)=>{assert.equal(res.statusCode,403);req.destroy();resolve();});other.on('error',()=>{});setTimeout(()=>reject(Error('Origin check timeout')),1000).unref();});
});
test('one visitor cannot hold every connection, and a closed one frees its slot',{timeout:10000},async t=>{
  const live=createLiveServer({upstream:'http://127.0.0.1:9',origins:['https://app.example'],routes:[],maxClients:8,maxPerClient:2});
  live.server.listen(0,'127.0.0.1');await once(live.server,'listening');t.after(()=>live.close());
  const url='ws://127.0.0.1:'+live.server.address().port+'/events';
  // The bridge sits behind the site's proxy on loopback; X-Forwarded-For names the visitor.
  const open=xff=>new Promise(resolve=>{const ws=new WebSocket(url,{origin:'https://app.example',headers:{'X-Forwarded-For':xff}});ws.on('open',()=>resolve({ok:true,ws}));ws.on('unexpected-response',(req,res)=>{req.destroy();resolve({ok:false,status:res.statusCode});});ws.on('error',()=>{});});
  const a1=await open('203.0.113.9'),a2=await open('203.0.113.9'),a3=await open('203.0.113.9'),b1=await open('198.51.100.4');
  assert.equal(a1.ok,true);assert.equal(a2.ok,true);assert.deepEqual(a3,{ok:false,status:403});assert.equal(b1.ok,true);
  a1.ws.close();await once(a1.ws,'close');await new Promise(resolve=>setTimeout(resolve,100));
  const a4=await open('203.0.113.9');assert.equal(a4.ok,true);
  for(const c of [a2,b1,a4])c.ws.terminate();
});
test('one visitor cannot connect, subscribe and connect again without end',{timeout:10000},async t=>{
  // Every poll reaches the host from the bridge's address, so they all count against one
  // allowance there. A token the host refuses costs a poll and closes the connection: looped,
  // that spent the allowance of everyone the bridge serves. Only concurrent connections were
  // counted, and this loop never holds more than one.
  let polls=0;
  const upstream=http.createServer((req,res)=>{polls++;res.writeHead(401,{'Content-Type':'application/json'});res.end('{}');});
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');t.after(()=>upstream.close());
  let clock=1_000_000;
  const live=createLiveServer({upstream:'http://127.0.0.1:'+upstream.address().port,origins:['https://app.example'],routes:[{path:'/api/feed',method:'GET',poll:true}],maxUpgradesPerMinute:3,now:()=>clock});
  live.server.listen(0,'127.0.0.1');await once(live.server,'listening');t.after(()=>live.close());
  const url='ws://127.0.0.1:'+live.server.address().port+'/events';
  const attempt=xff=>new Promise(resolve=>{
    const ws=new WebSocket(url,{origin:'https://app.example',headers:{'X-Forwarded-For':xff}});
    ws.on('open',()=>ws.send(JSON.stringify({type:'subscribe',path:'/api/feed',authorization:'Bearer refused'})));
    ws.on('close',code=>resolve({closed:code}));
    ws.on('unexpected-response',(req,res)=>{req.destroy();resolve({status:res.statusCode,retryAfter:res.headers['retry-after']});});
    ws.on('error',()=>{});
  });
  const looped=[];for(let i=0;i<6;i++)looped.push(await attempt('203.0.113.9'));
  assert.deepEqual(looped,[...Array(3).fill({closed:1008}),...Array(3).fill({status:429,retryAfter:'60'})]);
  assert.equal(polls,3);
  // Another visitor has an allowance of their own, and the first has one again a minute on.
  assert.deepEqual(await attempt('198.51.100.4'),{closed:1008});
  clock+=59_000;assert.equal((await attempt('203.0.113.9')).status,429);
  clock+=1_000;assert.deepEqual(await attempt('203.0.113.9'),{closed:1008});
  assert.equal(polls,5);
});
test('a connection that does not subscribe is closed after two seconds, as LIVE_UPDATES.md says',{timeout:10000},async t=>{
  // The document said ten seconds for as long as the bridge has closed at two.
  const live=createLiveServer({upstream:'http://127.0.0.1:9',origins:['https://app.example'],routes:[]});
  live.server.listen(0,'127.0.0.1');await once(live.server,'listening');t.after(()=>live.close());
  const socket=new WebSocket('ws://127.0.0.1:'+live.server.address().port+'/events',{origin:'https://app.example'});
  await once(socket,'open');const opened=Date.now();
  const [code,reason]=await once(socket,'close');
  assert.equal(code,1008);assert.equal(String(reason),'Subscribe required');
  const waited=Date.now()-opened;
  assert.ok(waited>=1500&&waited<6000,`closed after ${waited} ms`);
  const doc=(await import('node:fs')).readFileSync(new URL('../LIVE_UPDATES.md',import.meta.url),'utf8');
  assert.match(doc,/has not subscribed within\s+two seconds is closed/);
});
test('a host that refuses or fails is polled less and less often, and at the interval again once it answers',{timeout:15000},async t=>{
  // Every poll was followed by the next a full interval later, whatever came back: a host
  // answering 429 or 5xx was asked again as often by every connection (tests/poll-backoff.test.mjs
  // has the arithmetic; this is the bridge keeping to it).
  let failing=true,polls=0;
  const upstream=http.createServer((req,res)=>{
    polls++;
    // An error page, as a proxy in front of the host answers: not JSON.
    if(failing){res.writeHead(503,{'Content-Type':'text/html'});res.end('<h1>Service Unavailable</h1>');return;}
    res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');
  });
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');t.after(()=>upstream.close());
  const live=createLiveServer({upstream:'http://127.0.0.1:'+upstream.address().port,origins:['https://app.example'],routes:[{path:'/api/feed',method:'GET',poll:true}],intervalMs:10,maxBackoffMs:2000});
  live.server.listen(0,'127.0.0.1');await once(live.server,'listening');t.after(()=>live.close());
  const socket=new WebSocket('ws://127.0.0.1:'+live.server.address().port+'/events',{origin:'https://app.example'});await once(socket,'open');t.after(()=>socket.terminate());
  const messages=[];socket.on('message',bytes=>messages.push(JSON.parse(bytes)));
  const until=(what,ms=5000)=>new Promise((resolve,reject)=>{const started=Date.now();const check=()=>what()?resolve():Date.now()-started>ms?reject(Error('timed out waiting')):setTimeout(check,5);check();});
  socket.send(JSON.stringify({type:'subscribe',path:'/api/feed',authorization:'Bearer fixture'}));
  // At the interval that is some forty polls in the 450 ms; doubling from 20 ms it is five
  // (at 0, 20, 60, 140 and 300 ms; the sixth is at 620).
  await new Promise(resolve=>setTimeout(resolve,450));
  assert.ok(polls>=3&&polls<=8,`${polls} polls of a failing host in 450 ms`);
  // The client is told the status the host gave (it was 503 for any body that was not JSON).
  assert.deepEqual(messages[0],{type:'error',status:503});
  assert.ok(messages.every(m=>m.type==='error'&&m.status===503),JSON.stringify(messages));
  // The host recovers: the next poll finds it, and the ones after come at the interval.
  failing=false;
  await until(()=>messages.some(m=>m.type==='update'));
  const before=polls;
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.ok(polls-before>=6,`${polls-before} polls of a well host in 300 ms`);
});
test('the bridge does not ask again before the Retry-After of a 429',{timeout:15000},async t=>{
  let polls=0;
  const upstream=http.createServer((req,res)=>{polls++;res.writeHead(429,{'Content-Type':'application/json','Retry-After':'1'});res.end('{"error":"rate_limited"}');});
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');t.after(()=>upstream.close());
  const live=createLiveServer({upstream:'http://127.0.0.1:'+upstream.address().port,origins:['https://app.example'],routes:[{path:'/api/feed',method:'GET',poll:true}],intervalMs:10});
  live.server.listen(0,'127.0.0.1');await once(live.server,'listening');t.after(()=>live.close());
  const socket=new WebSocket('ws://127.0.0.1:'+live.server.address().port+'/events',{origin:'https://app.example'});await once(socket,'open');t.after(()=>socket.terminate());
  const message=once(socket,'message');
  socket.send(JSON.stringify({type:'subscribe',path:'/api/feed',authorization:'Bearer fixture'}));
  assert.deepEqual(JSON.parse((await message)[0]),{type:'error',status:429});
  // The doubled wait would be 20 ms; the host said a second.
  await new Promise(resolve=>setTimeout(resolve,700));
  assert.equal(polls,1,'asked again inside the second the host named');
  await new Promise(resolve=>setTimeout(resolve,800));
  assert.equal(polls,2,'and once it had passed');
});
