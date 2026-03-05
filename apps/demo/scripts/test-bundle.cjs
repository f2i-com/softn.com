/**
 * Test bundle processing - simulates what softn-web does
 */
const fs = require('fs');
const fflate = require('fflate');

const bundlePath = process.argv[2] || 'apps/demo/bundles/Showcase.softn';
const data = fs.readFileSync(bundlePath);
console.log('Bundle:', bundlePath, '- Size:', data.length, 'bytes');

const unzipped = fflate.unzipSync(new Uint8Array(data));
const decoder = new TextDecoder();

// List files
const files = Object.keys(unzipped);
console.log('Files:', files.join(', '));

// Parse manifest
const manifest = JSON.parse(decoder.decode(unzipped['manifest.json']));
console.log('App:', manifest.name, 'v' + manifest.version);
console.log('Main:', manifest.main);

function resolvePath(basePath, relativePath) {
  const baseParts = basePath.split('/');
  baseParts.pop();
  const relativeParts = relativePath.split('/');
  for (const part of relativeParts) {
    if (part === '..') {
      baseParts.pop();
    } else if (part !== '.') {
      baseParts.push(part);
    }
  }
  return baseParts.join('/');
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Process bundle (same as bundleProcessor.ts)
let fullSource = decoder.decode(unzipped[manifest.main]);
if (!fullSource) {
  console.error('ERROR: Main file not found!');
  process.exit(1);
}

// Step 1: Inline logic
const logicMatch = fullSource.match(/<logic\s+src=["']([^"']+)["']\s*\/>/);
if (logicMatch) {
  const logicPath = resolvePath(manifest.main, logicMatch[1]);
  console.log('Logic:', logicMatch[1], '->', logicPath);
  const logicContent = decoder.decode(unzipped[logicPath]);
  if (logicContent) {
    fullSource = fullSource.replace(
      /<logic\s+src=["'][^"']+["']\s*\/>/,
      '<logic>\n' + logicContent + '\n</logic>'
    );
    console.log('  Logic inlined OK (' + logicContent.length + ' chars)');
  } else {
    console.error('  ERROR: Logic file not found!');
  }
}

// Step 2: Resolve imports
const importRegex = /<import\s+(\w+)\s+from=["']([^"']+)["']\s*\/>/g;
const imports = [];
let match;
while ((match = importRegex.exec(fullSource)) !== null) {
  const resolvedPath = resolvePath(manifest.main, match[2]);
  const content = decoder.decode(unzipped[resolvedPath]);
  if (content) {
    imports.push({ name: match[1], path: resolvedPath, content });
    console.log('Import:', match[1], '->', resolvedPath, 'OK');
  } else {
    console.error('Import:', match[1], '->', resolvedPath, 'MISSING!');
  }
}

// Remove import statements
fullSource = fullSource.replace(/<import\s+\w+\s+from=["'][^"']+["']\s*\/>\n?/g, '');

// Replace component usages
for (const imp of imports) {
  const templateContent = imp.content
    .replace(/^\/\/[^\n]*\n/gm, '')
    .trim();

  const escapedName = escapeRegex(imp.name);
  const selfClosingRegex = new RegExp(`<${escapedName}\\s*/>`, 'g');
  const beforeLen = fullSource.length;
  fullSource = fullSource.replace(selfClosingRegex, templateContent);

  const pairedRegex = new RegExp(`<${escapedName}[^>]*>.*?</${escapedName}>`, 'gs');
  fullSource = fullSource.replace(pairedRegex, templateContent);

  const afterLen = fullSource.length;
  if (afterLen > beforeLen) {
    console.log('  Replaced <' + imp.name + ' /> (' + templateContent.length + ' chars inlined)');
  } else {
    console.warn('  WARNING: <' + imp.name + ' /> not found in source!');
  }
}

console.log('\nFinal source length:', fullSource.length, 'chars');

// Check for unresolved tags
const unresolvedImports = fullSource.match(/<import\s+\w+/g);
if (unresolvedImports) {
  console.error('ERROR: Unresolved imports:', unresolvedImports);
}

// Check for component tags that weren't replaced
for (const imp of imports) {
  const remaining = fullSource.match(new RegExp(`<${imp.name}[\\s/>]`, 'g'));
  if (remaining) {
    console.error('ERROR: Unreplaced <' + imp.name + '> found:', remaining.length, 'occurrences');
  }
}

// Try to find any obvious syntax issues
const logicBlockMatch = fullSource.match(/<logic>([\s\S]*?)<\/logic>/);
if (logicBlockMatch) {
  console.log('\nLogic block: ' + logicBlockMatch[1].length + ' chars');
  // Check for syntax errors in logic
  try {
    new Function(logicBlockMatch[1]);
    console.log('Logic syntax: OK (parseable as JS)');
  } catch(e) {
    console.error('Logic syntax ERROR:', e.message);
  }
}

// Check for <style> block
const styleMatch = fullSource.match(/<style>([\s\S]*?)<\/style>/);
if (styleMatch) {
  console.log('Style block: ' + styleMatch[1].length + ' chars');
}

// Write processed source for inspection
fs.writeFileSync('apps/demo/bundles/Showcase.processed.txt', fullSource);
console.log('\nProcessed source written to apps/demo/bundles/Showcase.processed.txt');
