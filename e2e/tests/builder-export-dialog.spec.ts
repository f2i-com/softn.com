/**
 * Builder's Export dialog owns focus while it is open. UX-01 in the audit.
 *
 * What went wrong before: the overlay was a div with no dialog semantics —
 * Tab left it for the toolbar behind it, Escape did nothing, and closing
 * dropped focus on the body, so a keyboard user who opened Export was
 * somewhere on the page with no idea where. The dialog now has
 * `role="dialog"`, `aria-modal`, a Tab trap that wraps at both ends, an
 * Escape that closes it, and focus that is meant to go back to the control
 * that opened it.
 *
 * Which assertion catches which regression:
 *   UX-01  focus is inside the dialog once it opens; Tab from the last
 *          control lands on the first and Shift+Tab from the first lands on
 *          the last, and a long run of Tabs never leaves the dialog; Escape
 *          closes it; and — the second test — the toolbar's Export button
 *          has focus again afterwards.
 *
 * The dialog's controls change while it is open — the preflight inspection
 * enables the hand-off buttons when it finishes — so the wrap is checked
 * against the focusable set as it stands at each step, read from the DOM,
 * rather than against a fixed count.
 *
 * Focus restoration also checks that the app clears its inert shell before
 * the dialog hands focus back to the opener.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { watchConsole } from '../helpers/console';
import { BUILDER_EXPORT_TITLE, openBuilderWithDemo } from '../helpers/editors';

/** The same selector the dialog uses, so "first" and "last" mean what it means. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Where focus is, described so a failure names the element. */
async function focused(page: Page): Promise<{ inDialog: boolean; tag: string; label: string; index: number; count: number }> {
  return page.evaluate((selector) => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const active = document.activeElement as HTMLElement | null;
    const items = dialog
      ? Array.from(dialog.querySelectorAll<HTMLElement>(selector)).filter((el) => !el.hidden && el.style.display !== 'none' && el.getAttribute('aria-hidden') !== 'true')
      : [];
    return {
      inDialog: Boolean(dialog && active && dialog.contains(active)),
      tag: active?.tagName.toLowerCase() ?? 'none',
      label: active?.getAttribute('aria-label') ?? active?.textContent?.trim().slice(0, 40) ?? '',
      index: active ? items.indexOf(active) : -1,
      count: items.length,
    };
  }, FOCUSABLE);
}

/** Open the dialog from the keyboard, so the opener is a focused control. */
async function openFromKeyboard(page: Page): Promise<{ trigger: Locator; dialog: Locator }> {
  const trigger = page.getByTitle(BUILDER_EXPORT_TITLE);
  await trigger.focus();
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Export Bundle' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  return { trigger, dialog };
}

test.describe('the Export dialog', () => {
  test('takes focus, traps Tab at both ends, and closes on Escape without moving the editor', async ({ page }, testInfo) => {
    const log = watchConsole(page, testInfo);
    const editorUrl = await openBuilderWithDemo(page);
    const { dialog } = await openFromKeyboard(page);

    // Focus moved in, to the first control.
    await expect.poll(async () => (await focused(page)).inDialog, { message: 'focus moves into the dialog on open' }).toBe(true);
    let at = await focused(page);
    expect(at.count, 'the dialog has controls to move between').toBeGreaterThan(1);
    expect(at.index, 'the first control has focus').toBe(0);

    // Shift+Tab from the first wraps to the last.
    await page.keyboard.press('Shift+Tab');
    at = await focused(page);
    expect(at.inDialog, `Shift+Tab from the first control stays inside (now on ${at.tag} "${at.label}")`).toBe(true);
    expect(at.index).toBe(at.count - 1);

    // Tab from the last wraps to the first.
    await page.keyboard.press('Tab');
    at = await focused(page);
    expect(at.inDialog).toBe(true);
    expect(at.index).toBe(0);

    // A long run of Tabs — more than the dialog has controls — never leaves it.
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab');
      at = await focused(page);
      expect(at.inDialog, `Tab ${i + 1} left the dialog for ${at.tag} "${at.label}"`).toBe(true);
    }
    // And the page behind is inert to the pointer and the tab order alike.
    await expect(page.locator('[inert]').first()).toBeAttached();

    // Escape closes it; the page behind comes back; the editor has not moved.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('[inert]')).toHaveCount(0);
    expect(page.url(), 'closing the dialog does not move the editor').toBe(editorUrl);

    await log.attach('builder');
    expect(log.uncaught).toEqual([]);
  });

  test('returns focus to the Export button when it closes', async ({ page }, testInfo) => {
    const log = watchConsole(page, testInfo);
    await openBuilderWithDemo(page);

    // Focus is returned synchronously in the close effect.
    const returned = { timeout: 2_000 };

    // Escape.
    const { trigger, dialog } = await openFromKeyboard(page);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused(returned);

    // The Close button.
    await openFromKeyboard(page);
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(trigger).toBeFocused(returned);

    await log.attach('builder');
    expect(log.uncaught).toEqual([]);
  });
});

