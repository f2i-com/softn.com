import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const here=dirname(fileURLToPath(import.meta.url));
const {zipSync,unzipSync}=await import(pathToFileURL(resolve(here,'../../node_modules/fflate/esm/index.mjs')));
const sha=b=>createHash('sha256').update(b).digest('hex');
export function deploymentConfig(manifest,clientBytes) {
  // The deployment namespace has a stricter grammar than bundle IDs (which
  // commonly use reverse-domain notation). Preserve already-valid namespaces.
  const id=/^[a-z0-9][a-z0-9_-]{0,63}$/.test(manifest.id)?manifest.id:'app-'+sha(String(manifest.id)).slice(0,32);
  return {version:1,id,title:manifest.name,bundle:'./app.softn',theme:'light',sha256:sha(clientBytes)};
}
export function packagePhp({runtime,bundle,client,nodeDir,wasmDir,notices,out,operator,readme,template=false}) {
  const entries={};
  const add=(name,file)=>{entries[name]=readFileSync(file);};
  function tree(dir,prefix,skip=[]) {
    for(const item of readdirSync(dir,{withFileTypes:true})) {
      if(skip.includes(item.name)||item.name.endsWith('.map'))continue;
      if(item.isSymbolicLink())throw new Error('Package input contains symlink');
      const file=join(dir,item.name),name=prefix+item.name;
      if(item.isDirectory())tree(file,name+'/',skip);else if(item.isFile())add(name,file);
    }
  }
  tree(runtime,'webroot/',['app.softn','runtime.config.json','.htaccess','PREVIEW-BUILD.json','.vite']);
  for(const name of ['LICENSE','NOTICE','THIRD-PARTY-NOTICES.txt'])if(!entries['webroot/'+name])throw new Error('Runtime notices missing');
  tree(join(here,'runtime'),'backend/');
  add('webroot/api.php',join(here,'api.php'));add('webroot/.htaccess',join(here,'htaccess'));
  add('README-RUNTIME.md',join(here,'README.md'));if(readme)add('START-HERE.md',readme);
  add('backend/bin/node',join(nodeDir,'bin/node'));add('backend/licenses/NODE-LICENSE.txt',join(nodeDir,'LICENSE'));
  const elf=entries['backend/bin/node'];if(elf.subarray(0,4).toString('hex')!=='7f454c46'||elf.readUInt16LE(18)!==62)throw new Error('Expected Linux x86-64 Node');
  tree(notices,'backend/licenses/native/');
  if(!template) {
    const manifest=JSON.parse(readFileSync(join(bundle,'manifest.json'),'utf8'));
    const clientBytes=readFileSync(client),clientFiles=unzipSync(clientBytes),publicManifest=JSON.parse(Buffer.from(clientFiles['manifest.json']).toString());
    if(publicManifest.id!==manifest.id||publicManifest.server||Object.keys(clientFiles).some(n=>n.startsWith('server/')))throw new Error('Client identity/private-server isolation mismatch');
    tree(bundle,'backend/app/');entries['webroot/app.softn']=clientBytes;
    entries['webroot/runtime.config.json']=Buffer.from(JSON.stringify(deploymentConfig(manifest,clientBytes),null,2));
    if(operator)tree(operator,'backend/operator/');
  }
  add('backend/wasm/zipp_wasm.mjs',join(wasmDir,'zipp_wasm.js'));
  const original=readFileSync(join(wasmDir,'zipp_wasm_bg.wasm'));
  let offset=8;const parts=[original.subarray(0,8)];let changed=false;
  const leb=n=>{const bytes=[];do{let b=n&127;n>>>=7;if(n)b|=128;bytes.push(b);}while(n);return Buffer.from(bytes);};
  const read=()=>{let n=0,shift=0,b;do{b=original[offset++];n+=(b&127)*2**shift;shift+=7;}while(b&128);return n;};
  while(offset<original.length){const start=offset,id=original[offset++],length=read(),end=offset+length;
    if(id===5){const count=read(),flags=read(),min=read(),max=read();if(count!==1||flags!==1||max!==16384||offset!==end||min>4096)throw new Error('Unexpected WASM memory layout');const payload=Buffer.concat([leb(1),leb(1),leb(min),leb(4096)]);parts.push(Buffer.concat([Buffer.from([5]),leb(payload.length),payload]));changed=true;}
    else parts.push(original.subarray(start,end));offset=end;
  }
  if(!changed)throw new Error('WASM memory cap not applied');
  entries['backend/wasm/zipp_wasm_bg.wasm']=Buffer.concat(parts);new WebAssembly.Module(entries['backend/wasm/zipp_wasm_bg.wasm']);
  entries['backend/.htaccess']=Buffer.from('Require all denied\n');
  entries['BUILD-INFO.json']=Buffer.from(JSON.stringify({runtime:'SoftN PHP + on-demand ZIPP WASM',template,builtAt:new Date().toISOString(),wasmOriginalSha256:sha(original),wasmPackagedSha256:sha(entries['backend/wasm/zipp_wasm_bg.wasm']),wasmMemoryMaxBytes:268435456,instructionBudget:5000000,phpDeadlineSeconds:25,processSlots:4},null,2)+'\n');
  if(Object.keys(entries).some(n=>n.includes('/private/')||n.endsWith('.sqlite')||n.endsWith('backend.json')))throw new Error('Live state in archive');
  entries['SHA256SUMS.txt']=Buffer.from(Object.entries(entries).map(([n,b])=>sha(b)+'  '+n).join('\n')+'\n');
  const input=Object.fromEntries(Object.entries(entries).map(([n,b])=>[n,[b,{os:3,attrs:((n==='backend/bin/node'?0o100755:0o100644)<<16)>>>0}]]));
  const zip=zipSync(input,{level:6}),verified=unzipSync(zip);
  for(const [name,data]of Object.entries(entries))if(!Buffer.from(verified[name]).equals(Buffer.from(data)))throw new Error('ZIP verification failed');
  mkdirSync(dirname(out),{recursive:true});writeFileSync(out,zip);writeFileSync(out+'.sha256',sha(zip)+'  '+out.split(/[\\/]/).at(-1)+'\n');
  console.log(out+'\n'+zip.length+' bytes; '+Object.keys(entries).length+' entries verified; SHA256 '+sha(zip));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2),option=name=>{const i=args.indexOf('--'+name);return i<0?undefined:resolve(args[i+1]);};
  const options=Object.fromEntries(['runtime','bundle','client','node-dir','wasm-dir','notices','out','operator','readme'].map(n=>[n.replace(/-([a-z])/g,(_,c)=>c.toUpperCase()),option(n)]));
  options.template=args.includes('--template');
  for(const key of ['runtime','nodeDir','wasmDir','notices','out',...(options.template?[]:['bundle','client'])])if(!options[key])throw new Error('Missing option: '+key);
  packagePhp(options);
}
