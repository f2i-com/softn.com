import test from 'node:test';
import assert from 'node:assert/strict';
import {deploymentConfig} from '../package.mjs';
import {createHash} from 'node:crypto';
test('reverse-domain bundle IDs produce valid, stable deployment namespaces',()=>{
  const bytes=Buffer.from('bundle');
  for(const id of ['org.example.app','a'.repeat(150),'Example App','valid-app']) {
    const config=deploymentConfig({id,name:'Example'},bytes);
    assert.match(config.id,/^[a-z0-9][a-z0-9_-]{0,63}$/);
    assert.deepEqual(config,deploymentConfig({id,name:'Example'},bytes));
    assert.equal(config.sha256,createHash('sha256').update(bytes).digest('hex'));
  }
  assert.equal(deploymentConfig({id:'valid-app',name:'Example'},bytes).id,'valid-app');
  assert.notEqual(deploymentConfig({id:'org.example.app',name:'Example'},bytes).id,deploymentConfig({id:'org-example-app',name:'Example'},bytes).id);
});
