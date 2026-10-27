import {join} from 'node:path';
import {packagePhp} from '../../apps/softn-host-php/package.mjs';
import {prepareBackendInputs,explainerFile,requireStandaloneBuild,runnerDirOption,root} from './single-backend-inputs.mjs';
// The site build leaves a /play/ build in this dist/; that is not the standalone runtime.
requireStandaloneBuild(join(root,'apps/softn-single/dist'));
const {nodeDir,wasmDir,notices,websocketDir,version}=await prepareBackendInputs();
packagePhp({runtime:join(root,'apps/softn-single/dist'),runnerDir:runnerDirOption(),nodeDir,wasmDir,notices,template:true,templateClient:true,websocketDir,explainer:explainerFile('single-backend',version),
  out:join(root,'release','softn-app-static-with-backend-linux-x64-v'+version+'.zip')});
