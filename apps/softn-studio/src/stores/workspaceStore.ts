import { create } from 'zustand';
import type {
  BuilderMode,
  LeftPanel,
  BottomTab,
  DevicePreset,
  ProjectBrief,
  Blueprint,
  AgentTask,
  ValidationError,
} from '../types/studio';

interface WorkspaceState {
  // Project
  projectName: string;
  projectId: string | null;
  isDirty: boolean;

  // Brief & Blueprint
  brief: ProjectBrief | null;
  blueprint: Blueprint | null;
  taskGraph: AgentTask[];
  blueprintApproved: boolean;

  // UI state
  mode: BuilderMode;
  leftPanel: LeftPanel | null;
  leftPanelExpanded: boolean;
  rightSidebarOpen: boolean;
  bottomDrawerOpen: boolean;
  bottomTab: BottomTab;
  advancedMode: boolean;

  // Canvas state
  selectedComponentId: string | null;
  activePageId: string | null;
  activeFilePath: string | null;
  devicePreset: DevicePreset;
  zoom: number;
  themePreview: 'light' | 'dark';

  // Validation
  errors: ValidationError[];
  consoleOutput: string[];

  // Actions
  setProjectName(name: string): void;
  setDirty(dirty: boolean): void;
  setBrief(brief: ProjectBrief | null): void;
  setBlueprint(bp: Blueprint | null): void;
  setBlueprintApproved(approved: boolean): void;
  setTaskGraph(tasks: AgentTask[]): void;
  updateTask(id: string, updates: Partial<AgentTask>): void;
  setMode(mode: BuilderMode): void;
  setLeftPanel(panel: LeftPanel | null): void;
  toggleLeftPanel(): void;
  toggleRightSidebar(): void;
  toggleBottomDrawer(): void;
  setBottomTab(tab: BottomTab): void;
  toggleAdvancedMode(): void;
  selectComponent(id: string | null): void;
  setActivePage(id: string | null): void;
  setActiveFilePath(path: string | null): void;
  setDevicePreset(preset: DevicePreset): void;
  setZoom(zoom: number): void;
  setThemePreview(theme: 'light' | 'dark'): void;
  addError(error: ValidationError): void;
  clearErrors(): void;
  addConsoleOutput(line: string): void;
  clearConsole(): void;
  reset(): void;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  projectName: '',
  projectId: null,
  isDirty: false,

  brief: null,
  blueprint: null,
  taskGraph: [],
  blueprintApproved: false,

  mode: 'describe',
  leftPanel: 'ai',
  leftPanelExpanded: true,
  rightSidebarOpen: true,
  bottomDrawerOpen: false,
  bottomTab: 'log',
  advancedMode: false,

  selectedComponentId: null,
  activePageId: null,
  activeFilePath: null,
  devicePreset: 'desktop',
  zoom: 100,
  themePreview: 'dark',

  errors: [],
  consoleOutput: [],

  setProjectName: (name) => set({ projectName: name, isDirty: true }),
  setDirty: (dirty) => set({ isDirty: dirty }),
  setBrief: (brief) => set({ brief }),
  setBlueprint: (bp) => set({ blueprint: bp }),
  setBlueprintApproved: (approved) => set({ blueprintApproved: approved }),
  setTaskGraph: (tasks) => set({ taskGraph: tasks }),
  updateTask: (id, updates) =>
    set((s) => ({
      taskGraph: s.taskGraph.map((t) => (t.id === id ? { ...t, ...updates } : t)),
    })),
  setMode: (mode) => set({ mode }),
  setLeftPanel: (panel) =>
    set((s) => ({
      leftPanel: panel,
      leftPanelExpanded: panel !== null && (panel !== s.leftPanel || !s.leftPanelExpanded),
    })),
  toggleLeftPanel: () => set((s) => ({ leftPanelExpanded: !s.leftPanelExpanded })),
  toggleRightSidebar: () => set((s) => ({ rightSidebarOpen: !s.rightSidebarOpen })),
  toggleBottomDrawer: () => set((s) => ({ bottomDrawerOpen: !s.bottomDrawerOpen })),
  setBottomTab: (tab) => set({ bottomTab: tab, bottomDrawerOpen: true }),
  toggleAdvancedMode: () => set((s) => ({ advancedMode: !s.advancedMode })),
  selectComponent: (id) => set({ selectedComponentId: id }),
  setActivePage: (id) => set({ activePageId: id }),
  setActiveFilePath: (path) => set({ activeFilePath: path }),
  setDevicePreset: (preset) => set({ devicePreset: preset }),
  setZoom: (zoom) => set({ zoom: Math.max(50, Math.min(200, zoom)) }),
  setThemePreview: (theme) => set({ themePreview: theme }),
  addError: (error) => set((s) => ({ errors: [...s.errors, error] })),
  clearErrors: () => set({ errors: [] }),
  addConsoleOutput: (line) => set((s) => {
    const next = [...s.consoleOutput, line];
    return { consoleOutput: next.length > 500 ? next.slice(-500) : next };
  }),
  clearConsole: () => set({ consoleOutput: [] }),
  reset: () =>
    set({
      projectName: '',
      projectId: null,
      isDirty: false,
      brief: null,
      blueprint: null,
      taskGraph: [],
      blueprintApproved: false,
      mode: 'describe',
      leftPanel: 'ai',
      leftPanelExpanded: true,
      rightSidebarOpen: true,
      bottomDrawerOpen: false,
      bottomTab: 'log',
      advancedMode: false,
      selectedComponentId: null,
      activePageId: null,
      activeFilePath: null,
      devicePreset: 'desktop',
      zoom: 100,
      themePreview: 'dark',
      errors: [],
      consoleOutput: [],
    }),
}));
