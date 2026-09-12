// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { MAX_ZIP_INPUT_BYTES } from '@softn/core';
import { selectBundleFile } from './bundleLoader';

afterEach(() => vi.restoreAllMocks());

it('rejects an oversized file before reading its contents', async () => {
  const arrayBuffer = vi.fn();
  const file = { name: 'large.softn', size: MAX_ZIP_INPUT_BYTES + 1, arrayBuffer };
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
    Object.defineProperty(this, 'files', { value: [file] });
    this.dispatchEvent(new Event('change'));
  });
  await expect(selectBundleFile()).rejects.toThrow('maximum file size');
  expect(arrayBuffer).not.toHaveBeenCalled();
});
