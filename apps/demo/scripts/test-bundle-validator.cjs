const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { strToU8, zipSync } = require('fflate');

const validator = path.join(__dirname, 'test-bundle.cjs');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-bundle-validator-'));

function writeBundle(name, files, manifest) {
  const archive = {};
  for (const [bundlePath, source] of Object.entries({
    'manifest.json': JSON.stringify(manifest),
    ...files,
  })) {
    archive[bundlePath] = strToU8(source);
  }
  const bundlePath = path.join(tempRoot, `${name}.softn`);
  fs.writeFileSync(bundlePath, Buffer.from(zipSync(archive)));
  return bundlePath;
}

function runValidator(bundlePath, outputPath) {
  const args = [validator, bundlePath];
  if (outputPath) args.push('--write', outputPath);
  return spawnSync(process.execPath, args, { encoding: 'utf8' });
}

try {
  const composedOutput = path.join(tempRoot, 'composed.ui');
  const composed = writeBundle(
    'complete-composition',
    {
      'ui/main.ui': [
        '<import Card from="./Card.ui" />',
        '<logic>import "../logic/main-helper.logic";\nlet mainReady = mainHelper();</logic>',
        '<Card />',
      ].join('\n'),
      'ui/Card.ui': '<logic src="../logic/card/card.logic" /><Text>$& card</Text>',
      'logic/main-helper.logic': 'function mainHelper() { return true; }',
      'logic/card/card.logic': 'import "./helper.logic";\nlet cardReady = cardHelper();',
      'logic/card/helper.logic': 'function cardHelper() { return true; }',
    },
    {
      name: 'Complete composition',
      version: '1.0.0',
      main: 'ui/main.ui',
      files: {
        ui: ['ui/main.ui', 'ui/Card.ui'],
        logic: ['logic/card/card.logic'],
      },
    }
  );
  const composedResult = runValidator(composed, composedOutput);
  assert.strictEqual(composedResult.status, 0, composedResult.stderr || composedResult.stdout);
  const composedSource = fs.readFileSync(composedOutput, 'utf8');
  assert.strictEqual((composedSource.match(/<logic>/g) || []).length, 1);
  assert.match(composedSource, /function mainHelper\(\)/);
  assert.match(composedSource, /function cardHelper\(\)/);
  assert.match(composedSource, /let mainReady = mainHelper\(\)/);
  assert.match(composedSource, /let cardReady = cardHelper\(\)/);
  assert.match(composedSource, /\$& card/);
  console.log('PASS: inline and component logic compose into one complete block');

  const invalidComponent = writeBundle(
    'invalid-component-logic',
    {
      'ui/main.ui': [
        '<logic src="../logic/main.logic" />',
        '<import Card from="./Card.ui" />',
        '<Card />',
      ].join('\n'),
      'ui/Card.ui': '<logic src="../logic/component.logic" /><Text>Card</Text>',
      'logic/main.logic': 'let mainReady = true;',
      // Deliberately not manifest-listed: imported UI logic must still be seen.
      'logic/component.logic': 'let = broken syntax;',
    },
    {
      name: 'Invalid component logic',
      version: '1.0.0',
      main: 'ui/main.ui',
      files: {
        ui: ['ui/main.ui', 'ui/Card.ui'],
        logic: ['logic/main.logic'],
      },
    }
  );
  const invalidResult = runValidator(invalidComponent);
  assert.notStrictEqual(invalidResult.status, 0);
  assert.match(
    `${invalidResult.stdout}\n${invalidResult.stderr}`,
    /Combined logic has invalid JavaScript/
  );
  console.log('PASS: syntax errors in non-manifest component logic fail validation');

  const circular = writeBundle(
    'circular-logic',
    {
      'ui/main.ui': '<logic src="../logic/main.logic" /><Text>Cycle</Text>',
      'logic/main.logic': 'import "./helper.logic";\nlet mainReady = true;',
      'logic/helper.logic': 'import "./main.logic";\nlet helperReady = true;',
    },
    {
      name: 'Circular logic',
      version: '1.0.0',
      main: 'ui/main.ui',
      files: { ui: ['ui/main.ui'], logic: ['logic/main.logic'] },
    }
  );
  const circularResult = runValidator(circular);
  assert.notStrictEqual(circularResult.status, 0);
  assert.match(`${circularResult.stdout}\n${circularResult.stderr}`, /Circular logic import/);
  console.log('PASS: circular logic imports fail before de-duplication');
} finally {
  const resolvedTemp = path.resolve(tempRoot);
  const resolvedParent = path.resolve(os.tmpdir());
  if (path.dirname(resolvedTemp) !== resolvedParent) {
    throw new Error(`Refusing to remove unexpected fixture directory: ${resolvedTemp}`);
  }
  fs.rmSync(resolvedTemp, { recursive: true, force: true });
}
