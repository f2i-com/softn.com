#!/usr/bin/env node
/**
 * The plain-language explainers a release ships, generated from
 * `release-packages.mjs` so they cannot drift from each other:
 *
 *   README.md         at the root of every archive; the first file a person
 *                     sees after unzipping. `startHere(id, {tag, engine})`.
 *   RELEASE-GUIDE.md  "which download do I need?" for the whole release,
 *                     attached beside the archives. `releaseGuide(...)`.
 *   RELEASE-NOTES.md  the release page body: `.github/release-notes.md` with
 *                     the tag's CHANGELOG.md section and the downloads table
 *                     filled in. `releaseNotes(...)`; a tag with no section
 *                     in CHANGELOG.md is refused, before anything is packaged.
 *
 *   node scripts/release-explainers.mjs --tag v1.2.3 [--out release]
 *
 * writes the last two into --out (default `release/`). The package scripts
 * import `startHere` and write the first into each archive themselves.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DECISIONS,
  PACKAGES,
  checksumInstructions,
  packageById,
  root,
  vendoredEngineLabel,
} from './release-packages.mjs';

export const FRONT_DOOR = 'README.md';
export const NOTES_MARKER = '<!-- downloads -->';
export const CHANGELOG_MARKER = '<!-- changelog -->';

const escapeCell = (s) => s.replace(/\|/g, '\\|');

function context({ tag, engine }) {
  if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) throw new Error(`The tag must look like v1.2.3, not "${tag}".`);
  return { tag, engine: engine ?? vendoredEngineLabel() };
}

function otherName(text, ctx) {
  // `softn-app-static-<tag>.zip` in prose becomes the real file name of this release.
  return text.replace(/<tag>/g, ctx.tag).replace(/<engine>/g, ctx.engine);
}

/** The README.md at the root of one archive: what it is, whether it is the right one, what is inside, how to deploy it. */
export function startHere(id, options) {
  const ctx = context(options);
  const pkg = packageById(id);
  const name = pkg.archive(ctx.tag, ctx.engine);
  const lines = [];
  lines.push(`# Start here: ${pkg.title}`);
  lines.push('');
  lines.push(`This is \`${name}\`, from SoftN ${ctx.tag}. Read this page first; it takes two minutes and says whether this is the download you need and what to do with it.`);
  lines.push('');
  if (pkg.previousName) {
    lines.push(`Before v0.0.13 this download was called \`${otherName(pkg.previousName, ctx)}\`; it is the same package under a clearer name.`);
    lines.push('');
  }
  lines.push('## What this is');
  lines.push('');
  lines.push(otherName(pkg.what, ctx));
  lines.push('');
  lines.push(`${pkg.sizeNote}`);
  lines.push('');
  lines.push('## Is this the right download?');
  lines.push('');
  lines.push('Choose this one if:');
  lines.push('');
  for (const reason of pkg.chooseIf) lines.push(`- ${otherName(reason, ctx)}`);
  lines.push('');
  lines.push('Pick a different one if:');
  lines.push('');
  for (const reason of pkg.notIf) lines.push(`- ${otherName(reason, ctx)}`);
  lines.push('');
  lines.push('`RELEASE-GUIDE.md` on the release page compares all the downloads side by side.');
  lines.push('');
  lines.push('## What is inside');
  lines.push('');
  lines.push('| Folder or file | What it is |');
  lines.push('| --- | --- |');
  for (const item of pkg.inside) lines.push(`| \`${escapeCell(item.path)}\` | ${escapeCell(otherName(item.what, ctx))} |`);
  lines.push('');
  lines.push('## Deploy in five steps');
  lines.push('');
  pkg.steps.forEach((step, i) => lines.push(`${i + 1}. ${otherName(step, ctx)}`));
  lines.push('');
  lines.push('## What you need');
  lines.push('');
  for (const req of pkg.requirements) lines.push(`- ${req}`);
  lines.push('');
  lines.push('## Check the download');
  lines.push('');
  for (const line of checksumInstructions) lines.push(line.replace(/<archive>/g, name));
  lines.push('');
  lines.push('## Read next');
  lines.push('');
  lines.push(`- \`${pkg.guide}\` in this folder is the detailed guide: every setting, every server rule, updating and backups.`);
  for (const guide of pkg.moreGuides) lines.push(`- \`${guide}\`, also in this folder.`);
  lines.push('- The documentation is at https://softn.com/docs/ and the source at https://github.com/f2i-com/softn.com.');
  lines.push('');
  return lines.join('\n');
}

/** The downloads table shared by the release guide and the release notes. */
export function downloadsTable(options) {
  const ctx = context(options);
  const rows = [
    '| Download | What it is | Pick it when |',
    '| --- | --- | --- |',
  ];
  for (const pkg of PACKAGES) {
    const name = pkg.archive(ctx.tag, ctx.engine);
    rows.push(`| \`${name}\` | ${escapeCell(pkg.title)}. ${escapeCell(otherName(pkg.what, ctx))} | ${escapeCell(otherName(pkg.chooseIf[0], ctx))} |`);
  }
  return rows.join('\n');
}

