/**
 * Copy shell extension DLL to Tauri target folder
 */

const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'shell-extension', 'target', 'release', 'softn_shell_extension.dll');
const destDir = path.join(__dirname, '..', 'src-tauri', 'target', 'release');
const dest = path.join(destDir, 'softn_shell_extension.dll');

// Create target directory if it doesn't exist
fs.mkdirSync(destDir, { recursive: true });

// Copy the DLL
if (fs.existsSync(src)) {
  fs.copyFileSync(src, dest);
  console.log(`Copied shell extension to: ${dest}`);
} else {
  console.error(`Shell extension not found at: ${src}`);
  console.log('Run "npm run build:shell-extension" first');
  process.exit(1);
}
