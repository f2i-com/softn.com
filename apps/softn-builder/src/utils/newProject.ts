/**
 * Starting a new app: every store back to empty, then the choices from the
 * New app dialog, then the starter template — written into the entry file.
 *
 * The template used to be added to the canvas only. The workspace reloads the
 * canvas from the active UI file whenever the files change, and resetting the
 * files had just replaced that file with an empty one, so every template was
 * wiped a render later: "Landing page" and "Dashboard" made the same empty
 * page as "Blank".
 */

import { useCanvasStore } from '../stores/canvasStore';
import { useFilesStore } from '../stores/filesStore';
import { useHistoryStore } from '../stores/historyStore';
import { useProjectStore } from '../stores/projectStore';
import { useSchemaStore } from '../stores/schemaStore';
import { flushCanvasToActiveFile } from './buildProjectBundle';
import { expressionText } from './starterProps';
import type { NewProjectConfig, StarterTemplate } from '../components/toolbar/NewProjectDialog';

/** Put a starter template's elements under the canvas root. */
export function applyStarterTemplate(template: StarterTemplate): void {
  // Blank is the root and nothing else: the canvas's empty state says how
  // to start, which placeholder prose to delete first would not.
  if (template === 'blank') return;

  const canvas = useCanvasStore.getState();
  const rootId = canvas.rootId;

  if (template === 'landing') {
    const stack = canvas.addElement('Stack', rootId);
    canvas.updateElementProps(stack, { direction: 'vertical', gap: 'lg', align: 'center', padding: 'xl' });
    const heading = canvas.addElement('Heading', stack);
    canvas.updateElementProps(heading, { level: 1, children: 'Build apps faster with SoftN' });
    const subText = canvas.addElement('Text', stack);
    canvas.updateElementProps(subText, { children: 'Compose UI visually, wire logic quickly, and ship instantly.' });
    const cta = canvas.addElement('Button', stack);
    canvas.updateElementProps(cta, { variant: 'primary', children: 'Get Started' });
    return;
  }

  if (template === 'dashboard') {
    const page = canvas.addElement('Stack', rootId);
    canvas.updateElementProps(page, { direction: 'vertical', gap: 'md', padding: 'lg' });
    const heading = canvas.addElement('Heading', page);
    canvas.updateElementProps(heading, { level: 1, children: 'Dashboard' });
    // Each of the three is given what it shows, under the names the component
    // reads. The cards and the list were told their fields as `titleField`,
    // `descriptionField` and `subtitleField`, which neither reads, and none of
    // the three had anything to show: the starter ran as a heading over "No
    // items to display", twice. The rows are examples, written where the
    // person will find them, to be replaced with a name from the logic.
    const stats = canvas.addElement('SmartStats', page);
    canvas.updateElementProps(stats, { stats: 'Open: 12, Done: 30, Overdue: 2', columns: 3 });
    const cards = canvas.addElement('SmartCards', page);
    const projects = rows('data', SAMPLE_PROJECTS);
    canvas.updateElement(cards, { props: { ...projects.props, title: 'title', description: 'description' }, expressionProps: projects.expressionProps });
    const list = canvas.addElement('SmartList', page);
    const tasks = rows('data', SAMPLE_TASKS);
    canvas.updateElement(list, { props: { ...tasks.props, primary: 'title', secondary: 'status' }, expressionProps: tasks.expressionProps });
  }
}

/** What the Dashboard's cards show until they are given the app's own rows. */
const SAMPLE_PROJECTS = [
  { title: 'Website refresh', description: 'New home page and pricing' },
  { title: 'Spring newsletter', description: 'Draft due on Friday' },
  { title: 'Customer survey', description: 'Results are in' },
];

/** What the Dashboard's list shows until it is given the app's own rows. */
const SAMPLE_TASKS = [
  { title: 'Write the brief', status: 'Done' },
  { title: 'Review the designs', status: 'Open' },
  { title: 'Send the invoice', status: 'Overdue' },
];

/**
 * A list of rows as the property `name`, kept the way the source parser
 * keeps an expression (utils/starterProps.ts), so the page reads back as it
 * was written. Nothing when the list cannot be written.
 */
function rows(name: string, list: readonly Record<string, string>[]): { props: Record<string, unknown>; expressionProps: string[] } {
  const text = expressionText(JSON.stringify(list));
  return text === null ? { props: {}, expressionProps: [] } : { props: { [name]: text }, expressionProps: [name] };
}

/** Replace the workspace with a new app made from the dialog's choices. */
export function startNewProject(config: NewProjectConfig): void {
  useCanvasStore.getState().reset();
  useProjectStore.getState().reset(config.language);
  useHistoryStore.getState().clear();
  useSchemaStore.getState().reset();
  useFilesStore.getState().reset(config.language);

  const project = useProjectStore.getState();
  project.setName(config.name);
  project.setDescription(config.description);
  project.setThemeMode(config.theme);
  project.setVersion('1.0.0');
  project.setPythonPackages(config.pythonPackages);

  const canvas = useCanvasStore.getState();
  const root = canvas.getElement(canvas.rootId);
  if (root) canvas.updateElementProps(root.id, { theme: config.theme });

  applyStarterTemplate(config.template);
  // Into the file, or the next reload of the canvas from it throws it away.
  flushCanvasToActiveFile();

  // The new project has not been saved anywhere yet, including its name,
  // chosen template and theme. Keep navigation/New/Open guards active.
  useProjectStore.getState().markDirty();
}