test('imported schema fields stay editable and duplicate renames preserve records', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/builder/?open=%2Fexamples%2FFieldnotes.softn');
  await expect(page.getByText('Fieldnotes', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Data', exact: true }).click();
  const field = page.getByRole('textbox', { name: 'Field name: title', exact: true });
  await expect(field).toBeEnabled();
  await expect(page.getByRole('textbox', { name: 'Field name: lane', exact: true })).toBeEnabled();
  const titleValue = page.getByRole('table').locator('input').first();
  await expect(titleValue).toHaveValue('Sketch the welcome screen');
  await field.fill('lane');
  await field.press('Enter');
  const validation = page.getByRole('complementary', { name: 'Schema details', exact: true }).getByRole('alert');
  await expect(validation).toContainText('already exists');
  await expect(field).toHaveValue('title');
  await expect(titleValue).toHaveValue('Sketch the welcome screen');
  await field.fill('task');
  await field.press('Escape');
  await expect(field).toHaveValue('title');
  await expect(validation).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Zoom In', exact: true })).toBeEnabled();
  await expect.poll(() => page.locator('.react-flow__node').first().evaluate((node) => {
    const canvas = node.closest('.react-flow')!.getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    return rect.top >= canvas.top && rect.bottom <= canvas.bottom;
  }), { message: 'The complete schema fits above the seed-data table' }).toBe(true);
});

test('draws a record relationship and preserves its model and data through export and reopen', async ({ page }, testInfo) => {
  const log = watchConsole(page, testInfo);
  await page.goto('/builder/?open=%2Fexamples%2FFieldnotes.softn');
  await expect(page.getByTitle('Fieldnotes', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Data', exact: true }).click();
  await page.getByRole('button', { name: '+ Add Entity', exact: true }).click();
  const collectionName = page.getByRole('textbox', { name: 'Collection name', exact: true });
  await collectionName.fill('customers');
  await collectionName.press('Enter');
  await expect.poll(() => page.locator('.react-flow__node').evaluateAll(nodes => {
    if (nodes.length !== 2) return false;
    const [a, b] = nodes.map(node => node.getBoundingClientRect());
    return a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
  }), { message: 'A new collection is placed beside existing collections' }).toBe(true);
  await page.getByRole('button', { name: '+ Add Field', exact: true }).click();
  const newField = page.getByRole('textbox', { name: 'Field name: newField', exact: true });
  await newField.fill('name');
  await newField.press('Enter');

  // The diagram gesture is the entry point, not just the keyboard alternative.
  await page.getByRole('button', { name: 'Fit View', exact: true }).click();
  await page.getByLabel('Link tasks to a collection', { exact: true }).dragTo(page.getByLabel('Connect to customers', { exact: true }));
  let dialog = page.getByRole('dialog', { name: 'Add relationship', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Source collection', exact: true })).toContainText('tasks');
  await dialog.getByRole('combobox', { name: 'Reference field Optional', exact: true }).selectOption('new');
  await dialog.getByRole('textbox', { name: 'New reference field name', exact: true }).fill('customerId');
  await dialog.getByRole('button', { name: 'Add relationship', exact: true }).click();
  const relationship = 'tasks.customerId → customers';
  await expect(page.getByRole('list', { name: 'Relationships', exact: true })).toContainText(relationship);
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);

  await page.getByRole('button', { name: 'customers', exact: true }).click();
  await page.getByRole('button', { name: '+ Add Record', exact: true }).click();
  await page.getByRole('table').getByRole('textbox').last().fill('Northwind');
  await page.getByRole('button', { name: 'tasks (5)', exact: true }).click();
  const recordLink = page.getByRole('table').getByRole('combobox').first();
  await recordLink.selectOption({ index: 1 });
  const linkedId = await recordLink.inputValue();
  expect(linkedId).not.toBe('');
  await expect(recordLink.locator('option:checked')).toContainText('Northwind');

  // Editing a selected relationship cannot let Backspace reach the schema.
  await page.getByRole('button', { name: `Edit relationship ${relationship}`, exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Edit relationship', exact: true });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).focus();
  await page.keyboard.press('Backspace');
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await dialog.getByRole('radio', { name: /One to one/ }).check();
  await dialog.getByRole('button', { name: 'Save relationship', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Relationships', exact: true })).toContainText('1:1');

  await page.getByTitle(BUILDER_EXPORT_TITLE).click();
  const exported = page.waitForEvent('download');
  await page.getByRole('dialog', { name: 'Export Bundle', exact: true }).getByRole('button', { name: 'Export .softn', exact: true }).click();
  const bundle = await exported;
  const savedPath = testInfo.outputPath('relationships.softn');
  await bundle.saveAs(savedPath);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  page.once('dialog', async prompt => {
    expect(prompt.message()).toBe('Open a new project? Unsaved changes will be lost.');
    await prompt.accept();
  });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await (await chooser).setFiles(savedPath);
  await expect(page.getByTitle('Fieldnotes', { exact: true })).toHaveText('Fieldnotes');
  await page.getByRole('button', { name: 'Data', exact: true }).click();
  await page.getByRole('tab', { name: 'Relationships (1)', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Relationships', exact: true })).toContainText(relationship);
  await expect(page.getByRole('list', { name: 'Relationships', exact: true })).toContainText('1:1');
  await expect(page.getByRole('table').getByRole('combobox').first()).toHaveValue(linkedId);
  await expect(page.getByRole('table').getByRole('textbox').first()).toHaveValue('Sketch the welcome screen');

  // A sidebar button owns Delete; it must not delete the selected graph node.
  await page.getByRole('button', { name: `Select relationship ${relationship}`, exact: true }).click();
  await page.keyboard.press('Delete');
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);

  // Removing only the diagram link retains both collections and real values.
  await page.getByRole('button', { name: `Remove relationship ${relationship}`, exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Relationships (0)', exact: true })).toBeVisible();
  await expect(page.locator('.react-flow__edge')).toHaveCount(0);
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  await expect(page.getByRole('table').getByRole('combobox').first()).toHaveValue(linkedId);

  // Keyboard deletion from the graph removes only its selected relationship.
  await page.getByRole('button', { name: '+ Add relationship', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Add relationship', exact: true });
  await dialog.getByRole('combobox', { name: 'Source collection', exact: true }).selectOption({ label: 'tasks' });
  await dialog.getByRole('combobox', { name: 'Target collection', exact: true }).selectOption({ label: 'customers' });
  await dialog.getByRole('button', { name: 'Add relationship', exact: true }).click();
  await page.getByRole('button', { name: 'Select relationship tasks → customers', exact: true }).click();
  await page.locator('.react-flow__edge').focus();
  await page.keyboard.press('Delete');
  await expect(page.locator('.react-flow__edge')).toHaveCount(0);
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  await expect(page.getByRole('table').getByRole('combobox').first()).toHaveValue(linkedId);
  await log.attach('builder-relationships');
  expect(log.uncaught).toEqual([]);
});
