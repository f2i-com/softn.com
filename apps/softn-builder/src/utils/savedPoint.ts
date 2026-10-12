/**
 * The project as it was last kept, and whether it is that again.
 *
 * "Unsaved" was a mark every edit set and only a save took off. Undo is an
 * edit like any other: a page edited on the canvas and undone to the start
 * was the file it had been opened as, byte for byte (UIFileState.baseline),
 * and the toolbar still said "Unsaved", leaving asked about changes there
 * were none of, and the copy kept for recovery offered them back.
 *
 * What was kept is taken where the project is known to be in a file: opened
 * from one, restored from what a Save stored, or saved. Each edit is then
 * held against it (projectStore, markDirty): when what a save would write is
 * what was kept, nothing is unsaved, and a file that is as it was kept has
 * no mark of its own. It is not what a page was read as: that moves with
 * what is written in Code, and stays where it was through a save.
 *
 * Nothing is kept for a new project, which is in no file yet, nor for a copy
 * of unsaved work brought back (markUnsaved), nor for a draft once it has
 * been sent to FormLogic, which then holds a revision this cannot know
 * (forgetSavedPoint). For those only a save makes the project clean. The
 * empty project a page starts with has nothing to lose, and is kept as it
 * is (App.tsx).
 *
 * The words and the text are compared by value: the project's name and the
 * other words of its own, each page's text and tree, each logic file. The
 * collections, the schema, the permissions, the assets and the manifest as
 * read are compared by identity: each is replaced whenever it changes, so
 * one changed and put back by hand still counts as changed.
 */

import { useCanvasStore } from '../stores/canvasStore';
import { useFilesStore } from '../stores/filesStore';
import { useProjectStore } from '../stores/projectStore';
import { useSchemaStore } from '../stores/schemaStore';
import type { AssetFile, CanvasElement, ProjectFileNode, UIFileState, UIImport } from '../types/builder';
import { elementsEqual } from './elementsEqual';
import { liveImports } from './pageImports';

const PROJECT_FIELDS = ['name', 'version', 'description', 'icon', 'themeMode', 'permissions', 'pythonPackages', 'logicSource', 'collections', 'assets', 'source'] as const;
const SCHEMA_FIELDS = ['entities', 'relationships', 'seedData', 'recordIdentity', 'tombstones'] as const;

type ProjectFields = Pick<ReturnType<typeof useProjectStore.getState>, (typeof PROJECT_FIELDS)[number]>;
type SchemaFields = Pick<ReturnType<typeof useSchemaStore.getState>, (typeof SCHEMA_FIELDS)[number]>;

interface Tree {
  elements: Map<string, CanvasElement>;
  rootId: string;
  imports: UIImport[];
}

interface KeptPage extends Tree {
  path: string;
  logicSrc?: string;
  /** Its text; absent for a page made on the canvas, which has none of its own. */
  source?: string;
}

/** What a save writes, as it stood when the project was last kept. */
export interface SavedPoint {
  projectId: string;
  /** The revision it is of: two saves that overlap leave the newer one kept. */
  revision: number;
  project: ProjectFields;
  schema: SchemaFields;
  /** Every file and folder, by id: where it is and what it is. */
  nodes: Map<string, string>;
  pages: Map<string, KeptPage>;
  logic: Map<string, { path: string; content: string }>;
  assets: Map<string, AssetFile>;
}

const nodeKey = (node: ProjectFileNode) => `${node.type}:${node.fileType ?? ''}:${node.path}`;

function sameImports(a: readonly UIImport[], b: readonly UIImport[]): boolean {
  return a.length === b.length && a.every((imp, at) => imp.name === b[at].name && imp.source === b[at].source);
}

function sameTree(a: Tree, b: Tree): boolean {
  return a.rootId === b.rootId && sameImports(a.imports, b.imports) && elementsEqual(a.elements, b.elements);
}

/** The project as it stands, to be held as what was kept. */
export function captureSavedPoint(): SavedPoint {
  const project = useProjectStore.getState();
  const schema = useSchemaStore.getState();
  const files = useFilesStore.getState();
  const pages = new Map<string, KeptPage>();
  for (const [id, file] of files.uiFiles) {
    pages.set(id, { path: file.path, logicSrc: file.logicSrc, source: file.originalSource, elements: file.elements, rootId: file.rootId, imports: file.imports });
  }
  return {
    projectId: project.projectId,
    revision: project.revision,
    project: Object.fromEntries(PROJECT_FIELDS.map((field) => [field, project[field]])) as ProjectFields,
    schema: Object.fromEntries(SCHEMA_FIELDS.map((field) => [field, schema[field]])) as SchemaFields,
    nodes: new Map([...files.nodes].map(([id, node]) => [id, nodeKey(node)])),
    pages,
    logic: new Map([...files.logicFiles].map(([id, file]) => [id, { path: file.path, content: file.content }])),
    assets: new Map(files.assetFiles),
  };
}

