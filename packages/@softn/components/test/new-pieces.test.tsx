/**
 * DescriptionList, ButtonGroup, Field and Confirm, and AvatarGroup and
 * TagGroup as tags.
 *
 * Each is something the apps in this repository lay out by hand: a row of
 * two Texts for every field of a record (the most repeated pattern in them),
 * a row of buttons with a gap, a Text above and below a control that has no
 * label of its own, a Modal with two buttons to ask "are you sure?".
 *
 * They are tested as components and through `.ui` source with core's
 * renderer, which is how an app reaches them and where two of them did not
 * work: AvatarGroup sized its avatars by cloning props onto its children,
 * which from a page are error boundaries, and counted the rows of an
 * `#each` as one child.
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComponentRegistry, parse, renderDocument, type SoftNComponent, type SoftNRenderContext } from '@softn/core';
import { act } from 'react';
import { click, mount } from './dom';
import { builtinComponents } from '../src/registry';
import { DescriptionList } from '../src/display/DescriptionList';
import { ButtonGroup } from '../src/form/ButtonGroup';
import { Button } from '../src/form/Button';
import { Field } from '../src/form/Field';
import { Confirm } from '../src/feedback/Confirm';
import { Avatar, AvatarGroup } from '../src/display/Avatar';

const registry = new ComponentRegistry();
registry.registerAll(builtinComponents as unknown as Record<string, SoftNComponent>);

function context(state: Record<string, unknown>, extra: Partial<SoftNRenderContext> = {}): SoftNRenderContext {
  return { state, setState: () => {}, data: {}, props: {}, computed: {}, functions: {}, asyncFunctions: {}, ...extra } as SoftNRenderContext;
}

/** A page of `source`, mounted. */
function page(source: string, state: Record<string, unknown> = {}, extra: Partial<SoftNRenderContext> = {}) {
  const doc = parse(source);
  expect(doc.diagnostics ?? [], source).toEqual([]);
  return mount(<>{renderDocument(doc, context(state, extra), registry)}</>);
}

const markup = (element: React.ReactElement) => renderToStaticMarkup(element);

/** A key pressed with nothing in particular focused, as Escape in a dialog is. */
function press(key: string): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}
const texts = (root: Element, selector: string) => Array.from(root.querySelectorAll(selector)).map((el) => el.textContent ?? '');

