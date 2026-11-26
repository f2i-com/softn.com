// Optional persistent transport for authenticated HTTP polling routes.
// Not launched by PHP/setup, and never evaluates application code itself.
import http from 'node:http';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {WebSocketServer} from './vendor/ws/wrapper.mjs';
import {clientKey} from './client-key.mjs';
import {MAX_BACKOFF_MS,pollDelayMs,retryAfterMs} from './poll-backoff.mjs';
export {clientKey};

export function createLiveServer({upstream,origins,routes,intervalMs=5000,maxBackoffMs=MAX_BACKOFF_MS,maxClients=8,maxPerClient=2,maxUpgradesPerMinute=12,fetchImpl=fetch,now=Date.now}) {
  const target=new URL(upstream);
  if(target.username||target.password||target.search||target.hash||target.pathname!=='/'||!(target.protocol==='https:'||target.protocol==='http:'&&['127.0.0.1','[::1]','localhost'].includes(target.hostname)))throw Error('Use an HTTPS origin or loopback HTTP upstream');
  // A GET with no transaction declared, or the Rust host's `none`, is a read:
  // the runner serves it as a polling route (request-worker.mjs), so the
  // bridge does too. `none` was refused here as "Invalid subscription" for a
  // route that polled over HTTP.
  const read=r=>r.transaction===undefined||r.transaction==='none'||r.transaction==='read';
  // The site's own HTTPS origin needs no listing, as PHP accepts it (runtime/request.php).
  const allowed=new Set([...origins,...(target.protocol==='https:'?[target.origin]:[])]),paths=new Set(routes.filter(r=>r.poll===true&&r.method==='GET'&&read(r)&&/^\/api\/[a-zA-Z0-9/_-]+$/.test(r.path)).map(r=>r.path));
  const server=http.createServer((req,res)=>{res.writeHead(404);res.end();});
  const sockets=new WebSocketServer({noServer:true,maxPayload:8192,perMessageDeflate:false});
  // Connections per visitor, so one visitor cannot hold every slot.
  const perClient=new Map();
  // Connections a visitor opened this minute. Each may subscribe once and is polled for at
  // once, and upstream every poll comes from the bridge's own address: a visitor who
  // connected, subscribed with any token and connected again, over and over, spent the
  // host's allowance for that address, and every other visitor's updates were refused with
  // it. No more than 1024 visitors are counted at a time; a new one past that waits for a
  // minute to end.
  const opened=new Map();
  const admitted=key=>{
    const at=now();let seen=opened.get(key);
    if(!seen||at-seen.since>=60000){
      if(!seen&&opened.size>=1024){for(const [k,v] of opened)if(at-v.since>=60000)opened.delete(k);if(opened.size>=1024)return false;}
      opened.set(key,seen={since:at,count:0});
    }
    return ++seen.count<=maxUpgradesPerMinute;
  };
  server.on('upgrade',(req,socket,head)=>{
    const key=clientKey(req);
    if(req.url!=='/events'||!allowed.has(req.headers.origin)||sockets.clients.size>=maxClients||(perClient.get(key)??0)>=maxPerClient){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
    if(!admitted(key)){socket.end('HTTP/1.1 429 Too Many Requests\r\nRetry-After: 60\r\nConnection: close\r\n\r\n');return;}
    perClient.set(key,(perClient.get(key)??0)+1);
    let counted=true;
    const release=()=>{if(!counted)return;counted=false;const n=(perClient.get(key)??1)-1;if(n>0)perClient.set(key,n);else perClient.delete(key);};
    socket.once('close',release);
    sockets.handleUpgrade(req,socket,head,ws=>{ws.once('close',release);sockets.emit('connection',ws,req);});
  });
  sockets.on('connection',(ws,req)=>{
    let subscription=null,timer=null,controller=null,closed=false;
    // Polls in a row that brought no answer. Each doubles the wait before the next
    // (poll-backoff.mjs), where every one used to be followed at the full interval.
    let failures=0;
    // Two seconds to subscribe, as LIVE_UPDATES.md says (it was ten, and the document
    // went on saying so): a connection that says nothing holds one of eight places.
    const admission=setTimeout(()=>ws.close(1008,'Subscribe required'),2000);
    function send(value){if(ws.readyState!==1)return;if(ws.bufferedAmount>65536){ws.close(1013,'Client too slow');return;}ws.send(JSON.stringify(value));}
    async function poll(){
      if(closed||!subscription)return;
      controller=new AbortController();const deadline=setTimeout(()=>controller.abort(),10000);
      let keep=true,answered=false,retryAfter=null;
      try {
        const headers={Origin:req.headers.origin,Authorization:subscription.authorization};
        if(subscription.etag)headers['If-None-Match']=subscription.etag;
        const r=await fetchImpl(new URL(subscription.path,target),{headers,redirect:'error',signal:controller.signal});
        if(r.status===304){await r.body?.cancel();answered=true;send({type:'unchanged'});}
        else if(r.status===200) {
          const reader=r.body.getReader();let size=0;const chunks=[];
          try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>3*1024*1024)throw Error('Response limit');chunks.push(Buffer.from(part.value));}}finally{await reader.cancel();}
          const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
          subscription.etag=r.headers.get('etag');answered=true;send({type:'update',body});
        } else {
          // A refusal or a failure. Its status and when it says to come back are all that
          // is taken from it: the body is not the client's, and need not be JSON (a proxy's
          // error page was read as one, and the client was told 503 whatever the status).
          retryAfter=retryAfterMs(r.headers.get('retry-after'),now());
          send({type:'error',status:r.status});
          if([401,403,404].includes(r.status)){keep=false;ws.close(1008,'Subscription unavailable');}
          try{await r.body?.cancel();}catch{}
        }
      }catch{send({type:'error',status:503});}
      finally{
        clearTimeout(deadline);controller=null;failures=answered?0:failures+1;
        if(keep&&!closed)timer=setTimeout(poll,pollDelayMs({intervalMs,failures,retryAfter,maxBackoffMs}));
      }
    }
    ws.on('message',(data,binary)=>{
      if(subscription||binary){ws.close(1008,'One subscription per connection');return;}
      try {
        const m=JSON.parse(data.toString());
        if(m.type!=='subscribe'||typeof m.path!=='string'||!paths.has(m.path)||typeof m.authorization!=='string'||!/^Bearer [\x21-\x7e]{1,2048}$/.test(m.authorization))throw Error('Invalid subscription');
        subscription={path:m.path,authorization:m.authorization,etag:null};clearTimeout(admission);poll();
      }catch{ws.close(1008,'Invalid subscription');}
    });
    ws.on('error',()=>{});
    ws.on('close',()=>{closed=true;clearTimeout(admission);clearTimeout(timer);controller?.abort();subscription=null;});
  });
  return {server,close:()=>{for(const ws of sockets.clients)ws.terminate();sockets.close();server.close();}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2),option=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
  const manifest=JSON.parse(readFileSync(new URL('./app/manifest.json',import.meta.url),'utf8'));
  const live=createLiveServer({upstream:option('--upstream','http://127.0.0.1'),origins:manifest.config?.server?.allowedOrigins||[],routes:manifest.server?.routes||[]});
  const port=Number(option('--port','8788'));if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid port');
  live.server.listen(port,'127.0.0.1',()=>console.log('Optional live bridge listening on loopback port '+port));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>live.close());
}
