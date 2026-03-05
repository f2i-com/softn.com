/**
 * SoftN Bundle CLI
 *
 * Command-line tool for creating and inspecting .softn bundles.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createBundle } from './bundle';
import type { SoftNManifest, SoftNBundleInput, BundleFileInput } from './types';

/**
 * Read a directory recursively and return all files
 */
function readDirectoryRecursive(
  dir: string,
  basePath: string = ''
): Array<{ path: string; content: Buffer }> {
  const files: Array<{ path: string; content: Buffer }> = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      files.push(...readDirectoryRecursive(fullPath, relativePath));
    } else {
      files.push({
        path: relativePath,
        content: fs.readFileSync(fullPath),
      });
    }
  }

  return files;
}

/**
 * Determine file type from extension
 */
function getFileType(filePath: string): BundleFileInput['type'] {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.ui':
      return 'ui';
    case '.logic':
      return 'logic';
    case '.xdb':
      return 'xdb';
    case '.json':
      return filePath === 'manifest.json' ? 'manifest' : 'asset';
    default:
      return 'asset';
  }
}

/**
 * Determine MIME type from extension
 */
function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.ui': 'text/x-softn-ui',
    '.logic': 'text/x-softn-logic',
    '.xdb': 'application/x-softn-xdb',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.html': 'text/html',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.eot': 'application/vnd.ms-fontobject',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * Bundle a directory into a .softn file
 */
export async function bundleDirectory(sourceDir: string, outputPath: string): Promise<void> {
  // Read manifest
  const manifestPath = path.join(sourceDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`manifest.json not found in ${sourceDir}`);
  }

  const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
  const manifest: SoftNManifest = JSON.parse(manifestContent);

  console.log(`Bundling: ${manifest.name} v${manifest.version}`);

  // Read all files
  const rawFiles = readDirectoryRecursive(sourceDir);

  // Convert to bundle files
  const files: BundleFileInput[] = rawFiles.map((file) => {
    const type = getFileType(file.path);
    const mimeType = getMimeType(file.path);
    const isText =
      mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType.includes('xml');

    return {
      path: file.path,
      type,
      content: isText ? file.content.toString('utf-8') : file.content,
      mimeType,
    };
  });

  console.log(`Found ${files.length} files:`);
  const fileCounts = {
    ui: files.filter((f) => f.type === 'ui').length,
    logic: files.filter((f) => f.type === 'logic').length,
    xdb: files.filter((f) => f.type === 'xdb').length,
    asset: files.filter((f) => f.type === 'asset').length,
  };
  console.log(`  - UI files: ${fileCounts.ui}`);
  console.log(`  - Logic files: ${fileCounts.logic}`);
  console.log(`  - XDB files: ${fileCounts.xdb}`);
  console.log(`  - Asset files: ${fileCounts.asset}`);

  // Create bundle
  const bundle: SoftNBundleInput = {
    manifest,
    files,
  };

  const bundleData = await createBundle(bundle);

  // Write to output file
  fs.writeFileSync(outputPath, bundleData);

  const sizeKB = (bundleData.length / 1024).toFixed(2);
  console.log(`\nBundle created: ${outputPath} (${sizeKB} KB)`);
}

/**
 * CLI entry point
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log('SoftN Bundler CLI');
    console.log('');
    console.log('Usage:');
    console.log('  bundle <source-dir> <output.softn>  Create a bundle from a directory');
    console.log('');
    console.log('Examples:');
    console.log('  bundle ./my-app ./my-app.softn');
    console.log('  bundle ./demo-bundle ./demo.softn');
    process.exit(1);
  }

  const command = args[0];

  if (command === 'bundle') {
    const sourceDir = path.resolve(args[1]);
    const outputPath = path.resolve(args[2] || `${path.basename(sourceDir)}.softn`);

    if (!fs.existsSync(sourceDir)) {
      console.error(`Error: Source directory not found: ${sourceDir}`);
      process.exit(1);
    }

    await bundleDirectory(sourceDir, outputPath);
  } else {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }
}

// Run CLI if called directly
if (require.main === module) {
  main().catch((error) => {
    console.error('Error:', error.message);
    process.exit(1);
  });
}
