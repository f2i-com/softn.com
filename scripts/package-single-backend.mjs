import {join} from 'node:path';
import {packagePhp} from '../apps/softn-php/package.mjs';
import {prepareBackendInputs,root} from './single-backend-inputs.mjs';
const {nodeDir,wasmDir,notices,websocketDir,version}=await prepareBackendInputs();
packagePhp({runtime:join(root,'apps/softn-single/dist'),nodeDir,wasmDir,notices,template:true,templateClient:true,websocketDir,
  out:join(root,'release','softn-single-php-linux-x64-v'+version+'.zip')});
