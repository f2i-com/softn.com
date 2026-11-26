import {existsSync,mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const here=dirname(fileURLToPath(import.meta.url));
const {unzipSync}=await import(pathToFileURL(resolve(here,'../../node_modules/fflate/esm/index.mjs')));
const {writeArchive}=await import(pathToFileURL(resolve(here,'../../scripts/lib/archive.mjs')));
const {pruneHostedRuntimeEntries}=await import(pathToFileURL(resolve(here,'../../scripts/build/prune-hosted-runtime.mjs')));
const sha=b=>createHash('sha256').update(b).digest('hex');
export function deploymentConfig(manifest,clientBytes,permissionMode='prompt') {
  if(!['prompt','preapproved'].includes(permissionMode))throw new Error('Invalid permission mode');
  // The deployment namespace has a stricter grammar than bundle IDs (which
  // commonly use reverse-domain notation). Preserve already-valid namespaces.
  const id=/^[a-z0-9][a-z0-9_-]{0,63}$/.test(manifest.id)?manifest.id:'app-'+sha(String(manifest.id)).slice(0,32);
  return {version:1,id,title:manifest.name,bundle:'./app.softn',theme:'light',sha256:sha(clientBytes),...(manifest.backend?{backendUrl:'.'}:{}),...(permissionMode==='preapproved'?{permissionMode}:{})};
}
// `privateDir` selects the privately served variant: the runtime is
// apps/softn-single-private's webroot, the archive and its settings ship
// under private/, `htaccess` carries the serve rules with the /api rewrite,
// and `startHere`/`serveGuide` are that variant's guides. `explainer` is the
// plain-language README.md generated from scripts/release/release-packages.mjs, the
// front door every release archive has; when it is given, the detailed guide
// ships as DEPLOYMENT.md beside it, as in the other archives.
// `runnerDir` holds softn-runner as apps/softn-runner/build.mjs writes it (the
// Linux build and its licences file): with it, the backend carries it in bin/
// and http.php starts it where it started Node (request.php
// softn_runner_choice). Node stays, for an operator's request hooks and the
// WebSocket bridge.
export const RUNNER_BINARY='softn-runner-linux-x86_64';
export const RUNNER_NOTICES='SOFTN-RUNNER-THIRD-PARTY-LICENSES.txt';
function capWasmMemory(original, maxPages = 4096) {
  let offset = 8;
  const parts = [original.subarray(0, 8)];
  let changed = false;
  const leb = n => {
    const bytes = [];
    do {
      let b = n & 127;
      n >>>= 7;
      if (n) b |= 128;
      bytes.push(b);
    } while (n);
    return Buffer.from(bytes);
  };
  const read = () => {
    let n = 0, shift = 0, b;
    do {
      b = original[offset++];
      n += (b & 127) * 2 ** shift;
      shift += 7;
    } while (b & 128);
    return n;
  };
  while (offset < original.length) {
    const start = offset, id = original[offset++], length = read(), end = offset + length;
    if (id === 5) {
      const count = read(), flags = read(), min = read();
      const hasMax = (flags & 1) !== 0;
      const max = hasMax ? read() : null;
      if (count !== 1 || (flags !== 0 && flags !== 1) || offset !== end || min > maxPages) {
        throw new Error('Unexpected WASM memory layout');
      }
      const nextMax = hasMax ? Math.min(max, maxPages) : maxPages;
      const payload = Buffer.concat([leb(1), leb(1), leb(min), leb(nextMax)]);
      parts.push(Buffer.concat([Buffer.from([5]), leb(payload.length), payload]));
      changed = true;
    } else {
      parts.push(original.subarray(start, end));
    }
    offset = end;
  }
  if (!changed) throw new Error('WASM memory cap not applied');
  const capped = Buffer.concat(parts);
  new WebAssembly.Module(capped);
  return capped;
}
const escHtml=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
function sanitizeStaticPreview(raw,isUi) {
  let text=String(raw).slice(0,262144);
  if(isUi) {
    text=text.replace(/<!--[\s\S]*?-->/g,'').replace(/<(logic|script|style|data|import)\b[^>]*>[\s\S]*?<\/\1>/gi,'').replace(/<(logic|script|style|data|import)\b[^>]*\/?>/gi,'').replace(/^\s*[#/][a-z]+\b[^\n]*$/gim,'');
    const blocks=[];
    const re=/<(Heading|Title|H[1-6]|Text|Paragraph|P|Button|Label)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let m;
    while((m=re.exec(text))&&blocks.length<80) {
      const inner=m[2].replace(/<[^>]+>/g,' ').replace(/\{[^}]*\}/g,' ').replace(/\s+/g,' ').trim();
      if(!inner)continue;
      const tag=/^(?:heading|title|h[1-6])$/i.test(m[1])?'h2':/^button$/i.test(m[1])?'button':'p';
      blocks.push(tag==='button'?`<button type="button">${escHtml(inner)}</button>`:`<${tag}>${escHtml(inner)}</${tag}>`);
    }
    return blocks.join('\n            ');
  }
  const body=text.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  text=(body?body[1]:text.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi,''))
    .replace(/<!--[\s\S]*?-->/g,'')
    .replace(/<(script|style|noscript|template|iframe|object|embed|svg|math|form|textarea|select|canvas|audio|video)\b[^>]*>[\s\S]*?<\/\1>/gi,'')
    .replace(/<(script|style|noscript|template|iframe|object|embed|svg|math|form|textarea|select|input|meta|link|base|canvas|audio|video)\b[^>]*\/?>/gi,'');
  const blocks=[];
  const re=/<(h[1-6]|p|li|blockquote|pre|figcaption|button)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while((m=re.exec(text))&&blocks.length<80) {
    const inner=m[2].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
    if(!inner)continue;
    const tag=m[1].toLowerCase()==='h1'?'h2':m[1].toLowerCase();
    blocks.push(tag==='button'?`<button type="button">${escHtml(inner)}</button>`:`<${tag}>${escHtml(inner)}</${tag}>`);
  }
  return blocks.join('\n            ');
}
function bakeAppSeoHtml(htmlBuf,manifest,clientFiles) {
  let html=Buffer.from(htmlBuf).toString('utf8');
  if(!/<\/head>/i.test(html))return htmlBuf;
  const title=String(manifest.name||'Application').slice(0,120);
  const desc=String(manifest.description||`${title} — a SoftN web application.`).slice(0,300);
  html=html.replace(/<title>[\s\S]*?<\/title>/i,()=>`<title>${escHtml(title)}</title>`);
  const ld=JSON.stringify({'@context':'https://schema.org','@type':'WebApplication',name:title,description:desc,operatingSystem:'Any',applicationCategory:'UtilitiesApplication',...(manifest.version?{softwareVersion:String(manifest.version)}:{})}).replace(/</g,'\\u003C').replace(/>/g,'\\u003E').replace(/&/g,'\\u0026');
  const headMeta=`    <link rel="preload" href="./app.softn" as="fetch" crossorigin="anonymous" fetchpriority="high" />\n    <meta name="description" content="${escHtml(desc)}" />\n    <meta property="og:type" content="website" />\n    <meta property="og:title" content="${escHtml(title)}" />\n    <meta property="og:description" content="${escHtml(desc)}" />\n    <meta name="twitter:card" content="summary" />\n    <meta name="twitter:title" content="${escHtml(title)}" />\n    <meta name="twitter:description" content="${escHtml(desc)}" />\n    <script type="application/ld+json">${ld}</script>\n  </head>`;
  html=html.replace(/<\/head>/i,()=>headMeta);
  const mainEntry=typeof manifest.main==='string'?manifest.main.replace(/^\/+/,''):'';
  const frontendRoot=typeof manifest.frontendRoot==='string'?manifest.frontendRoot.replace(/^\/+|\/+$/g,''):'';
  const entryCandidates=[mainEntry,...(frontendRoot?[`${frontendRoot}/index.html`]:[]),'index.html','ui/main.ui'];
  const entryName=entryCandidates.find(n=>n&&clientFiles[n]&&/\.(?:ui|html?)$/i.test(n)&&!/^(?:server|backend|private)\//i.test(n));
  const preview=entryName?sanitizeStaticPreview(Buffer.from(clientFiles[entryName]).toString('utf8'),entryName.toLowerCase().endsWith('.ui')):'';
  const ssr=`        <article class="softn-ssr" data-softn-ssr="packaged">\n          <h1>${escHtml(title)}</h1>\n          <p>${escHtml(desc)}</p>${preview?`\n          <section data-softn-preview="rendered" aria-label="Rendered application preview">\n            ${preview}\n          </section>`:''}\n        </article>`;
  if(/<div\s+id="boot"(?=\s|>)[^>]*>[\s\S]*?<\/div>/i.test(html)) {
    html=html.replace(/(<div\s+id="boot"(?=\s|>)[^>]*>[\s\S]*?)(<\/div>)/i,(_,a,b)=>`${a}\n${ssr}\n      ${b}`);
  } else if(/<div\s+id="root"\s*>\s*<\/div>/i.test(html)) {
    html=html.replace(/<div\s+id="root"\s*>\s*<\/div>/i,()=>`<div id="root"><div id="boot" role="status">\n${ssr}\n      </div></div>`);
  }
  return Buffer.from(html,'utf8');
}
export function packagePhp({runtime,bundle,client,nodeDir,wasmDir,containerEnginesDir,notices,out,operator,readme,template=false,templateClient=false,permissionMode='prompt',websocketDir,htaccess,privateDir,startHere,serveGuide,explainer,runnerDir}) {
  if(privateDir&&(!template||!templateClient||!htaccess||!startHere||!serveGuide))throw new Error('The private variant is a template with its own htaccess and guides');
  const entries={};
  const add=(name,file)=>{entries[name]=readFileSync(file);};
  function tree(dir,prefix,skip=[]) {
    const items=readdirSync(dir,{withFileTypes:true}).sort((a,b)=>(a.name<b.name?-1:a.name>b.name?1:0));
    for(const item of items) {
      if(skip.includes(item.name)||item.name.endsWith('.map'))continue;
      if(item.isSymbolicLink())throw new Error('Package input contains symlink');
      const file=join(dir,item.name),name=prefix+item.name;
      if(item.isDirectory())tree(file,name+'/',skip);else if(item.isFile())add(name,file);
    }
  }
  // The served variant's page is index.php rendered from private/shell.html; a
  // built index.html beside it would be a page with no boot configuration.
  // A packaged single-app dist carries its own README.md (the static archive's
  // explainer); this archive has its own front door, so that one stays out.
  tree(runtime,'webroot/',['app.softn','runtime.config.json','.htaccess','PREVIEW-BUILD.json','.vite','README.md','DEPLOYMENT.md','THIRD-PARTY-INVENTORY.json',...(privateDir?['index.html']:[])]);
  if(privateDir){for(const name of ['index.php','softn-serve.php'])if(!entries['webroot/'+name])throw new Error('Served runtime missing '+name);}
  else if(!entries['webroot/index.html'])throw new Error('Runtime page missing');
  // Populate webroot notices directly when the standalone build did not copy them into dist/.
  const repoRoot=join(here,'../..');
  for(const name of ['LICENSE','NOTICE']){if(!entries['webroot/'+name]&&existsSync(join(repoRoot,name)))add('webroot/'+name,join(repoRoot,name));}
  if(!entries['webroot/THIRD-PARTY-NOTICES.txt']&&existsSync(join(notices,'THIRD-PARTY-NOTICES.txt')))add('webroot/THIRD-PARTY-NOTICES.txt',join(notices,'THIRD-PARTY-NOTICES.txt'));
  if(!entries['webroot/THIRD-PARTY-NOTICES.txt']) {
    const genTmp=mkdtempSync(join(tmpdir(),'softn-host-notices-'));
    try {
      execFileSync(process.execPath,[join(repoRoot,'scripts/licenses/generate-third-party-notices.mjs'),'--out-dir',genTmp],{cwd:repoRoot,stdio:'ignore'});
      if(existsSync(join(genTmp,'THIRD-PARTY-NOTICES.txt')))add('webroot/THIRD-PARTY-NOTICES.txt',join(genTmp,'THIRD-PARTY-NOTICES.txt'));
    } finally { rmSync(genTmp,{recursive:true,force:true}); }
  }
  for(const name of ['LICENSE','NOTICE','THIRD-PARTY-NOTICES.txt'])if(!entries['webroot/'+name])throw new Error('Runtime notices missing');
  tree(join(here,'runtime'),'backend/');
  if(websocketDir)tree(websocketDir,'backend/vendor/ws/');else delete entries['backend/websocket.mjs'];
  add('webroot/api.php',join(here,'api.php'));add('webroot/.htaccess',htaccess??join(here,'htaccess'));
  add('README-RUNTIME.md',join(here,'README.md'));if(readme)add('START-HERE.md',readme);
  const guideName=explainer?'DEPLOYMENT.md':'START-HERE.md';
  add('LIVE_UPDATES.md',join(here,'LIVE_UPDATES.md'));
  if(privateDir) {
    // The generated secret and digest cache are a deployment's, never shipped.
    tree(privateDir,'private/',['secret.key','digest.cache']);
    for(const name of ['app.softn','serve.config.php','shell.html','.htaccess'])if(!entries['private/'+name])throw new Error('Private directory missing '+name);
    add(guideName,startHere);add('DEPLOYMENT-SERVE.md',serveGuide);
  } else if(template&&templateClient) {
    add('webroot/app.softn',join(runtime,'app.softn'));
    add('webroot/runtime.config.json',join(runtime,'runtime.config.json'));
    add(guideName,join(here,'SINGLE_APP_DEPLOYMENT.md'));
  }
  if(explainer)add('README.md',explainer);
  add('backend/bin/node',join(nodeDir,'bin/node'));add('backend/licenses/NODE-LICENSE.txt',join(nodeDir,'LICENSE'));
  const elf=entries['backend/bin/node'];if(elf.subarray(0,4).toString('hex')!=='7f454c46'||elf.readUInt16LE(18)!==62)throw new Error('Expected Linux x86-64 Node');
  if(runnerDir) {
    add('backend/bin/'+RUNNER_BINARY,join(runnerDir,RUNNER_BINARY));add('backend/licenses/'+RUNNER_NOTICES,join(runnerDir,RUNNER_NOTICES));
    const runner=entries['backend/bin/'+RUNNER_BINARY];if(runner.subarray(0,4).toString('hex')!=='7f454c46'||runner.readUInt16LE(18)!==62)throw new Error('Expected Linux x86-64 softn-runner');
  }
  tree(notices,'backend/licenses/native/');
  let prunedRuntime=null;
  let backendEngineFilter=null;
  if(!template) {
    const manifest=JSON.parse(readFileSync(join(bundle,'manifest.json'),'utf8'));
    const clientBytes=readFileSync(client),clientFiles=unzipSync(clientBytes),publicManifest=JSON.parse(Buffer.from(clientFiles['manifest.json']).toString());
    if(publicManifest.id!==manifest.id||publicManifest.server||publicManifest.backend||Object.keys(clientFiles).some(n=>n.startsWith('server/')||n.startsWith('backend/')))throw new Error('Client identity/private-server isolation mismatch');
    tree(bundle,'backend/app/');entries['webroot/app.softn']=clientBytes;
    entries['webroot/runtime.config.json']=Buffer.from(JSON.stringify(deploymentConfig(manifest,clientBytes,permissionMode),null,2));
    if(entries['webroot/index.html'])entries['webroot/index.html']=bakeAppSeoHtml(entries['webroot/index.html'],publicManifest,clientFiles);
    if(operator)tree(operator,'backend/operator/');
    prunedRuntime=pruneHostedRuntimeEntries(entries,{...publicManifest,backend:manifest.backend,server:manifest.server},clientFiles,{webrootPrefix:'webroot/',remoteHostedBackend:Boolean(manifest.backend||manifest.server)});
    const backendType=String(manifest.backend?.runtime??manifest.backend?.type??manifest.server?.runtime??'').toLowerCase();
    const backendServerKeys=Object.keys(entries).filter(n=>/^backend\/app\/(?:backend|server)\//i.test(n));
    backendEngineFilter=new Set();
    if(backendType.includes('php')||(!backendType&&backendServerKeys.some(n=>/\.php$/i.test(n))))backendEngineFilter.add('zipp-php');
    if(backendType.includes('ts')||backendType.includes('typescript')||(!backendType&&backendServerKeys.some(n=>/\.(?:ts|tsx|mts)$/i.test(n))))backendEngineFilter.add('zipp-typescript');
    if(backendType.includes('rust')||(!backendType&&backendServerKeys.some(n=>/\.(?:rs|wasm)$/i.test(n))))backendEngineFilter.add('zipp-rust');
  }
  add('backend/wasm/zipp_wasm.mjs',join(wasmDir,'zipp_wasm.js'));
  const original=readFileSync(join(wasmDir,'zipp_wasm_bg.wasm'));
  entries['backend/wasm/zipp_wasm_bg.wasm']=capWasmMemory(original,4096);
  if(containerEnginesDir) {
    for(const engineBase of ['zipp-php','zipp-typescript','zipp-rust']) {
      if(backendEngineFilter&&!backendEngineFilter.has(engineBase))continue;
      for(const ext of ['.wasm','.glue.js']) {
        const src=join(containerEnginesDir,engineBase+ext);
        try {
          const bytes=readFileSync(src);
          entries['backend/wasm/container/'+engineBase+ext]=ext==='.wasm'?capWasmMemory(bytes,4096):bytes;
        } catch(e) {
          if(e.code!=='ENOENT')throw e;
        }
      }
    }
  }
  entries['backend/.htaccess']=Buffer.from('Require all denied\n');
  entries['BUILD-INFO.json']=Buffer.from(JSON.stringify({runtime:privateDir?'SoftN PHP-served single app + on-demand ZIPP WASM':'SoftN PHP + on-demand ZIPP WASM',template,backendOptional:templateClient,privateArchive:!!privateDir,builtAt:new Date(process.env.SOURCE_DATE_EPOCH?Number(process.env.SOURCE_DATE_EPOCH)*1000:Date.now()).toISOString(),wasmOriginalSha256:sha(original),wasmPackagedSha256:sha(entries['backend/wasm/zipp_wasm_bg.wasm']),wasmMemoryMaxBytes:268435456,instructionBudget:5000000,phpDeadlineSeconds:25,processSlotsDefault:4,processSlotsMax:16,
    ...(prunedRuntime?{prunedUnusedRuntimeAssets:prunedRuntime.removed.length,prunedUnusedRuntimeBytes:prunedRuntime.savedBytes}:{}),
    // softn-runner's own ceilings, which the operator sets (request.php
    // softn_request_memory_mb; the runner's limits.rs): its engine's memory
    // and SQLite's each `requestMemoryMb` MiB, a script's heap 64 MiB less.
    // The wasmMemoryMaxBytes above is backend/wasm's, the engine Node runs;
    // softn-runner carries its engine inside it.
    softnRunner:runnerDir?{file:'backend/bin/'+RUNNER_BINARY,sha256:sha(entries['backend/bin/'+RUNNER_BINARY]),requestMemoryMb:{default:256,min:128,max:1024}}:null},null,2)+'\n');
  if(Object.keys(entries).some(n=>n.includes('/private/')||n.endsWith('.sqlite')||n.endsWith('backend.json')||n.endsWith('secret.key')||n.endsWith('digest.cache')))throw new Error('Live state in archive');
  const sortedEntries=Object.entries(entries).sort(([a],[b])=>(a<b?-1:a>b?1:0));
  entries['SHA256SUMS.txt']=Buffer.from(sortedEntries.map(([n,b])=>sha(b)+'  '+n).join('\n')+'\n');
  // The shared release writer: stores what is already compressed, deflates
  // the rest, reads the file back and compares every entry, writes .sha256.
  // The Node binary and softn-runner keep their executable mode through the unix attributes.
  const stamp=new Date(process.env.SOURCE_DATE_EPOCH?Number(process.env.SOURCE_DATE_EPOCH)*1000:Date.now());
  const executable=new Set(['backend/bin/node','backend/bin/'+RUNNER_BINARY]);
  const result=writeArchive(Object.fromEntries(Object.entries(entries).map(([n,b])=>[n,{data:b,mode:executable.has(n)?0o100755:0o100644}])),out,{stamp,level:6});
  console.log(out+'\n'+result.size+' bytes; '+result.entries.length+' entries verified; SHA256 '+result.sha256);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2),option=name=>{const i=args.indexOf('--'+name);return i<0?undefined:resolve(args[i+1]);};
  const options=Object.fromEntries(['runtime','bundle','client','node-dir','wasm-dir','notices','out','operator','readme','runner-dir'].map(n=>[n.replace(/-([a-z])/g,(_,c)=>c.toUpperCase()),option(n)]));
  options.template=args.includes('--template');
  options.permissionMode=args.includes('--preapprove-permissions')?'preapproved':'prompt';
  for(const key of ['runtime','nodeDir','wasmDir','notices','out',...(options.template?[]:['bundle','client'])])if(!options[key])throw new Error('Missing option: '+key);
  packagePhp(options);
}
