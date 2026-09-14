import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,mkdir,rm,symlink,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadDocument,validateDocument} from '../scripts/validate.mjs';
import {renderBlock,renderPage,routeFor,jsonForHtml,landingData} from '../scripts/render.mjs';
import {buildSite,KIT_ROOT} from '../scripts/build-docs.mjs';
import {createPreviewServer} from '../scripts/serve.mjs';

const doc=await loadDocument();
const schema=JSON.parse(await readFile(join(KIT_ROOT,'content/softn-docs.schema.json'),'utf8'));
const modified=fn=>{const d=structuredClone(doc);fn(d);return d;};
async function temporary(fn){const root=await mkdtemp(join(tmpdir(),'softn-docs-'));try{return await fn(root);}finally{await rm(root,{recursive:true,force:true});}}

test('all 30 pages validate with one index and six navigation groups',()=>{
  assert.equal(doc.pages.length,30);assert.equal(doc.navigation.length,6);assert.equal(doc.pages.filter(p=>!p.slug).length,1);
});
test('duplicate routes are rejected',()=>assert.throws(()=>validateDocument(modified(d=>d.pages[1].slug=d.pages[2].slug),schema),/duplicate slug/));
test('missing related-page references are rejected',()=>assert.throws(()=>validateDocument(modified(d=>d.pages[0].relatedPageIds.push('does-not-exist')),schema),/unknown page/));
test('missing source references are rejected',()=>assert.throws(()=>validateDocument(modified(d=>d.pages[0].sourceIds.push('missing-source')),schema),/unknown source/));
test('unknown content block types are rejected',()=>assert.throws(()=>validateDocument(modified(d=>d.pages[0].sections[0].blocks.push({type:'raw-html',html:'<p>Unsupported</p>'})),schema),/content shape/));
test('unknown JSON fields fail instead of silently disappearing',()=>assert.throws(()=>validateDocument(modified(d=>d.pages[0].typo='example'),schema),/unknown property/));
test('navigation includes each page exactly once',()=>assert.throws(()=>validateDocument(modified(d=>d.navigation[0].pageIds.pop()),schema),/every page exactly once/));
test('duplicate section anchors are rejected',()=>assert.throws(()=>validateDocument(modified(d=>d.pages[0].sections[1].id=d.pages[0].sections[0].id),schema),/duplicate id/));
test('invalid calendar dates are rejected',()=>assert.throws(()=>validateDocument(modified(d=>d.pages[0].updatedAt='2026-02-30'),schema),/invalid date/));
test('route traversal and executable URL schemes are rejected',()=>{
  assert.throws(()=>validateDocument(modified(d=>d.pages[1].slug='../other'),schema),/invalid format/);
  assert.throws(()=>validateDocument(modified(d=>d.sources[0].url='javascript:alert(1)'),schema),/HTTP\(S\)/);
});
test('misaligned table rows are rejected',()=>{
  const bad=modified(d=>{const p=d.pages.find(p=>p.id==='components');p.sections[1].blocks[0].rows[0].pop();});
  assert.throws(()=>validateDocument(bad,schema),/table width mismatch/);
});
test('HTML, code and script-closing sequences are escaped',()=>{
  assert.equal(renderBlock({type:'paragraph',text:'Use <img src=x> and `a < b`.'},doc),'<p>Use &lt;img src=x&gt; and <code>a &lt; b</code>.</p>');
  assert.ok(!jsonForHtml({text:'</script><script>alert(1)</script>'}).includes('</script>'));
  const block=renderBlock({type:'code',language:'html',code:'<b>hello</b>',caption:'Literal source'},doc);
  assert.ok(block.includes('&lt;b&gt;hello&lt;/b&gt;'));
});
test('each document has content, a unique canonical and one h1 without executing JavaScript',()=>{
  const canonicals=new Set();
  for(const page of doc.pages){
    const html=renderPage(doc,page,{css:'/docs/style.css',js:'/docs/script.js'});
    assert.equal((html.match(/<h1\b/g)||[]).length,1);
    assert.ok(html.includes(`<h1 id="article-title">`));
    assert.ok(html.includes('id="section-'+page.sections[0].id+'"'));
    const canonical=html.match(/rel="canonical" href="([^"]+)"/)[1];
    assert.equal(canonical,doc.site.origin+routeFor(doc,page));canonicals.add(canonical);
    const data=JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1]);
    assert.equal(data['@graph'][1]['@type'],'BreadcrumbList');
  }
  assert.equal(canonicals.size,doc.pages.length);
});
test('homepage cards are a compact derivative of the same content',()=>{
  const landing=landingData(doc);assert.equal(landing.cards.length,6);assert.equal(landing.cta.href,'/docs/');
  assert.ok(Buffer.byteLength(JSON.stringify(landing))<10000);
});
test('build preserves an existing homepage and site sitemap',()=>temporary(async root=>{
  await writeFile(join(root,'index.html'),'original homepage');await writeFile(join(root,'sitemap.xml'),'original sitemap');
  const result=await buildSite({outDir:root,writeIntegration:false});
  assert.equal(result.pages,30);assert.equal(await readFile(join(root,'index.html'),'utf8'),'original homepage');
  assert.equal(await readFile(join(root,'sitemap.xml'),'utf8'),'original sitemap');
  const map=await readFile(join(root,'sitemap-docs.xml'),'utf8');assert.equal((map.match(/<url>/g)||[]).length,30);
}));
test('two builds are deterministic',()=>temporary(async root=>{
  await buildSite({outDir:root,writeIntegration:false});
  const first=await readFile(join(root,'docs/index.html'),'utf8');const manifest=await readFile(join(root,'.softn-docs-build.json'),'utf8');
  await buildSite({outDir:root,writeIntegration:false});
  assert.equal(await readFile(join(root,'docs/index.html'),'utf8'),first);assert.equal(await readFile(join(root,'.softn-docs-build.json'),'utf8'),manifest);
}));
test('existing unmanaged docs are not overwritten',()=>temporary(async root=>{
  await mkdir(join(root,'docs'));await writeFile(join(root,'docs/index.html'),'existing documentation');
  await assert.rejects(buildSite({outDir:root,writeIntegration:false}),/unmanaged file/);
  assert.equal(await readFile(join(root,'docs/index.html'),'utf8'),'existing documentation');
}));
test('renamed pages remove only previously generated files',()=>temporary(async root=>{
  await buildSite({outDir:root,writeIntegration:false});await writeFile(join(root,'keep.txt'),'keep');
  const changed=modified(d=>d.pages.find(p=>p.id==='builder').slug='visual-builder');
  await buildSite({doc:changed,outDir:root,writeIntegration:false});
  await assert.rejects(access(join(root,'docs/builder/index.html')));
  await access(join(root,'docs/visual-builder/index.html'));assert.equal(await readFile(join(root,'keep.txt'),'utf8'),'keep');
}));
test('custom origin and nested docs base path are supported',()=>temporary(async root=>{
  await buildSite({outDir:root,origin:'https://docs.example.com',basePath:'/learn/docs/',writeIntegration:false});
  const html=await readFile(join(root,'learn/docs/builder/index.html'),'utf8');
  assert.ok(html.includes('https://docs.example.com/learn/docs/builder/'));assert.ok(html.includes('href="/learn/docs/"'));
}));
test('symlink output directories are refused',()=>temporary(async root=>{
  const real=join(root,'real');await mkdir(real);const link=join(root,'link');await symlink(real,link,'junction'); // a junction needs no privilege on Windows; the type is ignored elsewhere
  await assert.rejects(buildSite({outDir:link,writeIntegration:false}),/symlink/);
}));
test('source directories cannot be build targets',async()=>await assert.rejects(buildSite({outDir:join(KIT_ROOT,'content'),writeIntegration:false}),/source directory/));
test('unsafe previous manifests are refused',()=>temporary(async root=>{
  await writeFile(join(root,'.softn-docs-build.json'),JSON.stringify({tool:'softn-docs-kit',basePath:'/docs/',files:['../outside.txt']}));
  await assert.rejects(buildSite({outDir:root,writeIntegration:false}),/Unsafe path/);
}));
test('preview serves HTML, trailing-slash redirects and real 404 responses',()=>temporary(async root=>{
  await buildSite({outDir:root,writeIntegration:false});
  const server=createPreviewServer(root);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const base=`http://127.0.0.1:${server.address().port}`;
    const ok=await fetch(base+'/docs/builder/');assert.equal(ok.status,200);assert.match(await ok.text(),/<h1/);
    const redirect=await fetch(base+'/docs/builder',{redirect:'manual'});assert.equal(redirect.status,308);assert.equal(redirect.headers.get('location'),'/docs/builder/');
    assert.equal((await fetch(base+'/docs/does-not-exist/')).status,404);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}));