describe('DescriptionList', () => {
  it('draws a list of fields as a description list', () => {
    const { container, unmount } = mount(
      <DescriptionList items={[{ label: 'Status', value: 'Shipped' }, { label: 'Total', value: 42, hint: 'Including tax' }]} />
    );
    expect(container.querySelector('dl')).not.toBeNull();
    expect(texts(container, 'dt')).toEqual(['Status', 'Total']);
    expect(texts(container, 'dd')).toEqual(['Shipped', '42Including tax']);
    unmount();
  });

  it('takes the record itself, its keys as the labels', () => {
    const { container, unmount } = mount(<DescriptionList items={{ Name: 'Ada', Team: 'Engines', Active: true }} />);
    expect(texts(container, 'dt')).toEqual(['Name', 'Team', 'Active']);
    expect(texts(container, 'dd')).toEqual(['Ada', 'Engines', 'Yes']);
    unmount();
  });

  it('shows a dash for a value that is not there, and says what is in a list', () => {
    const { container, unmount } = mount(
      <DescriptionList
        items={[
          { label: 'Phone', value: null },
          { label: 'Notes', value: '' },
          { label: 'Tags', value: ['a', 'b'] },
          { label: 'None', value: [] },
          { label: 'Zero', value: 0 },
          { label: 'Off', value: false },
        ]}
      />
    );
    expect(texts(container, 'dd')).toEqual(['—', '—', 'a, b', '—', '0', 'No']);
    unmount();
  });

  it('uses the text it is given for an empty value', () => {
    expect(markup(<DescriptionList items={{ Phone: null }} emptyText="Not set" />)).toContain('Not set');
  });

  it('draws nothing for no fields, and skips a hole in the list', () => {
    expect(markup(<DescriptionList />)).toMatch(/^<dl[^>]*><\/dl>$/);
    expect(markup(<DescriptionList items={null as never} />)).toMatch(/^<dl[^>]*><\/dl>$/);
    const { container, unmount } = mount(<DescriptionList items={[null, { label: 'Only', value: 1 }] as never} />);
    expect(texts(container, 'dt')).toEqual(['Only']);
    unmount();
  });

  it('lays several columns out so that they fall to fewer where there is no room', () => {
    const html = markup(<DescriptionList items={{ a: 1, b: 2 }} columns={3} />);
    expect(html).toContain('grid-template-columns:repeat(auto-fill, minmax(max(11rem, calc((100% - 2 * 1.5rem) / 3)), 1fr))');
    expect(markup(<DescriptionList items={{ a: 1 }} />)).toContain('grid-template-columns:minmax(0, 1fr)');
    // A count that is not one: one column, not a broken grid.
    for (const columns of [0, -2, NaN, 99, null]) {
      expect(markup(<DescriptionList items={{ a: 1 }} columns={columns as never} />)).not.toContain('NaN');
    }
    expect(markup(<DescriptionList items={{ a: 1 }} columns={99} />)).toContain('/ 4)');
  });

  it('puts the label beside the value when asked', () => {
    expect(markup(<DescriptionList items={{ a: 1 }} layout="inline" labelWidth="6rem" />)).toContain('grid-template-columns:minmax(0, 6rem) minmax(0, 1fr)');
  });

  it('is fed from state in a page', () => {
    const { container, unmount } = page('<DescriptionList items={[{ label: "Customer", value: order.name }, { label: "Paid", value: order.paid }]} columns={2} />', {
      order: { name: 'Hedy', paid: false },
    });
    expect(texts(container, 'dt')).toEqual(['Customer', 'Paid']);
    expect(texts(container, 'dd')).toEqual(['Hedy', 'No']);
    unmount();
  });
});

/** The buttons that are a group's own children, by their text. */
function buttonsOf(group: Element): string[] {
  return Array.from(group.children)
    .filter((child) => child.tagName === 'BUTTON')
    .map((child) => child.textContent ?? '');
}

describe('ButtonGroup', () => {
  it('is a group with a name, holding its buttons directly', () => {
    const { container, unmount } = mount(
      <ButtonGroup ariaLabel="Range">
        <Button>Day</Button>
        <Button>Week</Button>
      </ButtonGroup>
    );
    const group = container.querySelector('[role="group"]')!;
    expect(group.getAttribute('aria-label')).toBe('Range');
    expect(buttonsOf(group)).toEqual(['Day', 'Week']);
    expect(group.className).toBe('softn-button-group softn-button-group--attached softn-button-group--horizontal');
    unmount();
  });

  it('squares the corners between its buttons over the corners they set themselves', () => {
    const html = markup(<ButtonGroup><Button>A</Button></ButtonGroup>);
    // A Button's own radius is inline, which only !important outranks.
    expect(html).toContain('.softn-button-group--attached button { border-radius: 0 !important;');
    expect(html).toContain('border-top-left-radius: var(--radius-lg, 0.5rem) !important');
    // By type, since a Button draws a style element beside itself and so is
    // not the group's first child; and nothing a server would send escaped.
    const sheet = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
    expect(sheet).toContain('button:first-of-type');
    expect(sheet).not.toMatch(/first-child|last-child|&gt;|&quot;/);
  });

  it('can stand them apart, one above the other, or across the width', () => {
    const apart = markup(<ButtonGroup attached={false}><Button>A</Button></ButtonGroup>);
    expect(apart).toContain('class="softn-button-group softn-button-group--horizontal"');
    expect(apart).toContain('gap:0.5rem');
    expect(markup(<ButtonGroup orientation="vertical"><Button>A</Button></ButtonGroup>)).toContain('flex-direction:column');
    const wide = markup(<ButtonGroup fullWidth><Button>A</Button></ButtonGroup>);
    expect(wide).toContain('softn-button-group--full');
    expect(wide).toContain('width:100%');
  });

  it('holds the buttons a page gives it, each still doing its own thing', () => {
    const pressed: string[] = [];
    const { container, unmount } = page(
      '<ButtonGroup ariaLabel="Range">\n#each (range in ranges)\n<Button @click={() => choose(range)}>{range}</Button>\n#end\n</ButtonGroup>',
      { ranges: ['Day', 'Week', 'Month'] },
      { functions: { choose: (range) => pressed.push(String(range)) }, asyncFunctions: { choose: (range) => pressed.push(String(range)) } }
    );
    const group = container.querySelector('[role="group"]')!;
    // Directly inside it, so the first and the last of them are the group's ends.
    expect(buttonsOf(group)).toEqual(['Day', 'Week', 'Month']);
    click(group.querySelectorAll('button')[1]);
    expect(pressed).toEqual(['Week']);
    unmount();
  });
});

