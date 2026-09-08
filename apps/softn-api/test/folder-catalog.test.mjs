/** Folder discovery, restartable migration and real independent PHP writers. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {zipSync,strToU8}=require('fflate');
const api=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const available=spawnSync('php',['-v']).status===0;
const skip={skip:!available};
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'softn-folders-'));
 const worker=path.join(root,'worker.php');
 fs.writeFileSync(worker,`<?php
putenv('SOFTN_DATA_DIR='.$argv[1]);
foreach(['http','db','catalog','bundle','apps','storage','social'] as $lib)require $argv[2].'/lib/'.$lib.'.php';
$job=json_decode($argv[3],true);$_POST=array_map(fn($v)=>(string)$v,$job['fields']??[]);$_SERVER['REMOTE_ADDR']=$job['ip']??'127.0.0.1';
$r=Request::fromGlobals();
try {
 switch($job['op']) {
 case 'list':echo json_encode(Apps::list([]));break;
 case 'doc':echo json_encode(Catalog::doc($job['slug']));break;
 case 'run':for($i=0;$i<($job['count']??1);$i++){Social::recordRun($r,$job['slug']);Catalog::release();}break;
 case 'comment':echo json_encode(Social::addComment($r,$job['slug']));break;
 case 'rate':echo json_encode(Social::rate($r,$job['slug']));break;
 case 'patch':Apps::patch($job['slug'],$job['fields']);break;
 case 'version':Apps::addVersion($job['slug'],$job['bundle'],'parallel');break;
 case 'publish':echo json_encode(Apps::create($job['bundle'],['name'=>'Concurrent']));break;
 case 'lock':Catalog::boot();file_put_contents($argv[1].'/locked','1');sleep(30);break;
 }
}catch(ApiError $e){fwrite(STDERR,$e->status.':'.$e->getMessage());exit(1);}
`);
 const args=job=>[worker,root,api,JSON.stringify(job)];
 const run=job=>{const r=spawnSync('php',args(job),{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout?JSON.parse(r.stdout):null;};
 const start=job=>spawn('php',args(job),{stdio:['ignore','pipe','pipe']});
 const asyncRun=job=>new Promise((resolve,reject)=>{const p=start(job);let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',reject);p.on('exit',code=>code===0?resolve(out?JSON.parse(out):null):reject(new Error(err)));});
 const add=(slug,version=1,name=slug)=>{const dir=path.join(root,'apps',slug);fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,`v${version}.softn`);fs.writeFileSync(file,zipSync({'manifest.json':strToU8(JSON.stringify({name,version:`${version}.0.0`,main:'ui/main.ui',files:{ui:['ui/main.ui']}})),'ui/main.ui':strToU8('<App><Text>Test</Text></App>')}));return file;};
 return {root,worker,args,run,start,asyncRun,add,close:()=>fs.rmSync(root,{recursive:true,force:true})};
}
test('folders are discovered, metadata is editable, cache is disposable, and removed versions disappear',skip,()=>{
 const f=fixture();try{
  f.add('oceanview',1,'Oceanview');
  assert.equal(f.run({op:'list'}).apps[0].name,'Oceanview');
  const file=path.join(f.root,'apps/oceanview/app.json');
  const initialTime=fs.statSync(file).mtimeMs;f.run({op:'list'});assert.equal(fs.statSync(file).mtimeMs,initialTime,'unchanged requests do not rewrite app.json');
  let doc=JSON.parse(fs.readFileSync(file));
  doc.app.category='games';doc.app.tags=['city'];doc.app.runs=41;fs.writeFileSync(file,JSON.stringify(doc));
  assert.equal(f.run({op:'list'}).apps[0].runs,41);
  assert.equal(f.run({op:'list'}).apps[0].category,'games');
  f.add('oceanview',2);assert.equal(f.run({op:'doc',slug:'oceanview'}).versions.length,2);
  fs.writeFileSync(path.join(f.root,'cache/bundles.json'),'{broken cache');
  assert.equal(f.run({op:'list'}).apps[0].runs,41);
  fs.unlinkSync(path.join(f.root,'apps/oceanview/v2.softn'));
  assert.equal(f.run({op:'list'}).apps[0].version,1);
  f.add('another');assert.equal(f.run({op:'list'}).total,2);
  fs.renameSync(path.join(f.root,'apps/another'),path.join(f.root,'removed-app'));
  assert.equal(f.run({op:'list'}).total,1);
  fs.writeFileSync(file,'{broken authoritative metadata');
  const r=spawnSync('php',f.args({op:'list'}),{encoding:'utf8'});
  assert.equal(r.status,1);assert.match(r.stderr,/503:Invalid JSON/);
  assert.equal(fs.readFileSync(file,'utf8'),'{broken authoritative metadata');
  assert.ok(!fs.existsSync(path.join(f.root,'directory.sqlite')));
 }finally{f.close();}
});
test('parallel processes preserve runs, comments, ratings, patches and unique versions',skip,async()=>{
 const f=fixture();try{
  const bundle=f.add('busy');f.run({op:'list'});
  const jobs=[];
  for(let n=0;n<8;n++)jobs.push(f.asyncRun({op:'run',slug:'busy',count:10,ip:`10.0.0.${n+1}`}));
  for(let n=0;n<6;n++){
   jobs.push(f.asyncRun({op:'comment',slug:'busy',ip:`10.1.0.${n+1}`,fields:{name:`Visitor ${n}`,body:`Comment ${n}`}}));
   jobs.push(f.asyncRun({op:'rate',slug:'busy',ip:`10.1.0.${n+1}`,fields:{stars:4}}));
  }
  jobs.push(f.asyncRun({op:'patch',slug:'busy',fields:{description:'Preserved patch'}}));
  const results=await Promise.allSettled(jobs);for(const r of results)assert.equal(r.status,'fulfilled',r.reason?.message);
  const d=f.run({op:'doc',slug:'busy'});
  assert.equal(d.app.runs,80);assert.equal(d.runsDaily.reduce((n,r)=>n+r.count,0),80);
  assert.equal(d.app.comments,6);assert.equal(new Set(d.comments.map(c=>c.id)).size,6);
  assert.equal(d.app.rating_count,6);assert.equal(d.app.rating_sum,24);assert.equal(d.app.description,'Preserved patch');
  await Promise.all(Array.from({length:4},()=>f.asyncRun({op:'version',slug:'busy',bundle})));
  assert.deepEqual(f.run({op:'doc',slug:'busy'}).versions.map(v=>v.version).sort((a,b)=>a-b),[1,2,3,4,5]);
  const published=await Promise.all(Array.from({length:4},()=>f.asyncRun({op:'publish',bundle})));
  assert.equal(new Set(published.map(p=>p.app.slug)).size,4);
  assert.ok(!fs.existsSync(path.join(f.root,'directory.sqlite')));
 }finally{f.close();}
});
test('a killed lock holder releases the OS lock without damaging JSON',skip,async()=>{
 const f=fixture();try{
  f.add('survivor');f.run({op:'list'});const p=f.start({op:'lock'});
  for(let n=0;n<100&&!fs.existsSync(path.join(f.root,'locked'));n++)await new Promise(r=>setTimeout(r,20));
  assert.ok(fs.existsSync(path.join(f.root,'locked')));p.kill();await new Promise(r=>p.on('exit',r));
  f.run({op:'run',slug:'survivor'});assert.equal(f.run({op:'doc',slug:'survivor'}).app.runs,1);
 }finally{f.close();}
});
test('legacy SQLite migrates once with counters, keys, versions and social history intact',skip,()=>{
 const f=fixture();try{
  f.add('legacy');const setup=path.join(f.root,'legacy.php');
  fs.writeFileSync(setup,`<?php $p=new PDO('sqlite:'.$argv[1].'/directory.sqlite');
$p->exec("CREATE TABLE apps (slug TEXT,name TEXT,runs INTEGER,launches INTEGER,edit_key_hash TEXT);INSERT INTO apps VALUES ('legacy','Old City',17,23,'preserved-hash');
CREATE TABLE versions (slug TEXT,version INTEGER,file TEXT,size INTEGER,sha256 TEXT,manifest_version TEXT,notes TEXT,created_at INTEGER);INSERT INTO versions VALUES ('legacy',1,'v1.softn',0,'','1.0.0','original notes',123);
CREATE TABLE comments (slug TEXT,id INTEGER,name TEXT,body TEXT,visitor TEXT,hidden INTEGER,created_at INTEGER);INSERT INTO comments VALUES ('legacy',42,'Mayor','Keep me','visitor',0,123);
CREATE TABLE ratings (slug TEXT,visitor TEXT,stars INTEGER,created_at INTEGER);INSERT INTO ratings VALUES ('legacy','visitor',5,123);
CREATE TABLE runs_daily (slug TEXT,day INTEGER,count INTEGER);INSERT INTO runs_daily VALUES ('legacy',1,17);
CREATE TABLE categories (id TEXT,name TEXT,description TEXT,emoji TEXT,status TEXT,sort INTEGER,created_at INTEGER);INSERT INTO categories VALUES ('special','Special','','','approved',100,123);");`);
  const r=spawnSync('php',[setup,f.root],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
  const original=fs.readFileSync(path.join(f.root,'directory.sqlite'));
  const d=f.run({op:'doc',slug:'legacy'});assert.equal(d.app.runs,17);assert.equal(d.app.launches,23);assert.equal(d.app.edit_key_hash,'preserved-hash');assert.equal(d.comments[0].id,42);assert.equal(d.ratings[0].stars,5);assert.equal(d.versions[0].notes,'original notes');
  f.run({op:'run',slug:'legacy'});assert.equal(f.run({op:'doc',slug:'legacy'}).app.runs,18);
  assert.deepEqual(fs.readFileSync(path.join(f.root,'directory.sqlite')),original);
  assert.ok(fs.existsSync(path.join(f.root,'directory-migrated.json')));
 }finally{f.close();}
});
