/**
 * Keyboard, ARIA and theming fixes in the data, display, layout, editor and
 * smart components: each case is something a keyboard or screen-reader user
 * could not do before, or a surface that was unreadable in one of the themes.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, click } from './dom';
import { TreeView } from '../src/data/TreeView';
import { DataGrid } from '../src/data/DataGrid';
import { Table } from '../src/data/Table';
import { Pagination } from '../src/data/Pagination';
import { Tag } from '../src/display/Tag';
import { Progress } from '../src/display/Progress';
import { Spinner } from '../src/display/Spinner';
import { Skeleton } from '../src/display/Skeleton';
import { Badge } from '../src/display/Badge';
import { Icon } from '../src/display/Icon';
import { Avatar, AvatarGroup } from '../src/display/Avatar';
import { Heading } from '../src/display/Heading';
import { Image } from '../src/display/Image';
import { Card } from '../src/layout/Card';
import { Section } from '../src/layout/Section';
import { Split } from '../src/layout/Split';
import { Divider } from '../src/layout/Divider';
import { Sidebar } from '../src/layout/Sidebar';
import { App } from '../src/layout/App';
import { RichTextEditor } from '../src/editors/RichTextEditor';
import { MarkdownEditor } from '../src/editors/MarkdownEditor';
import { SmartTimeline } from '../src/smart/SmartTimeline';
import { SmartGrid } from '../src/smart/SmartGrid';

beforeEach(() => {
  document.body.innerHTML = '';
});

function key(el: Element | null | undefined, k: string, init: KeyboardEventInit = {}): void {
  if (!el) throw new Error(`key ${k}: element not found`);
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
  });
}

/** Everything React logged as an error while `run` ran. */
function consoleErrors(run: () => void): string[] {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    run();
    return spy.mock.calls.map((args) => args.map(String).join(' '));
  } finally {
    spy.mockRestore();
  }
}

describe('TreeView follows the tree pattern', () => {
  const nodes = [
    { id: 'a', label: 'Alpha', children: [{ id: 'a1', label: 'Alpha one' }, { id: 'a2', label: 'Alpha two' }] },
    { id: 'b', label: 'Beta' },
  ];
  const item = (c: HTMLElement, id: string) => c.querySelector<HTMLElement>(`[data-tree-id="${id}"]`)!;

  it('exposes tree, treeitem, level, position and expanded state, with one tab stop', () => {
    const { container } = mount(<TreeView nodes={nodes} ariaLabel="Files" />);
    const tree = container.querySelector('[role="tree"]')!;
    expect(tree.getAttribute('aria-label')).toBe('Files');
    const items = container.querySelectorAll('[role="treeitem"]');
    expect(items).toHaveLength(2);
    expect(item(container, 'a').getAttribute('aria-expanded')).toBe('false');
    expect(item(container, 'a').getAttribute('aria-level')).toBe('1');
    expect(item(container, 'b').getAttribute('aria-posinset')).toBe('2');
    expect(item(container, 'b').hasAttribute('aria-expanded')).toBe(false);
    expect([...items].map((i) => i.getAttribute('tabindex'))).toEqual(['0', '-1']);
  });

  it('opens, walks into and out of a branch, and selects, from the keyboard', () => {
    const onSelect = vi.fn();
    const { container } = mount(<TreeView nodes={nodes} onSelect={onSelect} />);
    item(container, 'a').focus();
    key(item(container, 'a'), 'ArrowRight');
    expect(item(container, 'a').getAttribute('aria-expanded')).toBe('true');
    key(item(container, 'a'), 'ArrowRight');
    expect(document.activeElement).toBe(item(container, 'a1'));
    key(item(container, 'a1'), 'ArrowDown');
    expect(document.activeElement).toBe(item(container, 'a2'));
    expect(item(container, 'a2').getAttribute('aria-level')).toBe('2');
    key(item(container, 'a2'), 'ArrowLeft');
    expect(document.activeElement).toBe(item(container, 'a'));
    key(item(container, 'a'), 'End');
    expect(document.activeElement).toBe(item(container, 'b'));
    key(item(container, 'b'), 'Enter');
    expect(onSelect).toHaveBeenCalledWith('b', nodes[1]);
    key(item(container, 'b'), 'Home');
    key(item(container, 'a'), 'ArrowLeft');
    expect(item(container, 'a').getAttribute('aria-expanded')).toBe('false');
  });

  it('renders an empty tree for nodes that have not arrived', () => {
    const { container } = mount(<TreeView nodes={undefined as never} />);
    expect(container.querySelector('[role="tree"]')).not.toBeNull();
  });
});

