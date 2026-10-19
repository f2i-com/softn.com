/**
 * The name a file an app saves is offered under (`files.saveFile`).
 *
 * It kept right-to-left overrides (`report<RLO>fdp.exe` reads as
 * `reportexe.pdf`), C1 controls, trailing dots, Windows device names and
 * every kind of program: a click in an app could leave an `.exe`, `.hta` or
 * `.lnk` in the person's downloads, attributed to the host's site.
 */
import { describe, expect, it } from 'vitest';
import { downloadName } from '../src/runtime/script-runtime';

const RLO = String.fromCharCode(0x202e);
const ZERO_WIDTH = String.fromCharCode(0x200b);
const C1 = String.fromCharCode(0x85);

describe('the name a saved file is offered under', () => {
  it('keeps an ordinary name as it is', () => {
    expect(downloadName('report.pdf')).toBe('report.pdf');
    expect(downloadName('Notes 2026.txt')).toBe('Notes 2026.txt');
    expect(downloadName('export.html')).toBe('export.html');
    expect(downloadName('')).toBe('download');
  });

  it('is a leaf, with no characters that hide what it is', () => {
    expect(downloadName('../.bashrc')).toBe('_.bashrc');
    expect(downloadName(`report${RLO}fdp.exe`)).toBe('reportfdp.exe.txt');
    expect(downloadName(`in${ZERO_WIDTH}voice.pdf`)).toBe('invoice.pdf');
    expect(downloadName(`a${C1}b.txt`)).toBe('a_b.txt');
    expect(downloadName('notes.txt. . ')).toBe('notes.txt');
  });

  it('is never a device name, and never a program', () => {
    expect(downloadName('CON')).toBe('_CON');
    expect(downloadName('lpt1.txt')).toBe('_lpt1.txt');
    for (const name of ['setup.exe', 'run.BAT', 'page.hta', 'link.lnk', 'tool.js', 'script.ps1', 'Mac.app', 'go.sh']) {
      expect(downloadName(name)).toBe(`${name}.txt`);
    }
  });
});
