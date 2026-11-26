/**
 * Round 4 (container host, host-policy.ts): a `srcset` with commas in its addresses, and the
 * name a long file name is saved under.
 */
import { describe, expect, it } from 'vitest';
import { ContainerArchive } from '../src/archive';
import { hostAttributeValue, hostFileName, MAX_FILE_NAME_LENGTH } from '../src/host-policy';

const PERMS = { permissions: { net: { enabled: true, allowed_hosts: ['res.cloudinary.com'] } } };

describe('a srcset', () => {
  it('keeps an address with commas in it whole, as HTML reads it', async () => {
    const archive = await ContainerArchive.open({ 'index.html': '<!doctype html>' });
    const context = { entryPath: 'index.html', archive, permissions: PERMS, netGranted: true };
    const srcset =
      'https://res.cloudinary.com/demo/image/upload/c_scale,w_480/sample.jpg 480w,' +
      ' https://res.cloudinary.com/demo/image/upload/c_scale,w_800/sample.jpg 800w';
    expect(hostAttributeValue('img', 'srcset', srcset, context)).toBe(
      'https://res.cloudinary.com/demo/image/upload/c_scale,w_480/sample.jpg 480w, https://res.cloudinary.com/demo/image/upload/c_scale,w_800/sample.jpg 800w'
    );
    // Commas at an address's end end its candidate.
    expect(
      hostAttributeValue('img', 'srcset', 'https://res.cloudinary.com/a.jpg,, https://res.cloudinary.com/b.jpg 2x', context)
    ).toBe('https://res.cloudinary.com/a.jpg, https://res.cloudinary.com/b.jpg 2x');
  });

  it('still checks every address it puts together again', async () => {
    const archive = await ContainerArchive.open({ 'index.html': '<!doctype html>' });
    const context = { entryPath: 'index.html', archive, permissions: PERMS, netGranted: true };
    // Another host, after a comma inside the address, is the address's: one candidate, refused.
    expect(hostAttributeValue('img', 'srcset', 'https://evil.example/a.jpg,https://res.cloudinary.com/b.jpg 2x', context)).toBeNull();
    expect(hostAttributeValue('img', 'srcset', 'https://res.cloudinary.com/a.jpg 2x, https://evil.example/b.jpg 3x', context)).toBe(
      'https://res.cloudinary.com/a.jpg 2x'
    );
    // A descriptor that is not one is no candidate.
    expect(hostAttributeValue('img', 'srcset', 'https://res.cloudinary.com/a.jpg 2x https://evil.example/b.jpg', context)).toBeNull();
  });
});

describe('the name a file is saved under', () => {
  it('keeps its extension when it is shortened', () => {
    const long = `Quarterly report for ${'the north-east region '.repeat(8)}.pdf`;
    const name = hostFileName(long);
    expect(name.length).toBeLessThanOrEqual(MAX_FILE_NAME_LENGTH);
    expect(name.endsWith('.pdf')).toBe(true);
    expect(name.startsWith('Quarterly report for the north-east region')).toBe(true);
    expect(hostFileName(`${'x'.repeat(300)}.xlsx`)).toBe(`${'x'.repeat(MAX_FILE_NAME_LENGTH - 5)}.xlsx`);
    // A name with no short extension is cut as it was.
    expect(hostFileName('y'.repeat(300))).toBe('y'.repeat(MAX_FILE_NAME_LENGTH));
    // The real end of a name is the one kept, and shown.
    expect(hostFileName(`invoice ${'a'.repeat(140)}.pdf.exe`).endsWith('.exe')).toBe(true);
    expect(hostFileName('report.pdf')).toBe('report.pdf');
  });
});
