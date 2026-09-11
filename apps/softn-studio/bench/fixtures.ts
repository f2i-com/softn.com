import type { VFSFile } from '../src/types/studio';

/**
 * Fixed projects for the Studio benchmark: the same bytes every run, from a
 * seeded generator, so two runs on two days measure the code and not the
 * fixture. Three sizes, each a complete .softn-shaped project — manifest,
 * declaration, shell, pages, logic, collections — with binary assets in the
 * two larger ones, since a PNG in the VFS is what makes the JSON paths and
 * the archive paths diverge.
 *
 * Sizes are targets; the exact byte counts are reported with the results.
 */
export interface FixtureSpec {
  name: 'small' | 'medium' | 'large';
  files: number;
  bytes: number;
  binaryAssets: number;
}

export const FIXTURES: readonly FixtureSpec[] = [
  { name: 'small', files: 10, bytes: 20 * 1024, binaryAssets: 0 },
  { name: 'medium', files: 60, bytes: 400 * 1024, binaryAssets: 5 },
  { name: 'large', files: 200, bytes: 2 * 1024 * 1024, binaryAssets: 20 },
];

/** mulberry32: small, seeded, and the same on every engine. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ['item', 'title', 'status', 'owner', 'count', 'label', 'note', 'date', 'value', 'group', 'kind', 'ready', 'draft', 'done', 'open'];

function pick(rand: () => number, list: readonly string[]): string {
  return list[Math.floor(rand() * list.length)];
}

/** A page template padded with plausible markup to about `bytes` characters. */
function pageUi(rand: () => number, index: number, bytes: number): string {
  const lines = [`<Stack direction="vertical" gap="md">`, `  <Heading level={2}>Page ${index}</Heading>`];
  while (lines.join('\n').length < bytes) {
    const word = pick(rand, WORDS);
    lines.push(`  <Card title="${word} ${lines.length}">`);
    lines.push(`    <Text color="muted">${Array.from({ length: 8 }, () => pick(rand, WORDS)).join(' ')}</Text>`);
    lines.push(`    <Button variant="ghost" size="sm" @click={() => go("${word}")}>${word}</Button>`);
    lines.push(`  </Card>`);
  }
  lines.push('</Stack>', '');
  return lines.join('\n');
}

function logicFile(rand: () => number, index: number, bytes: number): string {
  const lines = [`// logic ${index}`, `let page = "home"`, 'function go(id) {', '  page = id', '}'];
  let n = 0;
  while (lines.join('\n').length < bytes) {
    const word = pick(rand, WORDS);
    lines.push(`function ${word}${n++}(x) {`, `  return x + ${Math.floor(rand() * 1000)}`, '}');
  }
  lines.push('');
  return lines.join('\n');
}

function xdbFile(rand: () => number, index: number, bytes: number): string {
  const records: Array<Record<string, unknown>> = [];
  let id = 1;
  const build = () => JSON.stringify({ collection: `c${index}`, records }, null, 2);
  while (build().length < bytes) {
    records.push({ id: String(id++), title: `${pick(rand, WORDS)} ${id}`, status: pick(rand, WORDS), count: Math.floor(rand() * 100) });
  }
  return build();
}

function binary(rand: () => number, bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  // A PNG signature, then noise: enough to be a binary the mime map names.
  out.set([137, 80, 78, 71, 13, 10, 26, 10]);
  for (let i = 8; i < bytes; i++) out[i] = Math.floor(rand() * 256);
  return out;
}

function file(path: string, content: string | Uint8Array, mimeType: string): VFSFile {
  return { path, content, mimeType, lastModified: 1_700_000_000_000, lastModifiedBy: 'user', version: 1 };
}

/** The fixture as a VFS map, in the store's shape, with its exact size. */
export function buildFixture(spec: FixtureSpec): { files: Map<string, VFSFile>; bytes: number; textFiles: number; binaryFiles: number } {
  const rand = prng(spec.files * 7919 + spec.bytes);
  const files = new Map<string, VFSFile>();
  const textCount = spec.files - spec.binaryAssets;
  // Binary assets take a bit under half the bytes in the fixtures that have them.
  const binaryBytesTotal = spec.binaryAssets > 0 ? Math.floor(spec.bytes * 0.45) : 0;
  const binaryEach = spec.binaryAssets > 0 ? Math.floor(binaryBytesTotal / spec.binaryAssets) : 0;
  // The three fixed files (manifest, declaration, shell) are about a kilobyte
  // together; the generated ones share the rest of the target.
  const textEach = Math.floor((spec.bytes - binaryBytesTotal - 1024) / (textCount - 3));

  const fixed = 3; // manifest, permission, main.ui
  const logicCount = Math.max(1, Math.floor(textCount * 0.2));
  const xdbCount = Math.max(1, Math.floor(textCount * 0.15));
  const pageCount = Math.max(1, textCount - fixed - logicCount - xdbCount);

  const pages = Array.from({ length: pageCount }, (_, i) => `ui/pages/page-${i}.ui`);
  const logics = Array.from({ length: logicCount }, (_, i) => (i === 0 ? 'logic/main.logic' : `logic/module-${i}.logic`));
  const xdbs = Array.from({ length: xdbCount }, (_, i) => `xdb/c${i}.xdb`);
  const assets = Array.from({ length: spec.binaryAssets }, (_, i) => `assets/image-${i}.png`);

  files.set(
    'manifest.json',
    file(
      'manifest.json',
      JSON.stringify(
        {
          name: `Bench ${spec.name}`,
          version: '1.0.0',
          description: `A ${spec.name} fixture for the Studio benchmark.`,
          main: 'ui/main.ui',
          target: 'web',
          files: { ui: ['ui/main.ui', ...pages], logic: logics, xdb: xdbs, assets },
        },
        null,
        2,
      ),
      'application/json',
    ),
  );
  files.set('permission.json', file('permission.json', JSON.stringify({ permissions: {} }, null, 2), 'application/json'));
  const imports = pages.map((_, i) => `<import Page${i} from="./pages/page-${i}.ui" />`).join('\n');
  const switches = pages.map((_, i) => `      #if (page === "page-${i}")\n        <Page${i} />\n      #end`).join('\n');
  files.set(
    'ui/main.ui',
    file('ui/main.ui', `${imports}\n\n<logic src="../logic/main.logic" />\n\n<App theme="light" title="Bench">\n  <Container maxWidth="960px">\n    <Stack direction="vertical" gap="lg" padding="xl">\n${switches}\n    </Stack>\n  </Container>\n</App>\n`, 'text/x-softn-ui'),
  );
  pages.forEach((p, i) => files.set(p, file(p, pageUi(rand, i, textEach), 'text/x-softn-ui')));
  logics.forEach((p, i) => files.set(p, file(p, logicFile(rand, i, textEach), 'text/x-softn-logic')));
  xdbs.forEach((p, i) => files.set(p, file(p, xdbFile(rand, i, textEach), 'application/json')));
  assets.forEach((p) => files.set(p, file(p, binary(rand, binaryEach), 'image/png')));

  let bytes = 0;
  let textFiles = 0;
  let binaryFiles = 0;
  for (const f of files.values()) {
    if (typeof f.content === 'string') {
      bytes += new TextEncoder().encode(f.content).length;
      textFiles++;
    } else {
      bytes += f.content.length;
      binaryFiles++;
    }
  }
  return { files, bytes, textFiles, binaryFiles };
}