/**
 * Whether a page is as it was kept. The canvas is ahead of the page it
 * shows (hooks/useActiveFileOnCanvas.ts), so for that page it is what the
 * canvas holds, which the next flush writes into it. The canvas shows the
 * active page once it has that page's root; until then, as a tab is being
 * changed, it still holds the page being left. A root is not enough alone:
 * pages read in the same millisecond can have the same ids.
 */
function pageAsKept(file: UIFileState, kept: KeptPage, active: boolean): boolean {
  if (file.path !== kept.path || file.logicSrc !== kept.logicSrc) return false;
  const canvas = useCanvasStore.getState();
  const shown = active && canvas.rootId === file.rootId;
  const now: Tree = shown
    ? { elements: canvas.elements, rootId: canvas.rootId, imports: liveImports(canvas.elements, canvas.imports ?? [], canvas.writtenImports) }
    : file;
  if (!sameTree(now, kept)) return false;
  if (kept.source === undefined) return file.originalSource === undefined;
  if (file.originalSource === kept.source) return true;
  // Its text was written again by an edit the canvas has since undone: the
  // next flush puts back the text it was read as (filesStore, updateUIFile).
  const read = file.baseline;
  return shown && read !== undefined && read.source === kept.source && !sameTree(now, file) && sameTree(now, read);
}

/**
 * Whether the project is what `point` holds. Each file that is as it was
 * kept loses its mark, whether or not the whole project is.
 */
function heldAgainst(point: SavedPoint): boolean {
  const project = useProjectStore.getState();
  if (project.projectId !== point.projectId) return false;
  const schema = useSchemaStore.getState();
  const files = useFilesStore.getState();
  let same =
    PROJECT_FIELDS.every((field) => project[field] === point.project[field]) &&
    SCHEMA_FIELDS.every((field) => schema[field] === point.schema[field]) &&
    files.nodes.size === point.nodes.size &&
    [...files.nodes].every(([id, node]) => point.nodes.get(id) === nodeKey(node)) &&
    files.uiFiles.size === point.pages.size &&
    files.logicFiles.size === point.logic.size &&
    files.assetFiles.size === point.assets.size &&
    [...files.assetFiles].every(([id, asset]) => {
      const kept = point.assets.get(id);
      return kept !== undefined && kept.name === asset.name && kept.type === asset.type && kept.data === asset.data && kept.bundlePath === asset.bundlePath;
    });

  const back: string[] = [];
  const hold = (id: string, asKept: boolean) => {
    if (!asKept) same = false;
    else if (files.nodes.get(id)?.isDirty) back.push(id);
  };
  for (const [id, file] of files.uiFiles) {
    const kept = point.pages.get(id);
    hold(id, kept !== undefined && pageAsKept(file, kept, id === files.activeFileId));
  }
  for (const [id, file] of files.logicFiles) {
    const kept = point.logic.get(id);
    hold(id, kept !== undefined && kept.path === file.path && kept.content === file.content);
  }

  if (back.length > 0) {
    const nodes = new Map(files.nodes);
    for (const id of back) nodes.set(id, { ...nodes.get(id)!, isDirty: false });
    useFilesStore.setState({ nodes });
  }
  return same;
}

/** The point each check the project holds is against. */
const pointOf = new WeakMap<() => boolean, SavedPoint>();

/**
 * Hold the project from now on against `point`, which a save captured with
 * the revision it wrote, or against the project as it stands. A save of an
 * earlier revision that finishes after a later one leaves the later one
 * kept, as it leaves the recovery record (utils/saveProject.ts). Returns
 * whether `point` is now what the project is held against.
 */
export function keepSavedPoint(point: SavedPoint = captureSavedPoint()): boolean {
  const project = useProjectStore.getState();
  const current = project.isAsKept ? pointOf.get(project.isAsKept) : undefined;
  if (current && current.projectId === point.projectId && current.revision > point.revision) return false;
  const isAsKept = () => heldAgainst(point);
  pointOf.set(isAsKept, point);
  project.holdAgainst(isAsKept);
  return true;
}

/**
 * Nothing the project could come back to is known to be kept any more: no
 * edit makes it clean again, only a save. For a draft sent to FormLogic,
 * which holds whatever revision it took.
 */
export function forgetSavedPoint(): void {
  useProjectStore.getState().holdAgainst(null);
}

/**
 * The project as it stands is in no file: it is unsaved, and stays so until
 * it is saved. For a copy of unsaved work brought back.
 */
export function markUnsaved(): void {
  forgetSavedPoint();
  useProjectStore.getState().markDirty();
}