describe('Field', () => {
  it('names and describes what it wraps', () => {
    const { container, unmount } = mount(
      <Field label="Volume" hint="Applies to every sound.">
        <input type="range" />
      </Field>
    );
    const group = container.querySelector('[role="group"]')!;
    const label = document.getElementById(group.getAttribute('aria-labelledby')!)!;
    const note = document.getElementById(group.getAttribute('aria-describedby')!)!;
    expect(label.textContent).toBe('Volume');
    expect(note.textContent).toBe('Applies to every sound.');
    expect(note.getAttribute('role')).toBeNull();
    expect(group.getAttribute('aria-invalid')).toBeNull();
    expect(container.querySelector('input')).not.toBeNull();
    unmount();
  });

  it('shows an error in place of the hint, and announces it', () => {
    const { container, unmount } = mount(
      <Field label="Volume" hint="Applies to every sound." error="Choose a volume.">
        <input type="range" />
      </Field>
    );
    const group = container.querySelector('[role="group"]')!;
    const note = document.getElementById(group.getAttribute('aria-describedby')!)!;
    expect(note.textContent).toBe('Choose a volume.');
    expect(note.getAttribute('role')).toBe('alert');
    expect(group.getAttribute('aria-invalid')).toBe('true');
    expect(container.textContent).not.toContain('Applies to every sound.');
    unmount();
  });

  it('is marked wrong by error alone, keeping its hint', () => {
    const html = markup(<Field label="Size" hint="In metres." error><input /></Field>);
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('In metres.');
    expect(html).not.toContain('role="alert"');
    // An error that is not one: false, empty, state that has not arrived.
    for (const error of [false, '', null, undefined]) {
      expect(markup(<Field label="Size" error={error as never}><input /></Field>)).not.toContain('aria-invalid');
    }
  });

  it('marks a required field for the eye, without reading the star out', () => {
    const html = markup(<Field label="Name" required><input /></Field>);
    expect(html).toMatch(/<span aria-hidden="true"[^>]*>\*<\/span>/);
  });

  it('has no label to point at when it is given none', () => {
    const html = markup(<Field><input /></Field>);
    expect(html).not.toContain('aria-labelledby');
    expect(html).not.toContain('aria-describedby');
  });

  it('puts the label beside the control when asked', () => {
    expect(markup(<Field label="Name" layout="horizontal" labelWidth="6rem"><input /></Field>)).toContain('grid-template-columns:minmax(0, 6rem) minmax(0, 1fr)');
  });

  it('wraps a control in a page, with an error from state', () => {
    const { container, unmount } = page('<Field label="Volume" hint="Applies to every sound." error={problem}>\n<Slider value={volume} />\n</Field>', {
      volume: 40,
      problem: 'Too loud.',
    });
    expect(container.querySelector('[role="group"]')!.getAttribute('aria-invalid')).toBe('true');
    expect(container.querySelector('[role="alert"]')!.textContent).toBe('Too loud.');
    expect(container.querySelector('[role="slider"]')).not.toBeNull();
    unmount();
  });
});

