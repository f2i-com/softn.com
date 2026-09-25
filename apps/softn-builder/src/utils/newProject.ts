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
    const stats = canvas.addElement('SmartStats', page);
    canvas.updateElementProps(stats, { columns: 3 });
    const cards = canvas.addElement('SmartCards', page);
    canvas.updateElementProps(cards, { columns: 3, titleField: 'title', descriptionField: 'description' });
    const list = canvas.addElement('SmartList', page);
    canvas.updateElementProps(list, { titleField: 'title', subtitleField: 'status' });
  }
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
