const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const checker = path.join(__dirname, '..', 'bundles', 'PromptlyUnemployed', 'check-audio.cjs');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'softn-audio-validator-'));

function makeWav(durationMs = 100) {
  const sampleRate = 8000;
  const sampleCount = Math.round((sampleRate * durationMs) / 1000);
  const dataSize = sampleCount * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataSize, 40);
  return wav;
}

try {
  for (const directory of [
    'logic',
    'assets/audio/dialogue',
    'assets/audio/music',
    'assets/audio/sfx',
  ]) {
    fs.mkdirSync(path.join(tempRoot, directory), { recursive: true });
  }

  fs.writeFileSync(
    path.join(tempRoot, 'logic', 'data.logic'),
    'let DLG = { a1_s1_test_001: { durationMs: 100, text: "Fixture" } };\n'
  );
  fs.writeFileSync(path.join(tempRoot, 'logic', 'dialogue.logic'), '');
  fs.writeFileSync(path.join(tempRoot, 'logic', 'world.logic'), '');
  fs.writeFileSync(
    path.join(tempRoot, 'logic', 'main.logic'),
    [
      'runDialogue(["a1_s1_test_001"]);',
      'sfx("used");',
      'sfx("missing");',
      'playMusic("used");',
      'playMusic("missing");',
    ].join('\n')
  );

  const wav = makeWav();
  fs.writeFileSync(path.join(tempRoot, 'assets/audio/dialogue/a1_s1_test_001.wav'), wav);
  fs.writeFileSync(path.join(tempRoot, 'assets/audio/sfx/used.wav'), wav);
  fs.writeFileSync(path.join(tempRoot, 'assets/audio/sfx/orphan.wav'), wav);
  fs.writeFileSync(path.join(tempRoot, 'assets/audio/music/mus_used.wav'), wav);
  fs.writeFileSync(path.join(tempRoot, 'assets/audio/music/mus_orphan.wav'), wav);

  const result = spawnSync(process.execPath, [checker, tempRoot], { encoding: 'utf8' });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.notStrictEqual(result.status, 0, output);
  assert.match(output, /missing SFX WAV for sfx\("missing"\)/);
  assert.match(output, /orphaned SFX WAV orphan\.wav/);
  assert.match(output, /missing music WAV for playMusic\("missing"\)/);
  assert.match(output, /orphaned music WAV mus_orphan\.wav/);
  console.log('PASS: Promptly audio validator checks literal SFX/music references both ways');
} finally {
  const resolvedTemp = path.resolve(tempRoot);
  const resolvedParent = path.resolve(os.tmpdir());
  if (path.dirname(resolvedTemp) !== resolvedParent) {
    throw new Error(`Refusing to remove unexpected fixture directory: ${resolvedTemp}`);
  }
  fs.rmSync(resolvedTemp, { recursive: true, force: true });
}
