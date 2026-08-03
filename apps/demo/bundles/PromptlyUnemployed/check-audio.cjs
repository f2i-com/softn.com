// Keep the authored dialogue manifest and the fully voiced asset set in lockstep.
// A missing line otherwise degrades to captions only, while an orphaned WAV adds
// several hundred kilobytes to every downloaded copy of the game.
const fs = require('fs');
const path = require('path');

if (process.argv.length > 3) {
  console.error('Usage: node check-audio.cjs [PromptlyUnemployed source directory]');
  process.exit(1);
}
const root = process.argv[2] ? path.resolve(process.argv[2]) : __dirname;
const dataSource = fs.readFileSync(path.join(root, 'logic', 'data.logic'), 'utf8');
const gameSource = ['dialogue.logic', 'world.logic', 'main.logic']
  .map((name) => fs.readFileSync(path.join(root, 'logic', name), 'utf8'))
  .join('\n');
const dialogueDir = path.join(root, 'assets', 'audio', 'dialogue');
const audioRoot = path.join(root, 'assets', 'audio');

const authored = new Map();
const linePattern = /^\s*([A-Za-z0-9_]+)\s*:\s*\{[^\r\n]*\bdurationMs:\s*(\d+)/gm;
let match;
while ((match = linePattern.exec(dataSource)) !== null) {
  authored.set(match[1], Number(match[2]));
}

const voiced = new Set(
  fs
    .readdirSync(dialogueDir)
    .filter((name) => name.toLowerCase().endsWith('.wav'))
    .map((name) => path.basename(name, path.extname(name)))
);

const problems = [];
for (const id of authored.keys()) {
  if (!voiced.has(id)) problems.push(`missing dialogue WAV for ${id}`);
}
for (const id of voiced) {
  if (!authored.has(id)) problems.push(`orphaned dialogue WAV ${id}.wav`);
}

const referencedLines = new Set(
  [...gameSource.matchAll(/\b(a\d+_s\d+_[a-z]+_\d+)\b/g)].map((entry) => entry[1])
);
for (const id of referencedLines) {
  if (!authored.has(id)) problems.push(`gameplay references unknown dialogue line ${id}`);
}
for (const id of authored.keys()) {
  if (!referencedLines.has(id)) problems.push(`dialogue line ${id} is never used by gameplay`);
}

function literalCallArguments(functionName) {
  const calls = new RegExp(`\\b${functionName}\\s*\\(([^\\r\\n)]*)\\)`, 'g');
  const references = new Set();
  for (const call of gameSource.matchAll(calls)) {
    const literals = /(["'])([^"'\r\n]+)\1/g;
    for (const literal of call[1].matchAll(literals)) references.add(literal[2]);
  }
  return references;
}

// Dialogue filenames are data-driven, but SFX and music cues are authored as
// literal calls. Check both directions so a typo cannot become silent audio and
// an unused cue cannot keep inflating every copy of the 17 MB game bundle.
const referencedSfx = literalCallArguments('sfx');
const referencedMusic = literalCallArguments('playMusic');
const sfxFiles = new Set(
  fs
    .readdirSync(path.join(audioRoot, 'sfx'))
    .filter((name) => name.toLowerCase().endsWith('.wav'))
    .map((name) => path.basename(name, path.extname(name)))
);
const musicFiles = new Set(
  fs
    .readdirSync(path.join(audioRoot, 'music'))
    .filter((name) => name.toLowerCase().endsWith('.wav'))
    .map((name) => path.basename(name, path.extname(name)))
);

for (const cue of referencedSfx) {
  if (!sfxFiles.has(cue)) problems.push(`missing SFX WAV for sfx("${cue}")`);
}
for (const cue of sfxFiles) {
  if (!referencedSfx.has(cue)) problems.push(`orphaned SFX WAV ${cue}.wav`);
}
for (const cue of referencedMusic) {
  const fileStem = `mus_${cue}`;
  if (!musicFiles.has(fileStem)) problems.push(`missing music WAV for playMusic("${cue}")`);
}
for (const fileStem of musicFiles) {
  const cue = fileStem.startsWith('mus_') ? fileStem.slice(4) : null;
  if (!cue || !referencedMusic.has(cue)) problems.push(`orphaned music WAV ${fileStem}.wav`);
}

function wavDurationMs(filePath) {
  const bytes = fs.readFileSync(filePath);
  if (
    bytes.length < 44 ||
    bytes.toString('ascii', 0, 4) !== 'RIFF' ||
    bytes.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('not a RIFF/WAVE file');
  }

  let byteRate = 0;
  let dataBytes = 0;
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const chunkName = bytes.toString('ascii', offset, offset + 4);
    const chunkSize = bytes.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    // The voice bake pipeline emits streaming WAV headers, where RIFF and data
    // use 0xffffffff because the final length was unknown when encoding began.
    // In a finished file the data chunk then occupies the remaining bytes.
    if (chunkName === 'data' && chunkSize === 0xffffffff) {
      dataBytes += bytes.length - dataStart;
      break;
    }
    const dataEnd = dataStart + chunkSize;
    if (dataEnd > bytes.length) throw new Error(`${chunkName} chunk exceeds file length`);
    if (chunkName === 'fmt ' && chunkSize >= 16) byteRate = bytes.readUInt32LE(dataStart + 8);
    if (chunkName === 'data') dataBytes += chunkSize;
    offset = dataEnd + (chunkSize % 2);
  }

  if (byteRate <= 0 || dataBytes <= 0) throw new Error('missing usable fmt or data chunk');
  return (dataBytes / byteRate) * 1000;
}

let wavCount = 0;
for (const directory of ['dialogue', 'music', 'sfx']) {
  const dir = path.join(audioRoot, directory);
  for (const name of fs.readdirSync(dir).filter((entry) => entry.toLowerCase().endsWith('.wav'))) {
    const filePath = path.join(dir, name);
    wavCount += 1;
    try {
      const actualDuration = wavDurationMs(filePath);
      if (!Number.isFinite(actualDuration) || actualDuration <= 0) {
        problems.push(`${directory}/${name} has no playable audio data`);
      }
      if (directory === 'dialogue') {
        const id = path.basename(name, path.extname(name));
        const expectedDuration = authored.get(id);
        if (expectedDuration !== undefined && Math.abs(actualDuration - expectedDuration) > 100) {
          problems.push(
            `${name} is ${Math.round(actualDuration)}ms but data.logic declares ${expectedDuration}ms`
          );
        }
      }
    } catch (error) {
      problems.push(`${directory}/${name}: ${error.message}`);
    }
  }
}

console.log(`checked ${authored.size} voiced lines and ${wavCount} WAV files`);
if (problems.length > 0) {
  for (const problem of problems) console.error(`FAIL ${problem}`);
  process.exit(1);
}
console.log('ALL AUDIO COMPLETE');