describe('DataGrid', () => {
  const columns = [
    { key: 'name', header: 'Name', sortable: true, filterable: true, editable: true, editor: () => <input aria-label="edit" /> },
    { key: 'age', header: <b>Age</b>, filterable: true },
  ];
  const data = [
    { id: 1, name: 'Ada', age: 36 },
    { id: 2, name: 'Linus', age: 28 },
  ];

  it('sorts from a real button and reports aria-sort on the header', () => {
    const onSort = vi.fn();
    const { container } = mount(<DataGrid columns={columns} data={data} sortKey="name" onSort={onSort} />);
    const header = container.querySelector('[role="columnheader"]')!;
    expect(header.getAttribute('aria-sort')).toBe('ascending');
    click(header.querySelector('button'));
    expect(onSort).toHaveBeenCalledWith('name', 'desc');
  });

  it('labels its checkboxes, shows a partial select-all, and selects without a controlling parent', () => {
    const onSelectionChange = vi.fn();
    const { container } = mount(
      <DataGrid columns={columns} data={data} selectionMode="multiple" onSelectionChange={onSelectionChange} />
    );
    const all = container.querySelector<HTMLInputElement>('input[aria-label="Select all rows"]')!;
    const row1 = container.querySelector<HTMLInputElement>('input[aria-label="Select row 1"]')!;
    expect(all).not.toBeNull();
    click(row1);
    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set([1]));
    expect(row1.checked).toBe(true);
    expect(all.indeterminate).toBe(true);
    expect(container.querySelectorAll('[role="row"][aria-selected="true"]')).toHaveLength(1);
  });

  it('selects a row with Enter in single mode and opens an editable cell with Enter', () => {
    const onSelectionChange = vi.fn();
    const { container } = mount(
      <DataGrid
        columns={columns}
        data={data}
        selectionMode="single"
        onSelectionChange={onSelectionChange}
        onCellEdit={() => {}}
      />
    );
    const rows = container.querySelectorAll<HTMLElement>('[role="rowgroup"] [role="row"][tabindex="0"]');
    key(rows[1], 'Enter');
    expect(onSelectionChange).toHaveBeenCalledWith(new Set([2]));
    const cell = container.querySelector<HTMLElement>('[role="cell"][tabindex="0"]')!;
    key(cell, 'Enter');
    expect(container.querySelector('input[aria-label="edit"]')).not.toBeNull();
  });

  it('names the filter toggle and each filter, even for a header that is not text', () => {
    const { container } = mount(<DataGrid columns={columns} data={data} onFilterChange={() => {}} />);
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Show filters"]')!;
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    click(toggle);
    expect(container.querySelector('input[aria-label="Filter Name"]')).not.toBeNull();
    const ageFilter = container.querySelector<HTMLInputElement>('input[aria-label="Filter age"]')!;
    expect(ageFilter.placeholder).not.toContain('[object');
  });

  it('announces loading and survives a zero row height', () => {
    const loading = mount(<DataGrid columns={columns} data={data} loading />);
    expect(loading.container.querySelector('[role="status"]')?.textContent).toBe('Loading...');
    const errors = consoleErrors(() => {
      const { container } = mount(<DataGrid columns={columns} data={data} rowHeight={0} />);
      expect(container.textContent).toContain('Ada');
    });
    expect(errors.filter((e) => /NaN/.test(e))).toEqual([]);
  });
});