describe('Confirm', () => {
  const dialog = () => document.querySelector('[role="dialog"]');
  const button = (name: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent === name) as HTMLButtonElement;

  it('asks nothing while it is closed', () => {
    const { unmount } = mount(<Confirm title="Delete this note?" />);
    expect(dialog()).toBeNull();
    unmount();
  });

  it('asks the question with both answers, the one that changes nothing first', () => {
    const { unmount } = mount(<Confirm open title="Delete this note?" message="This cannot be undone." confirmText="Delete" variant="danger" />);
    expect(dialog()!.textContent).toContain('Delete this note?');
    expect(dialog()!.textContent).toContain('This cannot be undone.');
    const answers = Array.from(dialog()!.querySelectorAll('button')).map((b) => b.textContent);
    expect(answers).toEqual(['Cancel', 'Delete']);
    unmount();
  });

  it('puts the keyboard on the answer that changes nothing', () => {
    // Enter on a dialog that has just opened must not be "Delete". The
    // Modal it is built on focuses the dialog itself, which is one Tab away
    // from either answer; a question is answered from the keyboard, so the
    // focus goes to the safe one.
    const { unmount } = mount(<Confirm open title="Delete this note?" confirmText="Delete" variant="danger" />);
    expect(document.activeElement).toBe(button('Cancel'));
    unmount();
  });

  it('does not take the keyboard back when the page draws again', () => {
    const { rerender, unmount } = mount(<Confirm open title="Delete this note?" confirmText="Delete" />);
    button('Delete').focus();
    rerender(<Confirm open title="Delete this note?" message="Still asking." confirmText="Delete" />);
    expect(document.activeElement).toBe(button('Delete'));
    unmount();
  });

  it('tells the app which answer was given, and closes nothing itself', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { unmount } = mount(<Confirm open title="Leave the table?" confirmText="Leave" onConfirm={onConfirm} onCancel={onCancel} />);
    click(button('Leave'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
    click(button('Cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('takes Escape for the answer that changes nothing', () => {
    const onCancel = vi.fn();
    const { unmount } = mount(<Confirm open onCancel={onCancel} />);
    press('Escape');
    expect(onCancel).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('holds both answers while the action is under way', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { unmount } = mount(<Confirm open loading confirmText="Delete" onConfirm={onConfirm} onCancel={onCancel} />);
    expect(button('Cancel').disabled).toBe(true);
    click(button('Cancel'));
    press('Escape');
    const goAhead = Array.from(dialog()!.querySelectorAll('button'))[1] as HTMLButtonElement;
    click(goAhead);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    unmount();
  });

  it('still asks something when the question has not arrived', () => {
    const { unmount } = mount(<Confirm open title={null as never} confirmText={null as never} cancelText={null as never} />);
    expect(dialog()!.textContent).toContain('Are you sure?');
    expect(Array.from(dialog()!.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Cancel', 'Confirm']);
    unmount();
  });

  it('is opened by state in a page and answers through its events', () => {
    const answers: string[] = [];
    const functions = { remove: () => answers.push('confirm'), keep: () => answers.push('cancel') };
    const source = '<Confirm open={asking} title="Delete this note?" message={"“" + note + "” will be gone."} confirmText="Delete" variant="danger" @confirm={() => remove()} @cancel={() => keep()} />';
    const closed = page(source, { asking: false, note: 'Shopping' }, { functions, asyncFunctions: functions });
    expect(dialog()).toBeNull();
    closed.unmount();
    const open = page(source, { asking: true, note: 'Shopping' }, { functions, asyncFunctions: functions });
    expect(dialog()!.textContent).toContain('“Shopping” will be gone.');
    click(button('Delete'));
    click(button('Cancel'));
    expect(answers).toEqual(['confirm', 'cancel']);
    open.unmount();
  });
});

describe('AvatarGroup', () => {
  /** The avatars drawn, by the name each says. */
  const faces = (root: Element) => Array.from(root.querySelectorAll('[role="img"]')).map((el) => el.getAttribute('aria-label'));

  it('gives the avatars a page puts in it its own size and a border', () => {
    const { container, unmount } = page('<AvatarGroup size="lg">\n<Avatar name="Ada Lovelace" size="xs" />\n<Avatar name="Grace Hopper" />\n</AvatarGroup>');
    const avatars = Array.from(container.querySelectorAll<HTMLElement>('[role="img"]'));
    expect(avatars).toHaveLength(2);
    for (const avatar of avatars) {
      // lg, whatever each was written as; and the ring that parts it from its neighbour.
      expect(avatar.style.width).toBe('48px');
      expect(avatar.style.boxShadow).toContain('0 0 0 2px');
    }
    unmount();
  });

  it('counts the rows of a loop, and says how many it left out', () => {
    const people = ['Ada Lovelace', 'Grace Hopper', 'Hedy Lamarr', 'Katherine Johnson', 'Mary Jackson'].map((name, id) => ({ id, name }));
    const { container, unmount } = page('<AvatarGroup max={3}>\n#each (person in people) key={person.id}\n<Avatar name={person.name} />\n#end\n</AvatarGroup>', { people });
    expect(faces(container).filter((name) => name !== '2 more').sort()).toEqual(['Ada Lovelace', 'Grace Hopper', 'Hedy Lamarr']);
    expect(container.querySelector('[aria-label="2 more"]')!.textContent).toBe('+2');
    unmount();
  });

  it('shows them all when there are no more than the most it shows', () => {
    const { container, unmount } = page('<AvatarGroup max={4}>\n<Avatar name="Ada Lovelace" />\n<Avatar name="Grace Hopper" />\n</AvatarGroup>');
    expect(faces(container).sort()).toEqual(['Ada Lovelace', 'Grace Hopper']);
    expect(container.textContent).not.toContain('+');
    unmount();
  });

  it('works as it did when used from React', () => {
    const { container, unmount } = mount(
      <AvatarGroup max={1} size="sm">
        <Avatar name="Ada Lovelace" />
        <Avatar name="Grace Hopper" />
      </AvatarGroup>
    );
    expect(faces(container)).toContain('1 more');
    expect(container.querySelector<HTMLElement>('[aria-label="Ada Lovelace"]')!.style.width).toBe('32px');
    unmount();
  });

  it('keeps its first avatar inside itself', () => {
    // Every avatar but the last is pulled left over its neighbour; the
    // first has none, and stood that far outside the group.
    const { container, unmount } = page('<AvatarGroup>\n<Avatar name="Ada Lovelace" />\n<Avatar name="Grace Hopper" />\n</AvatarGroup>');
    const group = container.querySelector<HTMLElement>('[role="img"]')!.parentElement!.parentElement!;
    expect(group.style.paddingLeft).toBe('8px');
    unmount();
    const apart = page('<AvatarGroup spacing={4}>\n<Avatar name="Ada Lovelace" />\n<Avatar name="Grace Hopper" />\n</AvatarGroup>');
    const spaced = apart.container.querySelector<HTMLElement>('[role="img"]')!.parentElement!.parentElement!;
    expect(spaced.style.paddingLeft).toBe('0px');
    apart.unmount();
  });

  it('leaves an avatar outside a group as it was written', () => {
    const { container, unmount } = page('<Avatar name="Ada Lovelace" size="xs" />');
    const avatar = container.querySelector<HTMLElement>('[role="img"]')!;
    expect(avatar.style.width).toBe('24px');
    expect(avatar.style.boxShadow).toBe('');
    unmount();
  });
});

describe('TagGroup', () => {
  it('is a tag: a row of tags that wraps', () => {
    const { container, unmount } = page('<TagGroup>\n#each (tag in tags)\n<Tag>{tag}</Tag>\n#end\n</TagGroup>', { tags: ['one', 'two', 'three'] });
    expect(container.textContent).toBe('onetwothree');
    expect(container.innerHTML).toContain('flex-wrap: wrap');
    expect(container.innerHTML).not.toContain('Unknown component');
    unmount();
  });
});
