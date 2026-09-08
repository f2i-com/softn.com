/**
 * SoftN Component Library
 *
 * Exports all built-in components and the registration utility.
 *
 * This is the eager barrel: importing anything from it puts every component,
 * Three.js included, into the importing chunk. It stays for Studio, the
 * Builder, the desktop loader and the Vite plugin. A host that wants the
 * runtime's demand loading imports from the entries instead —
 * '@softn/components/lazy' for registration, '/minimal' and '/theme' for its
 * own chrome, a feature entry for a feature. See docs/COMPONENT_LOADING.md.
 */

// Layout components
export * from './layout';

// Form components
export * from './form';

// Display components
export * from './display';

// Feedback components
export * from './feedback';

// Navigation components
export * from './navigation';

// Utility components
export * from './utility';

// Data components
export * from './data/List';
export * from './data/Table';
export * from './data/TreeView';
export * from './data/Pagination';
export * from './data/DataGrid';

// Chart components
export * from './charts/LineChart';
export * from './charts/BarChart';
export * from './charts/PieChart';
export * from './charts/AreaChart';
export * from './charts/RadarChart';
export * from './charts/GaugeChart';

// Animation components
export * from './animation';

// Editor components
export * from './editors/CodeEditor';
export * from './editors/MarkdownEditor';
export * from './editors/RichTextEditor';

// 3D components
export * from './threed';

// Smart components (opinionated, feature-rich)
export * from './smart';

// Registry
export * from './registry';

// Theme system
export * from './theme';
