/**
 * The built-in component library, grouped exactly as
 * `packages/@softn/components/src/registry.ts` groups it. If a component is
 * added there, add it here — the total on the page is computed from this list,
 * so it cannot quietly go stale in one direction.
 */
export interface Category {
  name: string;
  components: string[];
}

export const CATEGORIES: Category[] = [
  {
    name: 'Layout',
    components: [
      'Stack',
      'Box',
      'Card',
      'Grid',
      'Container',
      'Divider',
      'Spacer',
      'Center',
      'Sidebar',
      'Split',
      'App',
      'Layout',
      'Header',
      'Content',
      'Section',
    ],
  },
  {
    name: 'Form',
    components: [
      'Button',
      'Input',
      'Form',
      'TextArea',
      'Select',
      'Checkbox',
      'Switch',
      'Radio',
      'Slider',
      'DatePicker',
      'ColorPicker',
      'FileChooser',
    ],
  },
  {
    name: 'Display',
    components: ['Text', 'Heading', 'Badge', 'Tag', 'Avatar', 'Progress', 'Spinner', 'Image', 'Icon'],
  },
  {
    name: 'Feedback',
    components: ['Alert', 'Modal', 'Toast', 'Drawer', 'Popover', 'EmptyState'],
  },
  {
    name: 'Data',
    components: ['List', 'ListItem', 'Table', 'TreeView', 'Pagination', 'DataGrid'],
  },
  {
    name: 'Navigation',
    components: ['Tabs', 'Breadcrumb', 'Menu', 'NavItem'],
  },
  {
    name: 'Utility',
    components: [
      'Accordion',
      'Collapse',
      'Tooltip',
      'Loop',
      'PixelGrid',
      // The canvas-backed counterpart to PixelGrid: sparse cells versus a dense
      // bitmap, so they sit together.
      'PixelCanvas',
      'QRCode',
      'QRReader',
      'Camera',
      'Microphone',
      // Next to Microphone because they are the two ends of the same wire —
      // one takes sound in, the other puts generated sound out.
      'AudioStream',
      'DPad',
    ],
  },
  {
    name: 'Charts',
    components: ['LineChart', 'BarChart', 'PieChart', 'AreaChart', 'RadarChart', 'GaugeChart'],
  },
  {
    name: 'Animation',
    components: [
      'AnimatedBox',
      'AnimatedNumber',
      'Marquee',
      'Typewriter',
      'Draggable',
      'SortableList',
      'PanView',
      'Sprite',
      'TileMap',
    ],
  },
  {
    name: 'Editors',
    components: ['CodeEditor', 'MarkdownEditor', 'RichTextEditor'],
  },
  {
    name: '3D',
    components: ['Scene3D'],
  },
  {
    name: 'Smart',
    components: ['SmartGrid', 'SmartView', 'SmartForm', 'SmartStats', 'SmartCards', 'SmartList', 'SmartTimeline'],
  },
];

export const COMPONENT_COUNT = CATEGORIES.reduce((n, c) => n + c.components.length, 0);