/** RELEASE-GUIDE.md: which download, then one section per archive. */
export function releaseGuide(options) {
  const ctx = context(options);
  const lines = [];
  lines.push(`# SoftN ${ctx.tag}: which download do I need?`);
  lines.push('');
  lines.push('Every archive on this release is a different way to put SoftN, or one SoftN app, on a web host. Each unzips to a folder with a `README.md` at the top that explains that archive on its own. This page is the comparison.');
  lines.push('');
  lines.push('## Decide in five questions');
  lines.push('');
  lines.push('Take the first row that fits.');
  lines.push('');
  lines.push('| If… | Download |');
  lines.push('| --- | --- |');
  for (const d of DECISIONS) {
    const pkg = packageById(d.answer);
    lines.push(`| ${escapeCell(d.question)} | \`${pkg.archive(ctx.tag, ctx.engine)}\` |`);
  }
  lines.push('');
  lines.push('Not on the list: the desktop apps (the SoftN runtime and Builder for Windows, macOS and Linux) are built from this tag\'s sources with `npm run tauri build` and are not attached here; the Rust server host `softn-server` is built with `cargo build --release`.');
  lines.push('');
  lines.push('## The downloads');
  lines.push('');
  lines.push(downloadsTable(ctx));
  lines.push('');
  lines.push('Renamed in v0.0.13 so the names say what they are. If you followed an older link:');
  lines.push('');
  for (const pkg of PACKAGES) if (pkg.previousName) lines.push(`- \`${otherName(pkg.previousName, ctx)}\` is now \`${pkg.archive(ctx.tag, ctx.engine)}\``);
  lines.push('');
  lines.push('Every archive has a `.sha256` file beside it with its checksum. ' + checksumInstructions[1].replace(/^- /, '').replace(/<archive>/g, '<file>') + ' ' + checksumInstructions[2].replace(/^- /, '').replace(/<archive>/g, '<file>'));
  lines.push('');
  for (const pkg of PACKAGES) {
    const name = pkg.archive(ctx.tag, ctx.engine);
    lines.push(`## ${pkg.title}`);
    lines.push('');
    lines.push(`\`${name}\``);
    lines.push('');
    lines.push(otherName(pkg.what, ctx) + ' ' + pkg.sizeNote);
    lines.push('');
    lines.push('**Choose it if:**');
    lines.push('');
    for (const reason of pkg.chooseIf) lines.push(`- ${otherName(reason, ctx)}`);
    lines.push('');
    lines.push('**Not if:**');
    lines.push('');
    for (const reason of pkg.notIf) lines.push(`- ${otherName(reason, ctx)}`);
    lines.push('');
    lines.push('**You need:**');
    lines.push('');
    for (const req of pkg.requirements) lines.push(`- ${req}`);
    lines.push('');
    lines.push(`**Inside:** ${pkg.inside.map((i) => `\`${i.path.split(',')[0].trim()}\``).join(', ')}. Read \`README.md\` first, then \`${pkg.guide}\`.`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * The section of CHANGELOG.md for one tag: the lines under `## <tag>` (the
 * heading may carry a note after the tag) up to the next `## ` heading.
 * Throws when the tag has no section, which is what stops a release.
 */
export function changelogSection(changelog, tag) {
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const heading = (line) => /^## /.test(line);
  const isTag = (line) => {
    const m = line.match(/^## \s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/);
    return m && `v${m[1]}` === tag;
  };
  const start = lines.findIndex(isTag);
  if (start === -1) throw new Error(`CHANGELOG.md has no "## ${tag}" section; write what is new in ${tag} before tagging it`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (heading(lines[i])) { end = i; break; }
  const body = lines.slice(start + 1, end).join('\n').trim();
  if (!body) throw new Error(`the "## ${tag}" section of CHANGELOG.md is empty`);
  return body;
}

/** The release notes body: the template with the changelog section and the downloads table filled in at their markers. */
export function releaseNotes(template, options, changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')) {
  const ctx = context(options);
  for (const marker of [NOTES_MARKER, CHANGELOG_MARKER]) {
    if (!template.includes(marker)) throw new Error(`release notes template has no ${marker} marker`);
  }
  return template
    .replace(CHANGELOG_MARKER, changelogSection(changelog, ctx.tag))
    .replace(NOTES_MARKER, downloadsTable(ctx) + '\n\nEach archive unzips with a `README.md` at the top that explains it; `RELEASE-GUIDE.md` below compares them all.')
    .replace(/RELEASE_TAG/g, ctx.tag);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  const tag = opt('--tag');
  if (!tag) {
    console.error('usage: node scripts/release-explainers.mjs --tag v1.2.3 [--out release]');
    process.exit(1);
  }
  const outDir = path.resolve(root, opt('--out') ?? 'release');
  const ctx = context({ tag, engine: opt('--engine') });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'RELEASE-GUIDE.md'), releaseGuide(ctx));
  const template = fs.readFileSync(path.join(root, '.github/release-notes.md'), 'utf8');
  fs.writeFileSync(path.join(outDir, 'RELEASE-NOTES.md'), releaseNotes(template, ctx));
  console.log(`${path.join(outDir, 'RELEASE-GUIDE.md')}\n${path.join(outDir, 'RELEASE-NOTES.md')}`);
}
