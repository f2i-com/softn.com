import {readFile,writeFile,mkdir,lstat,rename,unlink} from 'node:fs/promises';
import {resolve,join,dirname,relative,parse,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {loadDocument,validateDocument} from './validate.mjs';
import {renderPage,renderLanding,landingData,plainText,routeFor,escapeHtml} from './render.mjs';

export const KIT_ROOT = fileURLToPath(new URL('../',import.meta.url));
const manifestName = '.softn-docs-build.json';
const hash = bytes => createHash('sha256').update(bytes).digest('hex').slice(0,12);
const exists = async path => { try {return await lstat(path);} catch(error){if(error.code==='ENOENT')return null;throw error;} };
async function noSymlinks(target) {
  const absolute=resolve(target),root=parse(absolute).root;
  let current=root;
  for(const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current=join(current,part);
    const stat=await exists(current);
    if(stat?.isSymbolicLink())throw new Error(`Refusing symlink output path: ${current}`);
    if(!stat)break;
  }
}
function safeOwnedPath(path,basePath) {
  const prefix=basePath.slice(1);
  return typeof path==='string' && !path.includes('\\') && !path.startsWith('/') && !path.split('/').some(x=>!x||x==='.'||x==='..') && (path==='sitemap-docs.xml'||path.startsWith(prefix));
}
async function atomicWrite(path,data) {
  await noSymlinks(path); await mkdir(dirname(path),{recursive:true});
  const temp=path+'.tmp-'+randomUUID();
  try {await writeFile(temp,data,{flag:'wx'});await rename(temp,path);}
  finally {await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}

/** Build into a web root without overwriting the existing homepage or site sitemap. */
export async function buildSite({doc:provided,input,outDir=join(KIT_ROOT,'dist'),origin,basePath,writeIntegration=true}={}) {
  const doc=structuredClone(provided??await loadDocument(input));
  if(origin)doc.site.origin=origin;
  if(basePath)doc.site.basePath=basePath;
  const schema=JSON.parse(await readFile(join(KIT_ROOT,'content/softn-docs.schema.json'),'utf8'));
  validateDocument(doc,schema);
  outDir=resolve(outDir);
  const sourceDirs=['content','scripts','assets','tests','integration','generated'].map(d=>resolve(KIT_ROOT,d));
  if(outDir===parse(outDir).root || outDir===resolve(KIT_ROOT) || sourceDirs.some(d=>outDir===d||outDir.startsWith(d+sep)))throw new Error('Choose a separate build output directory, not a source directory or filesystem root');
  await noSymlinks(outDir);
  // The stylesheet is @softn/brand's tokens, the @font-face rules for the
  // brand faces copied beside it, then the docs layout, so the pages are
  // drawn from the same variables and type as the site, the runtime, Studio
  // and Builder (see brandAssets). Standalone, without the monorepo, the
  // layout still renders on its own fallbacks.
  const brand=await brandAssets();
  const css=Buffer.concat([Buffer.from(brand.css),await readFile(join(KIT_ROOT,'assets/docs.css'))]);
  const js=await readFile(join(KIT_ROOT,'assets/docs.js'));
  const docsRoot=doc.site.basePath.slice(1);
  const cssPath=`${docsRoot}_assets/docs-${hash(css)}.css`,jsPath=`${docsRoot}_assets/docs-${hash(js)}.js`;
  const assets={css:'/'+cssPath,js:'/'+jsPath};
  const files=new Map([[cssPath,css],[jsPath,js]]);
  for(const [name,bytes] of brand.fonts) files.set(`${docsRoot}_assets/fonts/${name}`,bytes);
  for(const page of doc.pages) {
    const path=routeFor(doc,page).slice(1)+'index.html';
    files.set(path,renderPage(doc,page,assets));
  }
  const index={version:doc.contentVersion,pages:doc.pages.map(page=>({id:page.id,title:page.title,summary:page.summary,href:routeFor(doc,page),text:plainText(page)}))};
  files.set(docsRoot+'search-index.json',JSON.stringify(index)+'\n');
  files.set('sitemap-docs.xml',`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${doc.pages.map(page=>`  <url><loc>${escapeHtml(doc.site.origin+routeFor(doc,page))}</loc><lastmod>${page.updatedAt}</lastmod></url>`).join('\n')}\n</urlset>\n`);
  const manifestPath=join(outDir,manifestName);
  await noSymlinks(manifestPath);
  let previous=null;
  if(await exists(manifestPath)) {
    previous=JSON.parse(await readFile(manifestPath,'utf8'));
    if(previous.tool!=='softn-docs-kit' || !Array.isArray(previous.files) || !/^\/(?:[a-z][a-z0-9-]*\/)+$/.test(previous.basePath))throw new Error('Unrecognised documentation build manifest');
    if(previous.files.some(path=>!safeOwnedPath(path,previous.basePath)))throw new Error('Unsafe path in previous build manifest');
  }
  const owned=new Set(previous?.files??[]);
  // Preflight all destinations and removals before mutating the output tree.
  for(const path of new Set([...files.keys(),...owned])) {
    if(!safeOwnedPath(path,files.has(path)?doc.site.basePath:previous.basePath))throw new Error(`Unsafe generated path: ${path}`);
    const dest=join(outDir,path);await noSymlinks(dest);
    const stat=await exists(dest);
    if(stat && !owned.has(path))throw new Error(`Refusing to overwrite unmanaged file: ${dest}`);
    if(stat && !stat.isFile())throw new Error(`Expected a regular file: ${dest}`);
  }
  await mkdir(outDir,{recursive:true});
  for(const [path,data] of files)await atomicWrite(join(outDir,path),data);
  for(const path of owned)if(!files.has(path))await unlink(join(outDir,path)).catch(error=>{if(error.code!=='ENOENT')throw error;});
  const manifest={tool:'softn-docs-kit',version:1,contentVersion:doc.contentVersion,basePath:doc.site.basePath,origin:doc.site.origin,files:[...files.keys()].sort()};
  await atomicWrite(manifestPath,JSON.stringify(manifest,null,2)+'\n');
  if(writeIntegration) {
    await atomicWrite(join(KIT_ROOT,'generated/landing.json'),JSON.stringify(landingData(doc),null,2)+'\n');
    await atomicWrite(join(KIT_ROOT,'generated/learn-softn.html'),renderLanding(doc)+'\n');
    await atomicWrite(join(KIT_ROOT,'generated/robots-snippet.txt'),`# Merge this line into the EXISTING root robots.txt. Do not replace that file.\nSitemap: ${doc.site.origin}/sitemap-docs.xml\n`);
  }
  const words=doc.pages.reduce((n,page)=>n+plainText(page).split(/\s+/).filter(Boolean).length,0);
  return {pages:doc.pages.length,words,files:files.size,outDir,origin:doc.site.origin,basePath:doc.site.basePath,bytes:[...files.values()].reduce((n,x)=>n+Buffer.byteLength(x),0)};
}

/**
 * What the monorepo's brand package contributes to the stylesheet: its
 * tokens.css verbatim, and @font-face rules for the woff2 files of the
 * three faces it self-hosts (the same imports as packages/@softn/brand/src/
 * fonts.ts), which are copied into _assets/fonts/ and owned by the manifest.
 * Outside the monorepo (no node_modules or brand package beside docs/) the
 * result is empty and docs.css falls back to system faces.
 */
const BRAND_FONTS=[
  {family:'Bricolage Grotesque Variable',file:'@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2',weight:'200 800',style:'normal'},
  {family:'IBM Plex Sans',file:'@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2',weight:'400',style:'normal'},
  {family:'IBM Plex Sans',file:'@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-500-normal.woff2',weight:'500',style:'normal'},
  {family:'IBM Plex Sans',file:'@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2',weight:'600',style:'normal'},
  {family:'IBM Plex Mono',file:'@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2',weight:'400',style:'normal'},
  {family:'IBM Plex Mono',file:'@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2',weight:'500',style:'normal'},
];
export async function brandAssets() {
  const repo=resolve(KIT_ROOT,'..');
  const tokens=join(repo,'packages/@softn/brand/src/tokens.css');
  const fonts=new Map();
  let css='';
  if(await exists(tokens)) css+=(await readFile(tokens,'utf8'))+'\n';
  for(const font of BRAND_FONTS) {
    const path=join(repo,'node_modules',font.file);
    if(!(await exists(path))) continue;
    const name=font.file.slice(font.file.lastIndexOf('/')+1);
    fonts.set(name,await readFile(path));
    css+=`@font-face{font-family:'${font.family}';font-style:${font.style};font-weight:${font.weight};font-display:swap;src:url(fonts/${name}) format('woff2');}\n`;
  }
  return {css,fonts};
}

function args(argv) {
  const options={};
  for(let i=0;i<argv.length;i++) {
    const key=argv[i];
    if(key==='--help'){console.log('node scripts/build-docs.mjs [--input file.json] [--out WEB_ROOT] [--origin https://softn.com] [--base-path /docs/]');return null;}
    const map={'--input':'input','--out':'outDir','--origin':'origin','--base-path':'basePath'};
    if(!map[key]||!argv[i+1]||argv[i+1].startsWith('--'))throw new Error(`Unknown or incomplete argument: ${key}`);
    options[map[key]]=argv[++i];
  }
  if(options.input)options.input=resolve(options.input);
  return options;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {const options=args(process.argv.slice(2));if(options)console.log(JSON.stringify(await buildSite(options),null,2));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