describe('Tag', () => {
  it('puts the click and the remove control side by side as real buttons', () => {
    const onClick = vi.fn();
    const onRemove = vi.fn();
    const { container } = mount(
      <Tag onClick={onClick} removable onRemove={onRemove}>
        Design
      </Tag>
    );
    const buttons = container.querySelectorAll('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0].contains(buttons[1])).toBe(false);
    expect(container.querySelector('[role="button"]')).toBeNull();
    expect(buttons[1].getAttribute('aria-label')).toBe('Remove Design');
    click(buttons[1]);
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
    click(buttons[0]);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('Table', () => {
  const columns = [{ key: 'name', header: 'Name', sortable: true }];

  it('renders its empty state for rows that have not arrived', () => {
    const { container } = mount(<Table columns={columns} data={undefined as never} />);
    expect(container.textContent).toContain('No data available');
  });

  it('keeps a clickable row a row, sorts from a header button and names itself from its caption', () => {
    const onSort = vi.fn();
    const onRowClick = vi.fn();
    const { container } = mount(
      <Table columns={columns} data={[{ id: '1', name: 'Ada' }]} onSort={onSort} onRowClick={onRowClick} caption="People" />
    );
    const row = container.querySelector<HTMLElement>('tbody tr')!;
    expect(row.getAttribute('role')).not.toBe('button');
    key(row, 'Enter');
    expect(onRowClick).toHaveBeenCalled();
    click(container.querySelector('th button'));
    expect(onSort).toHaveBeenCalledWith('name', 'asc');
    const table = container.querySelector('table')!;
    const labelledBy = table.getAttribute('aria-labelledby')!;
    expect(document.getElementById(labelledBy)?.textContent).toBe('People');
  });
});

describe('Pagination', () => {
  it('names its controls and marks the current page', () => {
    const { container } = mount(<Pagination currentPage={2} totalPages={5} onPageChange={() => {}} />);
    expect(container.querySelector('nav')?.getAttribute('aria-label')).toBe('Pagination');
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe('2');
    for (const name of ['First page', 'Previous page', 'Next page', 'Last page']) {
      expect(container.querySelector(`button[aria-label="${name}"]`), name).not.toBeNull();
    }
  });

  it('disables Next and Last when there is nothing after this page', () => {
    const empty = mount(<Pagination currentPage={1} totalPages={0} onPageChange={() => {}} />);
    expect(empty.container.querySelector<HTMLButtonElement>('button[aria-label="Next page"]')!.disabled).toBe(true);
    const past = mount(<Pagination currentPage={9} totalPages={3} onPageChange={() => {}} />);
    expect(past.container.querySelector<HTMLButtonElement>('button[aria-label="Last page"]')!.disabled).toBe(true);
    expect(() => mount(<Pagination currentPage={1} totalPages={-4} onPageChange={() => {}} />)).not.toThrow();
  });
});

describe('Progress', () => {
  it('reports a clamped value on a named progressbar and no value while indeterminate', () => {
    const { container } = mount(<Progress value={150} />);
    const bar = container.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute('aria-valuenow')).toBe('100');
    expect(bar.getAttribute('aria-label')).toBe('Progress');
    expect(bar.querySelector('.softn-progress-bar')).not.toBeNull();
    const busy = mount(<Progress indeterminate ariaLabel="Uploading" />);
    const busyBar = busy.container.querySelector('[role="progressbar"]')!;
    expect(busyBar.hasAttribute('aria-valuenow')).toBe(false);
    expect(busyBar.getAttribute('aria-label')).toBe('Uploading');
  });

  it('draws an empty bar, not NaN, for a max of zero', () => {
    const { container } = mount(<Progress value={5} max={0} showLabel labelPosition="outside" />);
    expect(container.innerHTML).not.toContain('NaN');
  });
});

describe('reduced motion rules reach the elements they name', () => {
  it('Spinner', () => {
    const { container } = mount(<Spinner />);
    const root = container.querySelector<HTMLElement>('[role="status"]')!;
    expect(root.classList.contains('softn-spinner')).toBe(true);
    expect(root.style.position).toBe('relative');
    expect(container.querySelector('style')?.textContent).toContain('.softn-spinner');
  });

  it('Skeleton, which is also hidden from assistive technology', () => {
    const { container } = mount(<Skeleton />);
    const el = container.querySelector('.softn-skeleton')!;
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('style')?.textContent).toContain('prefers-reduced-motion');
  });

  it('Badge', () => {
    const { container } = mount(<Badge pulse content={3} />);
    expect(container.querySelector('.softn-badge-pulse')).not.toBeNull();
    expect(container.querySelector('style')?.textContent).toContain('prefers-reduced-motion');
  });

  it('App', () => {
    const { container } = mount(<App>content</App>);
    expect(container.querySelector('style')?.textContent).toMatch(/prefers-reduced-motion[\s\S]*\.softn-app \*/);
  });
});

describe('Skeleton when loading is done', () => {
  it('renders nothing rather than a placeholder for no content', () => {
    const { container } = mount(<Skeleton loading={false} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('RichTextEditor', () => {
  it('draws its toolbar on the surface, not on a gray step, with one tab stop and pressed states', () => {
    const { container } = mount(<RichTextEditor />);
    const toolbar = container.querySelector<HTMLElement>('[role="toolbar"]')!;
    expect(toolbar.style.background).not.toContain('gray-800');
    const buttons = toolbar.querySelectorAll<HTMLButtonElement>('button');
    expect([...buttons].filter((b) => b.tabIndex === 0)).toHaveLength(1);
    expect(buttons[0].getAttribute('aria-pressed')).toBe('false');
    buttons[0].focus();
    key(buttons[0], 'ArrowRight');
    expect(document.activeElement).toBe(buttons[1]);
    expect(buttons[1].tabIndex).toBe(0);
    key(buttons[1], 'End');
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
  });

  it('shows focus on its frame while the text area has it', () => {
    const { container } = mount(<RichTextEditor />);
    const root = container.firstElementChild as HTMLElement;
    const before = root.style.border;
    act(() => {
      container.querySelector<HTMLElement>('[role="textbox"]')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    expect(root.style.border).not.toBe(before);
  });
});

describe('MarkdownEditor', () => {
  it('names its toolbar, buttons and text area, and reports the view mode', () => {
    const { container } = mount(<MarkdownEditor />);
    expect(container.querySelector('[role="toolbar"]')).not.toBeNull();
    const unnamed = [...container.querySelectorAll('button')].filter(
      (b) => !b.getAttribute('aria-label') && !b.textContent?.trim().match(/^[A-Za-z]+$/)
    );
    expect(unnamed).toEqual([]);
    expect(container.querySelector('textarea')?.getAttribute('aria-label')).toBe('Markdown');
    const split = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Split')!;
    expect(split.getAttribute('aria-pressed')).toBe('true');
  });

  it('follows a changed viewMode prop', () => {
    const onViewModeChange = vi.fn();
    const { container, rerender } = mount(<MarkdownEditor viewMode="edit" onViewModeChange={onViewModeChange} />);
    const pressed = () => [...container.querySelectorAll('button[aria-pressed="true"]')].map((b) => b.textContent);
    expect(pressed()).toEqual(['Edit']);
    rerender(<MarkdownEditor viewMode="preview" onViewModeChange={onViewModeChange} />);
    expect(pressed()).toEqual(['Preview']);
    click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Split'));
    expect(onViewModeChange).toHaveBeenCalledWith('split');
  });
});

describe('Card', () => {
  it('fills from the surface tokens, not a gray step', () => {
    const { container } = mount(<Card variant="filled">x</Card>);
    expect((container.firstElementChild as HTMLElement).style.background).toContain('--color-surface-hover');
  });

  it('with header actions, makes its title the button instead of nesting controls', () => {
    const onClick = vi.fn();
    const { container } = mount(
      <Card title="Report" onClick={onClick} headerActions={<button type="button">Share</button>}>
        body
      </Card>
    );
    expect(container.querySelector('[role="button"]')).toBeNull();
    const titleButton = container.querySelector('h3 button')!;
    expect(titleButton.textContent).toBe('Report');
    click(titleButton);
    expect(onClick).toHaveBeenCalledTimes(1);
    click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Share'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('Section', () => {
  it('makes a collapsible title a disclosure button', () => {
    const { container } = mount(
      <Section title="Details" collapsible defaultCollapsed headingLevel={3}>
        Hidden text
      </Section>
    );
    const button = container.querySelector('h3 button')!;
    expect(button.getAttribute('aria-expanded')).toBe('false');
    const content = document.getElementById(button.getAttribute('aria-controls')!)!;
    expect(content.hidden).toBe(true);
    click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(content.hidden).toBe(false);
  });
});

describe('Split', () => {
  it('moves the divider from the keyboard and reports where it is', () => {
    const onResize = vi.fn();
    const { container } = mount(
      <Split initialSize={200} minSize={50} onResize={onResize}>
        <div>left</div>
        <div>right</div>
      </Split>
    );
    const separator = container.querySelector<HTMLElement>('[role="separator"]')!;
    expect(separator.tabIndex).toBe(0);
    expect(separator.getAttribute('aria-label')).toBe('Resize panes');
    expect(separator.getAttribute('aria-valuenow')).toBe('200');
    key(separator, 'ArrowRight');
    expect(onResize).toHaveBeenLastCalledWith(210);
    key(separator, 'ArrowLeft', { shiftKey: true });
    expect(onResize).toHaveBeenLastCalledWith(160);
    key(separator, 'Home');
    expect(separator.getAttribute('aria-valuenow')).toBe('50');
  });
});

describe('Image', () => {
  it('is a keyboard button when clickable', () => {
    const onClick = vi.fn();
    const { container } = mount(<Image src="data:image/png;base64,AA==" alt="Chart" onClick={onClick} />);
    const button = container.querySelector<HTMLElement>('[role="button"]')!;
    expect(button.tabIndex).toBe(0);
    key(button, 'Enter');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('keeps its alt text when it fails to load', () => {
    const { container } = mount(<Image src={undefined as never} alt="Team photo" />);
    expect(container.querySelector('[role="img"]')?.getAttribute('aria-label')).toContain('Team photo');
  });
});

describe('SmartTimeline', () => {
  it('selects an entry from the keyboard', () => {
    const onSelect = vi.fn();
    const data = [{ title: 'Created', status: 'success' }];
    const { container } = mount(<SmartTimeline data={data} onSelect={onSelect} />);
    key(container.querySelector('[role="button"]'), ' ');
    expect(onSelect).toHaveBeenCalledWith(data[0]);
  });
});

describe('SmartGrid', () => {
  const rows = [{ id: 1, name: 'Ada' }];
  let original: typeof window.matchMedia;
  beforeEach(() => {
    original = window.matchMedia;
  });
  afterEach(() => {
    window.matchMedia = original;
  });

  it('does not label a row over its cells', () => {
    const { container } = mount(<SmartGrid data={rows} columns="name" onSelect={() => {}} />);
    expect(container.querySelector('tbody tr')?.hasAttribute('aria-label')).toBe(false);
  });

  it('keeps the mobile card actions out of the card button', () => {
    window.matchMedia = ((query: string) => ({
      ...original(query),
      matches: query.includes('max-width'),
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as typeof window.matchMedia;
    const { container } = mount(
      <SmartGrid data={rows} columns="name" onSelect={() => {}} onEdit={async () => {}} editable />
    );
    const cardButton = container.querySelector('[role="button"]');
    expect(cardButton).not.toBeNull();
    expect(cardButton!.querySelector('button')).toBeNull();
  });
});

describe('small display components', () => {
  it('Icon is decoration unless labelled', () => {
    const plain = mount(<Icon name="check" />);
    expect(plain.container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
    const named = mount(<Icon name="warning" ariaLabel="Warning" />);
    expect(named.container.firstElementChild?.getAttribute('role')).toBe('img');
    expect(named.container.firstElementChild?.getAttribute('aria-label')).toBe('Warning');
  });

  it('Avatar says its name, status and badge in words', () => {
    const { container } = mount(<Avatar name="Ada Lovelace" status="online" badge={3} />);
    const root = container.querySelector('[role="img"]')!;
    expect(root.getAttribute('aria-label')).toBe('Ada Lovelace, online, 3 notifications');
    const group = mount(
      <AvatarGroup max={1}>
        <Avatar name="A" />
        <Avatar name="B" />
      </AvatarGroup>
    );
    expect(group.container.querySelector('[aria-label="1 more"]')).not.toBeNull();
  });

  it('Heading clamps a level outside 1-6 instead of crashing', () => {
    const { container } = mount(<Heading level={9 as never}>Title</Heading>);
    expect(container.querySelector('h6')?.textContent).toBe('Title');
  });

  it('a labelled Divider is still a separator', () => {
    const { container } = mount(<Divider label="or" />);
    expect(container.querySelector('[role="separator"]')?.getAttribute('aria-label')).toBe('or');
  });

  it('the Sidebar toggle reports what it controls', () => {
    const { container } = mount(<Sidebar>nav</Sidebar>);
    const toggle = container.querySelector('button')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)?.textContent).toBe('nav');
    click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
});
