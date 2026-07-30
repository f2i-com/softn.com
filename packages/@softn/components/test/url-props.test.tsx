/**
 * URL props on built-in components.
 *
 * Every URL these components render is bundle-supplied — a breadcrumb trail, a
 * record's avatar field, a sprite sheet named in a game's state. React only
 * warns about `javascript:` in an href and emits it regardless, and one click
 * then runs bundle code on the host origin, where the studio's provider keys
 * and every app's `softn:*` and `xdb:*` storage live.
 *
 * The renderer scrubs these props on the way in, so these tests exist for the
 * other caller: an app that uses the components as ordinary React.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from './dom';
import { Breadcrumb } from '../src/navigation/Breadcrumb';
import { Avatar } from '../src/display/Avatar';
import { Image } from '../src/display/Image';
import { Sprite } from '../src/animation/Sprite';
import { SmartCards } from '../src/smart/SmartCards';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('Breadcrumb item hrefs', () => {
  it('never reach the anchor with an executable scheme', () => {
    const { container } = mount(
      <Breadcrumb
        items={[{ label: 'Home', href: 'javascript:alert(1)' }, { label: 'Now' }]}
      />
    );
    expect(container.querySelector('a')).toBeNull();
    expect(container.innerHTML).not.toMatch(/javascript:/i);
  });

  it('still show the label, so the trail stays readable', () => {
    const { container } = mount(
      <Breadcrumb items={[{ label: 'Home', href: 'javascript:alert(1)' }, { label: 'Now' }]} />
    );
    expect(container.textContent).toContain('Home');
  });

  it('keep working for the URLs a trail actually uses', () => {
    const { container } = mount(
      <Breadcrumb
        items={[
          { label: 'Home', href: '/' },
          { label: 'Docs', href: 'https://example.com/docs' },
          { label: 'Now' },
        ]}
      />
    );
    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/', 'https://example.com/docs']);
  });
});

describe('image sources', () => {
  it('Avatar falls back to initials rather than emitting the scheme', () => {
    const { container } = mount(<Avatar src="javascript:alert(1)" name="Ada Lovelace" />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('AL');
  });

  it('Avatar keeps a real picture', () => {
    const { container } = mount(<Avatar src="https://example.com/a.png" name="Ada" />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/a.png');
  });

  it('Image shows its failure panel rather than emitting the scheme', () => {
    const { container } = mount(<Image src="javascript:alert(1)" alt="x" />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('Failed to load');
  });

  it('Image will not fall back to an unsafe fallbackSrc either', () => {
    const { container } = mount(
      <Image src="javascript:alert(1)" fallbackSrc="javascript:alert(2)" alt="x" />
    );
    expect(container.innerHTML).not.toMatch(/javascript:/i);
  });

  it('Image keeps blob: URLs, which is what asset() returns', () => {
    const url = 'blob:http://localhost:1420/abc-123';
    const { container } = mount(<Image src={url} alt="x" />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(url);
  });
});

describe('URLs interpolated into CSS', () => {
  it('Sprite drops an unsafe sheet instead of building a url()', () => {
    const { container } = mount(<Sprite src="javascript:alert(1)" />);
    expect(container.innerHTML).not.toMatch(/javascript:/i);
  });

  it('Sprite still draws a real sheet, including the blob: URL asset() returns', () => {
    const url = 'blob:http://localhost:1420/abc-123';
    const { container } = mount(<Sprite src={url} />);
    expect(container.querySelector('div')?.style.backgroundImage).toContain(url);
  });

  it('SmartCards falls back to initials for an unsafe image field', () => {
    const { container } = mount(
      <SmartCards
        data={[{ name: 'Ada Lovelace', avatar: 'javascript:alert(1)' }]}
        title="name"
        image="avatar"
      />
    );
    expect(container.innerHTML).not.toMatch(/javascript:/i);
    expect(container.textContent).toContain('AL');
  });
});
