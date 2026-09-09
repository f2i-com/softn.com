// release/softn-private-single-php-linux-x64-vVERSION.zip: the PHP-served
// single-app runtime (apps/softn-single-php-serve) together with the optional
// PHP/WASM backend. Three folders: webroot/ (index.php, api.php, the
// runtime's assets), private/ (the archive, its configuration and shell
// template) and backend/ (bundled Linux x64 Node, SQLite and ZIPP WASM). The
// application is served privately with or without the backend; the backend
// is enabled by the operator, as in the static variant.
import fs from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {packagePhp} from '../apps/softn-php/package.mjs';
import {prepareBackendInputs,root} from './single-backend-inputs.mjs';
const app=join(root,'apps/softn-single-php-serve');
const dist=join(app,'dist');
for(const name of ['webroot/index.php','webroot/softn-serve.php','private/shell.html','private/serve.config.php','private/app.softn','private/.htaccess'])
  if(!fs.existsSync(join(dist,name)))throw Error('Build the PHP-served runtime first: missing '+name);
// packagePhp reads the runtime's notices from the webroot it copies; the
// served runtime keeps them a level up, so a staging copy carries them in.
const staging=join(root,'.cache/private-single-php/webroot');
fs.rmSync(staging,{recursive:true,force:true});
fs.cpSync(join(dist,'webroot'),staging,{recursive:true});
execFileSync(process.execPath,[join(root,'scripts/generate-third-party-notices.mjs'),'--out-dir',staging],{cwd:root,stdio:'inherit'});
for(const name of ['LICENSE','NOTICE'])fs.copyFileSync(join(root,name),join(staging,name));
const {nodeDir,wasmDir,notices,websocketDir,version}=await prepareBackendInputs();
packagePhp({runtime:staging,nodeDir,wasmDir,notices,template:true,templateClient:true,websocketDir,
  htaccess:join(app,'htaccess-backend'),privateDir:join(dist,'private'),startHere:join(app,'PRIVATE_DEPLOYMENT.md'),serveGuide:join(root,'docs/SINGLE_APP_PHP_SERVE.md'),
  out:join(root,'release','softn-private-single-php-linux-x64-v'+version+'.zip')});
