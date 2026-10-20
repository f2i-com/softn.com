/**
 * SoftN Component Registry
 *
 * What the Builder says of each of the 104 built-in components the palette
 * offers, and of the page itself: its category, icon and description, what
 * a new one starts with (`defaultProps`), which props the property panel
 * shows and with what control, and what it may hold. What the components
 * themselves decide is not said here: a prop's default and the choices its
 * type names come from the components' sources, through
 * component-manifest.json (componentProps.generated.ts, withComponentFacts
 * below). An entry gives a `default` or `options` only for what the manifest
 * cannot say: a default the component works out, or a value an open type
 * takes beyond the ones it names.
 */

import { PAGE_TYPE, type ComponentMeta, type ComponentCategory, type PropSchema } from '../types/builder';
import { COMPONENT_PROPS } from './componentProps.generated';
import { getNativeHtmlMeta } from './nativeHtmlMetadata';

// Helper to create component metadata
function comp(
  name: string,
  category: ComponentCategory,
  icon: string,
  description: string,
  defaultProps: Record<string, unknown>,
  propSchema: ComponentMeta['propSchema'],
  allowChildren: boolean = false,
  childTypes?: string[]
): ComponentMeta {
  return { name, category, icon, description, defaultProps, propSchema, allowChildren, childTypes };
}

const baseRegistry: ComponentMeta[] = [
  // ==================== LAYOUT COMPONENTS ====================
  comp(
    'App',
    'Layout',
    'layout',
    'Root application container with theme support',
    { theme: 'system' },
    [
      { name: 'theme', type: 'select', options: ['light', 'dark', 'system'] },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(
    'Stack',
    'Layout',
    'layers',
    'Flexbox container for stacking elements',
    { direction: 'vertical', gap: 'md', align: 'stretch' },
    [
      { name: 'direction', type: 'select' },
      { name: 'gap', type: 'select' },
      { name: 'align', type: 'select' },
      { name: 'justify', type: 'select' },
      { name: 'wrap', type: 'boolean' },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(
    'Box',
    'Layout',
    'square',
    'Generic container with styling props',
    { padding: 'md' },
    [
      { name: 'padding', type: 'select' },
      { name: 'margin', type: 'select' },
      { name: 'background', type: 'color' },
      { name: 'borderRadius', type: 'select' },
      { name: 'shadow', type: 'select' },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(    'Card',
    'Layout',
    'credit-card',
    'Elevated container with shadow',
    { padding: 'md', variant: 'elevated' },
    [
      { name: 'variant', type: 'select' },
      { name: 'padding', type: 'select' },
      { name: 'borderRadius', type: 'select' },
      { name: 'title', type: 'string' },
      { name: 'subtitle', type: 'string' },
      { name: 'hover', type: 'boolean' },
      { name: 'interactive', type: 'boolean' },
      { name: 'dividers', type: 'boolean' },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(
    'Grid',
    'Layout',
    'grid',
    'CSS Grid layout container',
    { columns: 2, gap: 'md' },
    [
      { name: 'columns', type: 'number' },
      { name: 'rows', type: 'number' },
      { name: 'gap', type: 'select' },
      { name: 'columnGap', type: 'select' },
      { name: 'rowGap', type: 'select' },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(    'Container',
    'Layout',
    'maximize',
    'Constrained width wrapper',
    { size: 'lg', centered: true },
    [
      { name: 'size', type: 'select' },
      { name: 'centered', type: 'boolean' },
      { name: 'padding', type: 'select' },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(
    'Center',
    'Layout',
    'align-center',
    'Center alignment utility',
    {},
    [{ name: 'className', type: 'string' }],
    true
  ),

  comp(    'Divider',
    'Layout',
    'minus',
    'Visual separator line',
    { direction: 'horizontal' },
    [
      { name: 'direction', type: 'select' },
      { name: 'label', type: 'string' },
      { name: 'thickness', type: 'string' },
      { name: 'color', type: 'color' },
      { name: 'margin', type: 'select' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(
    'Spacer',
    'Layout',
    'move',
    'Flexible spacing element',
    { size: 'md' },
    [{ name: 'size', type: 'select' }],
    false
  ),

  comp(    'Split',
    'Layout',
    'columns',
    'Two-column layout',
    { direction: 'horizontal', initialSize: '50%' },
    [
      { name: 'direction', type: 'select' },
      { name: 'initialSize', type: 'string', description: 'Size of the first pane (CSS length or percentage)' },
      { name: 'minSize', type: 'number' },
      { name: 'maxSize', type: 'number' },
      { name: 'gutterSize', type: 'number' },
      { name: 'gutterColor', type: 'color' },
      { name: 'onResize', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(
    'Layout',
    'Layout',
    'layout',
    'Semantic layout structure',
    {},
    [{ name: 'className', type: 'string' }],
    true
  ),

  comp(
    'Header',
    'Layout',
    'arrow-up',
    'Page header section',
    {},
    [
      { name: 'sticky', type: 'boolean' },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(
    'Content',
    'Layout',
    'file-text',
    'Main content area',
    {},
    [{ name: 'className', type: 'string' }],
    true
  ),

  comp(    'Sidebar',
    'Layout',
    'sidebar',
    'Sidebar container',
    { position: 'left', width: '280px' },
    [
      { name: 'position', type: 'select' },
      { name: 'width', type: 'string' },
      { name: 'collapsedWidth', type: 'string' },
      { name: 'collapsible', type: 'boolean' },
      { name: 'collapsed', type: 'boolean' },
      { name: 'showToggle', type: 'boolean' },
      { name: 'background', type: 'color' },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(
    'Section',
    'Layout',
    'square',
    'Content section',
    {},
    [{ name: 'className', type: 'string' }],
    true
  ),

  // ==================== FORM COMPONENTS ====================
  comp(
    'Button',
    'Form',
    'mouse-pointer',
    'Interactive button',
    { variant: 'primary', size: 'md', children: 'Click me' },
    [
      { name: 'variant', type: 'select' },
      { name: 'size', type: 'select' },
      { name: 'disabled', type: 'boolean' },
      { name: 'loading', type: 'boolean' },
      { name: 'fullWidth', type: 'boolean' },
      { name: 'type', type: 'select' },
      { name: 'onClick', type: 'event', description: 'Click handler' },
      { name: 'ariaLabel', type: 'string', description: 'Accessible name — needed when the label is only a glyph' },
      { name: 'title', type: 'string', description: 'Tooltip' },
      { name: 'children', type: 'string' },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(
    'Input',
    'Form',
    'type',
    'Text input field',
    { placeholder: 'Enter text...', variant: 'outline' },
    [
      { name: 'type', type: 'select' },
      { name: 'placeholder', type: 'string' },
      { name: 'value', type: 'expression' },
      { name: 'defaultValue', type: 'string' },
      { name: 'variant', type: 'select' },
      { name: 'size', type: 'select' },
      { name: 'disabled', type: 'boolean' },
      { name: 'required', type: 'boolean' },
      { name: 'onChange', type: 'event', description: 'Change handler' },
      { name: 'onFocus', type: 'event' },
      { name: 'onBlur', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(
    'TextArea',
    'Form',
    'align-left',
    'Multi-line text input',
    { placeholder: 'Enter text...', rows: 4 },
    [
      { name: 'placeholder', type: 'string' },
      { name: 'value', type: 'expression' },
      { name: 'rows', type: 'number' },
      { name: 'resize', type: 'select' },
      { name: 'disabled', type: 'boolean' },
      { name: 'onChange', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(
    'Select',
    'Form',
    'chevron-down',
    'Dropdown select',
    {
      placeholder: 'Select an option...',
      options: [
        { value: 'one', label: 'Option one' },
        { value: 'two', label: 'Option two' },
        { value: 'three', label: 'Option three' },
      ],
    },
    [
      { name: 'placeholder', type: 'string' },
      { name: 'value', type: 'expression' },
      { name: 'options', type: 'json', description: 'Array of { value, label } objects' },
      { name: 'multiple', type: 'boolean' },
      { name: 'searchable', type: 'boolean' },
      { name: 'disabled', type: 'boolean' },
      { name: 'onChange', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(
    'Checkbox',
    'Form',
    'check-square',
    'Boolean checkbox',
    { label: 'Checkbox' },
    [
      { name: 'label', type: 'string' },
      { name: 'checked', type: 'expression' },
      { name: 'defaultChecked', type: 'boolean' },
      { name: 'disabled', type: 'boolean' },
      { name: 'onChange', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(
    'Radio',
    'Form',
    'circle',
    'Radio button group',
    {
      name: 'radio-group',
      options: [
        { value: 'one', label: 'Option one' },
        { value: 'two', label: 'Option two' },
        { value: 'three', label: 'Option three' },
      ],
    },
    [
      { name: 'name', type: 'string' },
      { name: 'value', type: 'expression' },
      { name: 'options', type: 'json', description: 'Array of { value, label } objects' },
      { name: 'direction', type: 'select' },
      { name: 'disabled', type: 'boolean' },
      { name: 'onChange', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(
    'Switch',
    'Form',
    'toggle-left',
    'Toggle switch',
    { label: 'Toggle' },
    [
      { name: 'label', type: 'string' },
      { name: 'checked', type: 'expression' },
      { name: 'defaultChecked', type: 'boolean' },
      { name: 'disabled', type: 'boolean' },
      { name: 'size', type: 'select' },
      { name: 'onChange', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(    'Slider',
    'Form',
    'sliders',
    'Range slider',
    { min: 0, max: 100, defaultValue: 50 },
    [
      { name: 'min', type: 'number' },
      { name: 'max', type: 'number' },
      { name: 'step', type: 'number' },
      { name: 'value', type: 'expression' },
      { name: 'defaultValue', type: 'number' },
      { name: 'disabled', type: 'boolean' },
      { name: 'showTooltip', type: 'boolean' },
      { name: 'size', type: 'select' },
      { name: 'variant', type: 'select' },
      { name: 'onChange', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(    'DatePicker',
    'Form',
    'calendar',
    'Calendar date picker',
    { placeholder: 'Select date...' },
    [
      { name: 'placeholder', type: 'string' },
      { name: 'label', type: 'string' },
      { name: 'value', type: 'expression' },
      { name: 'format', type: 'select' },
      { name: 'min', type: 'string' },
      { name: 'max', type: 'string' },
      { name: 'disabled', type: 'boolean' },
      { name: 'required', type: 'boolean' },
      { name: 'size', type: 'select' },
      { name: 'onChange', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(    'ColorPicker',
    'Form',
    'droplet',
    'Color input',
    { defaultValue: '#6366f1' },
    [
      { name: 'value', type: 'expression' },
      { name: 'defaultValue', type: 'color' },
      { name: 'label', type: 'string' },
      { name: 'showInput', type: 'boolean' },
      { name: 'disabled', type: 'boolean' },
      { name: 'size', type: 'select' },
      { name: 'onChange', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),
  comp(
    'FileChooser',
    'Form',
    'upload',
    'File selection with button and dropzone variants',
    { label: 'Choose File', variant: 'button', multiple: false },
    [
      { name: 'accept', type: 'string' },
      { name: 'multiple', type: 'boolean' },
      { name: 'directory', type: 'boolean' },
      { name: 'label', type: 'string' },
      { name: 'variant', type: 'select' },
      { name: 'onSelect', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(
    'Form',
    'Form',
    'file-text',
    'Form wrapper/container',
    {},
    [
      { name: 'onSubmit', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  // ==================== DISPLAY COMPONENTS ====================
  comp(
    'Text',
    'Display',
    'type',
    'Text rendering',
    { children: 'Hello World', size: 'md' },
    [
      { name: 'size', type: 'select' },
      { name: 'weight', type: 'select' },
      { name: 'color', type: 'color' },
      { name: 'align', type: 'select' },
      { name: 'truncate', type: 'boolean' },
      { name: 'lineClamp', type: 'number' },
      { name: 'children', type: 'string' },
      { name: 'className', type: 'string' },
    ],
    // Its content is its words. One that holds elements among them (a key,
    // a link) still shows them and takes more; a new one is not a container.
    false
  ),

  comp(    'Heading',
    'Display',
    'hash',
    'Semantic heading',
    { level: 1, children: 'Heading' },
    [
      { name: 'level', type: 'select', options: ['1', '2', '3', '4', '5', '6'] },
      { name: 'variant', type: 'select' },
      { name: 'align', type: 'select' },
      { name: 'transform', type: 'select' },
      { name: 'letterSpacing', type: 'select' },
      { name: 'truncate', type: 'boolean' },
      { name: 'underline', type: 'boolean' },
      { name: 'color', type: 'color' },
      { name: 'children', type: 'string' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(
    'Badge',
    'Display',
    'tag',
    'Small badge/label',
    { variant: 'default', children: 'Badge' },
    [
      { name: 'variant', type: 'select' },
      { name: 'size', type: 'select' },
      { name: 'children', type: 'string' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(    'Tag',
    'Display',
    'tag',
    'Tag element',
    { children: 'Tag' },
    [
      { name: 'variant', type: 'select' },
      { name: 'tagStyle', type: 'select' },
      { name: 'size', type: 'select' },
      { name: 'removable', type: 'boolean' },
      { name: 'rounded', type: 'boolean' },
      { name: 'disabled', type: 'boolean' },
      { name: 'onRemove', type: 'event' },
      { name: 'onClick', type: 'event' },
      { name: 'children', type: 'string' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(
    'Avatar',
    'Display',
    'user',
    'User avatar',
    { name: 'Ada Lovelace', size: 'md' },
    [
      { name: 'src', type: 'string', description: 'Image URL' },
      { name: 'name', type: 'string', description: 'Name for initials fallback' },
      { name: 'size', type: 'select', options: ['xs', 'sm', 'md', 'lg', 'xl', '2xl'] },
      { name: 'shape', type: 'select' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(    'Progress',
    'Display',
    'bar-chart-2',
    'Progress bar',
    { value: 50, max: 100 },
    [
      { name: 'value', type: 'number' },
      { name: 'max', type: 'number' },
      { name: 'size', type: 'select' },
      { name: 'variant', type: 'select' },
      { name: 'showLabel', type: 'boolean' },
      { name: 'labelPosition', type: 'select' },
      { name: 'striped', type: 'boolean' },
      { name: 'animated', type: 'boolean' },
      { name: 'indeterminate', type: 'boolean' },
      { name: 'borderRadius', type: 'select' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(
    'Spinner',
    'Display',
    'loader',
    'Loading spinner',
    { size: 'md' },
    [
      { name: 'size', type: 'select' },
      { name: 'color', type: 'color' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(    'Image',
    'Display',
    'image',
    'Image display',
    { alt: 'Image' },
    [
      { name: 'src', type: 'string', description: 'Image URL' },
      { name: 'alt', type: 'string' },
      { name: 'width', type: 'string' },
      { name: 'height', type: 'string' },
      { name: 'objectFit', type: 'select' },
      { name: 'borderRadius', type: 'select' },
      { name: 'fallbackSrc', type: 'string', description: 'Image shown when src fails to load' },
      { name: 'loading', type: 'select' },
      { name: 'showPlaceholder', type: 'boolean' },
      { name: 'onClick', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(
    'Icon',
    'Display',
    'star',
    'SVG icon by name or custom SVG markup',
    { name: 'check', size: 20 },
    [
      { name: 'name', type: 'string' },
      { name: 'svg', type: 'string' },
      { name: 'size', type: 'number' },
      { name: 'color', type: 'color' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  // ==================== FEEDBACK COMPONENTS ====================
  comp(    'Alert',
    'Feedback',
    'alert-circle',
    'Alert message',
    { variant: 'info', children: 'This is an alert message.' },
    [
      { name: 'variant', type: 'select' },
      { name: 'alertStyle', type: 'select' },
      { name: 'title', type: 'string' },
      { name: 'dismissible', type: 'boolean' },
      { name: 'showIcon', type: 'boolean' },
      { name: 'borderRadius', type: 'select' },
      { name: 'onDismiss', type: 'event' },
      { name: 'children', type: 'string' },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(    'Modal',
    'Feedback',
    'square',
    'Modal dialog',
    { title: 'Modal Title' },
    [
      { name: 'title', type: 'string' },
      { name: 'open', type: 'expression' },
      { name: 'size', type: 'select' },
      { name: 'closeOnOverlayClick', type: 'boolean' },
      { name: 'closeOnEscape', type: 'boolean' },
      { name: 'showCloseButton', type: 'boolean' },
      { name: 'centered', type: 'boolean' },
      { name: 'onClose', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(    'Toast',
    'Feedback',
    'bell',
    'Toast notification',
    { message: 'Notification message' },
    [
      { name: 'message', type: 'string' },
      { name: 'title', type: 'string' },
      { name: 'variant', type: 'select' },
      { name: 'duration', type: 'number' },
      { name: 'position', type: 'select' },
      { name: 'showClose', type: 'boolean' },
      { name: 'showProgress', type: 'boolean' },
      { name: 'onClose', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    // What it says is its `message`: it draws nothing written inside it.
    false
  ),

  comp(
    'Drawer',
    'Feedback',
    'sidebar',
    'Side drawer panel',
    { title: 'Drawer' },
    [
      { name: 'title', type: 'string' },
      { name: 'open', type: 'expression' },
      { name: 'position', type: 'select' },
      { name: 'size', type: 'select', options: ['sm', 'md', 'lg', 'xl', 'full'] },
      { name: 'closeOnOverlay', type: 'boolean' },
      { name: 'onClose', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(    'Popover',
    'Feedback',
    'message-square',
    'Popover tooltip',
    { triggerMode: 'click' },
    [
      { name: 'triggerMode', type: 'select' },
      { name: 'placement', type: 'select' },
      { name: 'offset', type: 'number' },
      { name: 'showArrow', type: 'boolean' },
      { name: 'closeOnOutsideClick', type: 'boolean' },
      { name: 'open', type: 'expression' },
      { name: 'onOpenChange', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  // ==================== NAVIGATION COMPONENTS ====================
  comp(    'Tabs',
    'Navigation',
    'folder',
    'Tab navigation',
    // A new one has tabs to show. It started on `tab1` with none, and drew
    // nothing in the running app.
    {
      tabs: [
        { key: 'first', label: 'First' },
        { key: 'second', label: 'Second' },
      ],
      defaultActiveKey: 'first',
    },
    [
      // The row of tabs is all the component draws. This said the content
      // was "the children under each key", which it never reads.
      { name: 'tabs', type: 'json', description: 'Tabs as [{ key, label, disabled? }]. Bind the chosen key with :bind and show each tab’s content in an #if below' },
      { name: 'defaultActiveKey', type: 'string' },
      { name: 'activeKey', type: 'expression' },
      { name: 'variant', type: 'select' },
      { name: 'size', type: 'select' },
      { name: 'fullWidth', type: 'boolean' },
      { name: 'onChange', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(
    'Breadcrumb',
    'Navigation',
    'chevrons-right',
    'Breadcrumb trail',
    // A new one has a trail to show. With no items it drew nothing, on the
    // canvas or in the running app, and was a card to be found by.
    { items: [{ label: 'Home' }, { label: 'Projects' }, { label: 'This page' }] },
    [
      { name: 'separator', type: 'string' },
      { name: 'items', type: 'json', description: 'Array of { label, href } objects' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(    'Menu',
    'Navigation',
    'menu',
    'Navigation menu',
    {  },
    [
      { name: 'items', type: 'json', description: 'Menu items as [{ key, label, icon?, disabled?, divider? }]' },
      { name: 'placement', type: 'select' },
      { name: 'width', type: 'string' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(    'NavItem',
    'Navigation',
    'link',
    'Menu item',
    { label: 'Menu Item' },
    [
      { name: 'label', type: 'string' },
      { name: 'page', type: 'string', description: 'Page to show when chosen' },
      { name: 'navigate', type: 'string', description: 'Route or URL to go to when chosen' },
      { name: 'active', type: 'boolean', default: false },
      { name: 'collapsed', type: 'boolean' },
      { name: 'icon', type: 'string' },
      { name: 'variant', type: 'select' },
      { name: 'onClick', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  // ==================== UTILITY COMPONENTS ====================
  comp(    'Accordion',
    'Utility',
    'chevron-down',
    'Collapsible accordion',
    { multiple: false },
    [
      { name: 'items', type: 'json', description: 'Items as [{ key, header, content, disabled? }]' },
      { name: 'multiple', type: 'boolean' },
      { name: 'defaultOpenKeys', type: 'json', description: 'Keys open at first, as ["a", "b"]' },
      { name: 'variant', type: 'select' },
      { name: 'onChange', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(    'Collapse',
    'Utility',
    'chevron-down',
    'Single collapsible panel',
    { isOpen: true },
    [
      { name: 'isOpen', type: 'expression', description: 'Whether the children are shown' },
      { name: 'duration', type: 'number' },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(    'Tooltip',
    'Utility',
    'info',
    'Tooltip component',
    { content: 'Tooltip text' },
    [
      { name: 'content', type: 'string' },
      { name: 'placement', type: 'select' },
      { name: 'showDelay', type: 'number' },
      { name: 'hideDelay', type: 'number' },
      { name: 'arrow', type: 'boolean' },
      { name: 'variant', type: 'select' },
      { name: 'size', type: 'select' },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  // ==================== DATA COMPONENTS ====================
  comp(    'List',
    'Data',
    'list',
    'List rendering',
    {  },
    [
      { name: 'variant', type: 'select' },
      { name: 'spacing', type: 'select' },
      { name: 'ordered', type: 'boolean' },
      { name: 'hoverable', type: 'boolean' },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(    'ListItem',
    'Data',
    'list',
    'List item',
    {  },
    [
      { name: 'active', type: 'boolean' },
      { name: 'disabled', type: 'boolean' },
      { name: 'onClick', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(    'Table',
    'Data',
    'table',
    'Data table',
    // A new one has two columns and two rows, to be seen and then replaced:
    // it started with neither, and drew "No data available" under no header.
    {
      columns: [
        { key: 'name', header: 'Name' },
        { key: 'role', header: 'Role' },
      ],
      data: [
        { name: 'Ada Lovelace', role: 'Engineer' },
        { name: 'Grace Hopper', role: 'Admiral' },
      ],
      rowKey: 'name',
    },
    [
      { name: 'data', type: 'expression', description: 'Array of row objects' },
      { name: 'columns', type: 'json', description: 'Column definitions' },
      { name: 'rowKey', type: 'string', description: 'Field that identifies a row' },
      { name: 'variant', type: 'select' },
      { name: 'size', type: 'select' },
      { name: 'hoverable', type: 'boolean' },
      { name: 'stickyHeader', type: 'boolean' },
      { name: 'sortColumn', type: 'string' },
      { name: 'sortDirection', type: 'select' },
      { name: 'onSort', type: 'event' },
      { name: 'onRowClick', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(    'TreeView',
    'Data',
    'git-branch',
    'Hierarchical tree structure',
    {  },
    [
      { name: 'nodes', type: 'expression', description: 'Tree nodes as [{ id, label, children? }]' },
      { name: 'defaultExpandAll', type: 'boolean' },
      { name: 'showLines', type: 'boolean' },
      { name: 'indent', type: 'number' },
      { name: 'selectedId', type: 'expression' },
      { name: 'onSelect', type: 'event' },
      { name: 'onExpand', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(    'Pagination',
    'Data',
    'more-horizontal',
    'Page navigation',
    { currentPage: 1, totalPages: 10, pageSize: 10 },
    [
      { name: 'currentPage', type: 'expression', description: 'The page shown (1-based)' },
      { name: 'totalPages', type: 'expression' },
      { name: 'totalItems', type: 'expression' },
      { name: 'pageSize', type: 'number' },
      { name: 'showPageSize', type: 'boolean' },
      { name: 'showTotal', type: 'boolean' },
      { name: 'showFirstLast', type: 'boolean' },
      { name: 'siblingCount', type: 'number' },
      { name: 'size', type: 'select' },
      { name: 'onPageChange', type: 'event' },
      { name: 'onPageSizeChange', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(    'DataGrid',
    'Data',
    'grid',
    'Advanced data grid',
    {  },
    [
      { name: 'data', type: 'expression' },
      { name: 'columns', type: 'json' },
      { name: 'keyField', type: 'string' },
      { name: 'height', type: 'string' },
      { name: 'rowHeight', type: 'number' },
      { name: 'virtualized', type: 'boolean' },
      { name: 'bordered', type: 'boolean' },
      { name: 'striped', type: 'boolean' },
      { name: 'hoverable', type: 'boolean' },
      { name: 'selectionMode', type: 'select' },
      { name: 'sortKey', type: 'string' },
      { name: 'sortDirection', type: 'select' },
      { name: 'loading', type: 'boolean' },
      { name: 'emptyMessage', type: 'string' },
      { name: 'onSort', type: 'event' },
      { name: 'onSelectionChange', type: 'event' },
      { name: 'onCellEdit', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  // ==================== CHART COMPONENTS ====================
  comp(    'LineChart',
    'Charts',
    'trending-up',
    'Line chart visualization',
    { height: 300 },
    [
      { name: 'series', type: 'expression', description: 'Series as [{ name, data: [{ x, y }] }]' },
      { name: 'height', type: 'number' },
      { name: 'width', type: 'number' },
      { name: 'showGrid', type: 'boolean' },
      { name: 'showLegend', type: 'boolean' },
      { name: 'showXAxis', type: 'boolean' },
      { name: 'showYAxis', type: 'boolean' },
      { name: 'xAxisLabel', type: 'string' },
      { name: 'yAxisLabel', type: 'string' },
      { name: 'yMin', type: 'number' },
      { name: 'yMax', type: 'number' },
      { name: 'interactive', type: 'boolean' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(    'BarChart',
    'Charts',
    'bar-chart',
    'Bar chart visualization',
    { height: 300 },
    [
      { name: 'series', type: 'expression', description: 'Series as [{ name, data: [{ label, value }] }]' },
      { name: 'height', type: 'number' },
      { name: 'width', type: 'number' },
      { name: 'orientation', type: 'select' },
      { name: 'grouped', type: 'boolean' },
      { name: 'stacked', type: 'boolean' },
      { name: 'showGrid', type: 'boolean' },
      { name: 'showValues', type: 'boolean' },
      { name: 'showLegend', type: 'boolean' },
      { name: 'interactive', type: 'boolean' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(    'PieChart',
    'Charts',
    'pie-chart',
    'Pie/donut chart',
    { height: 300 },
    [
      { name: 'data', type: 'expression', description: 'Slices as [{ label, value, color? }]' },
      { name: 'height', type: 'number' },
      { name: 'width', type: 'number' },
      { name: 'innerRadius', type: 'number', description: 'Greater than 0 makes a donut' },
      { name: 'showLabels', type: 'boolean' },
      { name: 'showLegend', type: 'boolean' },
      { name: 'showValues', type: 'boolean' },
      { name: 'centerLabel', type: 'string' },
      { name: 'interactive', type: 'boolean' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  // ==================== EDITOR COMPONENTS ====================
  comp(    'CodeEditor',
    'Editors',
    'code',
    'Code syntax highlighting editor',
    { language: 'javascript' },
    [
      // Strictly controlled since the components pass: a value with no
      // @change (or :bind) to write it back cannot be typed into.
      { name: 'value', type: 'expression', description: 'Controlled text: pair with @change or :bind, or use defaultValue' },
      { name: 'defaultValue', type: 'string', description: 'Starting text the editor then owns' },
      { name: 'language', type: 'select' },
      { name: 'placeholder', type: 'string' },
      { name: 'minHeight', type: 'string' },
      { name: 'maxHeight', type: 'string' },
      { name: 'tabSize', type: 'number' },
      { name: 'readOnly', type: 'boolean' },
      { name: 'disabled', type: 'boolean' },
      { name: 'lineNumbers', type: 'boolean' },
      { name: 'onChange', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(    'MarkdownEditor',
    'Editors',
    'file-text',
    'Markdown editor',
    {  },
    [
      { name: 'value', type: 'expression' },
      { name: 'defaultValue', type: 'string' },
      { name: 'placeholder', type: 'string' },
      { name: 'viewMode', type: 'select' },
      { name: 'showToolbar', type: 'boolean' },
      { name: 'minHeight', type: 'string' },
      { name: 'maxHeight', type: 'string' },
      { name: 'readOnly', type: 'boolean' },
      { name: 'disabled', type: 'boolean' },
      { name: 'onChange', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(    'RichTextEditor',
    'Editors',
    'edit-3',
    'WYSIWYG rich text editor',
    {  },
    [
      { name: 'value', type: 'expression' },
      { name: 'defaultValue', type: 'string' },
      { name: 'placeholder', type: 'string' },
      { name: 'showToolbar', type: 'boolean' },
      { name: 'minHeight', type: 'string' },
      { name: 'maxHeight', type: 'string' },
      { name: 'readOnly', type: 'boolean' },
      { name: 'disabled', type: 'boolean' },
      { name: 'onChange', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  // ==================== SMART COMPONENTS ====================
  comp(
    'SmartGrid',
    'Smart',
    'table',
    'Auto data grid with search, sort, pagination, CRUD',
    {},
    [
      { name: 'data', type: 'expression' },
      { name: 'columns', type: 'string', description: 'Comma-separated column names' },
      { name: 'search', type: 'boolean' },
      { name: 'sort', type: 'boolean' },
      { name: 'pagination', type: 'boolean' },
      { name: 'edit', type: 'boolean' },
      { name: 'delete', type: 'boolean' },
      { name: 'onEdit', type: 'event' },
      { name: 'onDelete', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(    'SmartForm',
    'Smart',
    'file-text',
    'Auto form generation from field specs',
    {  },
    [
      { name: 'fields', type: 'string', description: 'Comma-separated field specs (name, email:email, role:select)' },
      { name: 'data', type: 'expression' },
      { name: 'title', type: 'string' },
      { name: 'description', type: 'string' },
      { name: 'layout', type: 'select' },
      { name: 'columns', type: 'number' },
      { name: 'submitText', type: 'string' },
      { name: 'cancelText', type: 'string' },
      { name: 'showCancel', type: 'boolean' },
      { name: 'loading', type: 'boolean' },
      { name: 'disabled', type: 'boolean' },
      { name: 'collection', type: 'string', description: 'XDB collection to save into' },
      { name: 'recordId', type: 'expression' },
      { name: 'mode', type: 'select' },
      { name: 'onSubmit', type: 'event' },
      { name: 'onChange', type: 'event' },
      { name: 'onCancel', type: 'event' },
      { name: 'onSaved', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(    'SmartView',
    'Smart',
    'eye',
    'Data display view',
    {  },
    [
      { name: 'data', type: 'expression' },
      { name: 'fields', type: 'string', description: 'Comma-separated field names' },
      { name: 'layout', type: 'select' },
      { name: 'gridColumns', type: 'number' },
      { name: 'showLabels', type: 'boolean' },
      { name: 'labelPosition', type: 'select' },
      { name: 'title', type: 'string' },
      { name: 'showEmpty', type: 'boolean' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(    'SmartStats',
    'Smart',
    'bar-chart-2',
    'Statistics display',
    {  },
    [
      { name: 'stats', type: 'expression', description: 'Comma-separated stat definitions, or [{ label, value, icon?, trend? }]' },
      { name: 'icons', type: 'string' },
      { name: 'trends', type: 'string' },
      { name: 'layout', type: 'select' },
      { name: 'columns', type: 'number' },
      { name: 'variant', type: 'select' },
      { name: 'size', type: 'select' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(    'SmartCards',
    'Smart',
    'credit-card',
    'Card-based data display',
    {  },
    [
      { name: 'data', type: 'expression' },
      { name: 'title', type: 'string', description: 'Field shown as the title' },
      { name: 'subtitle', type: 'string', description: 'Field shown under the title' },
      { name: 'description', type: 'string', description: 'Field shown as the description' },
      { name: 'image', type: 'string', description: 'Field holding the image URL' },
      { name: 'badges', type: 'string' },
      { name: 'meta', type: 'string' },
      { name: 'columns', type: 'number' },
      { name: 'variant', type: 'select' },
      { name: 'searchable', type: 'boolean' },
      { name: 'selectable', type: 'boolean' },
      { name: 'emptyMessage', type: 'string' },
      { name: 'onSelect', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(    'SmartList',
    'Smart',
    'list',
    'List with features',
    {  },
    [
      { name: 'data', type: 'expression' },
      { name: 'primary', type: 'string', description: 'Field shown first' },
      { name: 'secondary', type: 'string', description: 'Field shown second' },
      { name: 'tertiary', type: 'string' },
      { name: 'badge', type: 'string' },
      { name: 'avatar', type: 'string' },
      { name: 'icon', type: 'string' },
      { name: 'dividers', type: 'boolean' },
      { name: 'variant', type: 'select' },
      { name: 'selectable', type: 'boolean' },
      { name: 'maxItems', type: 'number' },
      { name: 'showViewAll', type: 'boolean' },
      { name: 'emptyMessage', type: 'string' },
      { name: 'onSelect', type: 'event' },
      { name: 'onViewAll', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(    'SmartTimeline',
    'Smart',
    'clock',
    'Timeline visualization',
    {  },
    [
      { name: 'data', type: 'expression' },
      { name: 'time', type: 'string', description: 'Field holding the time' },
      { name: 'title', type: 'string', description: 'Field shown as the title' },
      { name: 'description', type: 'string', description: 'Field shown as the description' },
      { name: 'status', type: 'string' },
      { name: 'actor', type: 'string' },
      { name: 'variant', type: 'select' },
      { name: 'showLine', type: 'boolean' },
      { name: 'maxItems', type: 'number' },
      { name: 'emptyMessage', type: 'string' },
      { name: 'onSelect', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  // ==================== MISSING COMPONENT COVERAGE ====================
  comp(    'EmptyState',
    'Feedback',
    'inbox',
    'Empty state placeholder with title and description',
    { title: 'No data yet', description: 'Get started by creating your first item.' },
    [
      { name: 'title', type: 'string' },
      { name: 'description', type: 'string' },
      { name: 'size', type: 'select' },
      { name: 'variant', type: 'select' },
      { name: 'animated', type: 'boolean' },
      { name: 'className', type: 'string' },
    ],
    // What is put in it is drawn under its description: the button that
    // adds the first one. Its `action` props take an element, which a page
    // has no way to write, so its children are where its actions go.
    true
  ),
  comp(    'Loop',
    'Utility',
    'repeat',
    'Render repeated content from an array expression',
    { interval: 1000, running: false },
    [
      { name: 'interval', type: 'number', description: 'Milliseconds between ticks' },
      { name: 'running', type: 'expression' },
      { name: 'onTick', type: 'event' },
    ],
    false
  ),
  comp(    'PixelGrid',
    'Utility',
    'grid',
    'Pixel-art style grid renderer',
    { rows: 16, cols: 16, cellSize: 12 },
    [
      { name: 'rows', type: 'number' },
      { name: 'cols', type: 'number' },
      { name: 'cellSize', type: 'number' },
      { name: 'items', type: 'expression', description: 'Cells as [{ x, y, color }]' },
      { name: 'background', type: 'color' },
      { name: 'showGrid', type: 'boolean' },
      { name: 'gridColor', type: 'color' },
      { name: 'className', type: 'string' },
    ],
    false
  ),
  comp(
    'PixelCanvas',
    'Utility',
    'monitor',
    'Canvas surface for dense bitmap frames, indexed or RGBA',
    { width: 160, height: 144, running: true },
    [
      { name: 'width', type: 'number' },
      { name: 'height', type: 'number' },
      // Omitted, the canvas takes the largest whole multiple that fits.
      { name: 'scale', type: 'number' },
      { name: 'palette', type: 'expression' },
      { name: 'getFrame', type: 'expression' },
      { name: 'frame', type: 'expression' },
      { name: 'running', type: 'boolean' },
      { name: 'smooth', type: 'boolean' },
      { name: 'onFps', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),
  comp(
    'AudioStream',
    'Utility',
    'audio-lines',
    'Gapless streaming PCM sink pulled from a producer function',
    { sampleRate: 48000, channels: 2, format: 'i16' },
    [
      { name: 'getSamples', type: 'expression' },
      { name: 'sampleRate', type: 'number' },
      { name: 'channels', type: 'select', options: ['1', '2'] },
      { name: 'format', type: 'select' },
      { name: 'bufferMs', type: 'number' },
      { name: 'running', type: 'boolean' },
      { name: 'muted', type: 'boolean' },
      { name: 'volume', type: 'number' },
      { name: 'showControls', type: 'boolean' },
      { name: 'unlockLabel', type: 'string' },
      { name: 'onReady', type: 'event' },
      { name: 'onUnderrun', type: 'event' },
      { name: 'onError', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    true
  ),
  comp(
    'QRCode',
    'Utility',
    'qr-code',
    'Canvas-based QR code generator',
    { value: 'https://softn.com', size: 256 },
    [
      { name: 'value', type: 'string' },
      { name: 'size', type: 'number' },
      { name: 'color', type: 'color' },
      { name: 'bgColor', type: 'color' },
      { name: 'errorCorrection', type: 'select' },
      { name: 'className', type: 'string' },
    ],
    false
  ),
  comp(
    'QRReader',
    'Utility',
    'scan',
    'Camera-based QR code scanner',
    { facing: 'environment', width: 640, height: 480, active: true },
    [
      { name: 'onScan', type: 'event' },
      { name: 'facing', type: 'select' },
      { name: 'width', type: 'number' },
      { name: 'height', type: 'number' },
      { name: 'active', type: 'boolean' },
    ],
    false
  ),
  comp(
    'Camera',
    'Utility',
    'camera',
    'Camera component for photo, video, and live streaming',
    { mode: 'photo', facing: 'user', width: 640, height: 480 },
    [
      { name: 'mode', type: 'select' },
      { name: 'facing', type: 'select' },
      { name: 'width', type: 'number' },
      { name: 'height', type: 'number' },
      { name: 'active', type: 'boolean' },
      { name: 'showControls', type: 'boolean' },
      { name: 'onCapture', type: 'event' },
      { name: 'onFrame', type: 'event' },
      { name: 'onRecord', type: 'event' },
      { name: 'onError', type: 'event' },
    ],
    true
  ),
  comp(
    'Microphone',
    'Utility',
    'mic',
    'Record audio as WAV, stream samples live, or meter the level',
    { mode: 'clip', sampleRate: 48000, processing: true },
    [
      { name: 'mode', type: 'select' },
      { name: 'active', type: 'boolean' },
      { name: 'sampleRate', type: 'number' },
      { name: 'frameSize', type: 'number' },
      // Echo cancellation, noise suppression and gain control together. On for
      // speech; off for anything measuring the sound rather than listening to it.
      { name: 'processing', type: 'boolean' },
      { name: 'showControls', type: 'boolean' },
      { name: 'showMeter', type: 'boolean' },
      { name: 'maxSeconds', type: 'number' },
      { name: 'autoStart', type: 'boolean' },
      { name: 'onCapture', type: 'event' },
      { name: 'onSamples', type: 'event' },
      { name: 'onLevel', type: 'event' },
      { name: 'onStart', type: 'event' },
      { name: 'onStop', type: 'event' },
      { name: 'onError', type: 'event' },
    ],
    true
  ),
  comp(
    'DPad',
    'Utility',
    'gamepad',
    'Directional pad for game controls',
    { buttonSize: 56, visible: true },
    [
      { name: 'onPress', type: 'event' },
      { name: 'onRelease', type: 'event' },
      { name: 'buttonSize', type: 'number' },
      { name: 'color', type: 'color' },
      { name: 'visible', type: 'boolean' },
    ],
    false
  ),
  comp(
    'AnimatedBox',
    'Utility',
    'sparkles',
    'Container with preset enter/exit animation',
    // `fade` was offered here and is no animation the component has.
    { animation: 'fadeIn', duration: 300, trigger: 'mount' },
    [
      { name: 'animation', type: 'select' },
      { name: 'duration', type: 'number' },
      { name: 'trigger', type: 'select' },
      { name: 'className', type: 'string' },
    ],
    true
  ),
  comp(
    'AnimatedNumber',
    'Display',
    'hash',
    'Animated number counter',
    { value: 100, duration: 1200, decimals: 0 },
    [
      { name: 'value', type: 'number' },
      { name: 'duration', type: 'number' },
      { name: 'decimals', type: 'number' },
      { name: 'prefix', type: 'string' },
      { name: 'suffix', type: 'string' },
      { name: 'className', type: 'string' },
    ],
    false
  ),
  comp(
    'Marquee',
    'Utility',
    'move-horizontal',
    'Scrolling marquee text/content',
    { speed: 40, direction: 'left', pauseOnHover: true },
    [
      { name: 'speed', type: 'number' },
      { name: 'direction', type: 'select' },
      { name: 'pauseOnHover', type: 'boolean' },
      { name: 'className', type: 'string' },
    ],
    true
  ),
  comp(
    'Typewriter',
    'Display',
    'keyboard',
    'Typewriter text animation',
    { text: 'Hello, SoftN!', speed: 60, loop: false },
    [
      { name: 'text', type: 'string' },
      { name: 'speed', type: 'number' },
      { name: 'loop', type: 'boolean', default: false },
      { name: 'className', type: 'string' },
    ],
    false
  ),
  comp(    'Draggable',
    'Utility',
    'move',
    'Drag-and-drop wrapper for any child content',
    { axis: 'both' },
    [
      { name: 'axis', type: 'select' },
      { name: 'disabled', type: 'boolean' },
      { name: 'grid', type: 'number' },
      { name: 'onDragStart', type: 'event' },
      { name: 'onDrag', type: 'event' },
      { name: 'onDragEnd', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    true
  ),
  comp(    'SortableList',
    'Data',
    'list-ordered',
    'Sortable list with drag reordering',
    { items: '[]', renderKey: 'id' },
    [
      { name: 'items', type: 'expression' },
      { name: 'renderKey', type: 'string', description: 'Field that identifies an item' },
      { name: 'primary', type: 'string' },
      { name: 'secondary', type: 'string' },
      { name: 'direction', type: 'select' },
      { name: 'gap', type: 'number' },
      { name: 'onReorder', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),
  comp(
    'PanView',
    'Layout',
    'move',
    'Scrollable window onto content larger than the space for it — drag, wheel or arrow keys to pan',
    { contentWidth: 800, contentHeight: 600, scale: 1, centered: true, draggable: true },
    [
      { name: 'contentWidth', type: 'number' },
      { name: 'contentHeight', type: 'number' },
      { name: 'scale', type: 'number' },
      { name: 'centered', type: 'boolean' },
      { name: 'recenterKey', type: 'expression' },
      { name: 'draggable', type: 'boolean' },
      { name: 'background', type: 'string' },
      { name: 'label', type: 'string' },
      { name: 'className', type: 'string' },
    ],
    true
  ),
  comp(
    'Sprite',
    'Utility',
    'film',
    'CSS-based sprite sheet renderer with animation',
    { frameWidth: 32, frameHeight: 32, columns: 8, rows: 4, row: 0, fps: 10, scale: 1 },
    [
      { name: 'src', type: 'string' },
      { name: 'frameWidth', type: 'number' },
      { name: 'frameHeight', type: 'number' },
      { name: 'columns', type: 'number' },
      { name: 'rows', type: 'number' },
      { name: 'row', type: 'number' },
      { name: 'colOffset', type: 'number' },
      { name: 'playing', type: 'boolean' },
      { name: 'fps', type: 'number' },
      { name: 'scale', type: 'number' },
      { name: 'className', type: 'string' },
    ],
    false
  ),
  comp(
    'TileMap',
    'Utility',
    'map',
    'Canvas-based tilemap renderer from tileset image',
    { tileSize: 32, tilesetColumns: 16, mapWidth: 16, mapHeight: 16, scale: 1 },
    // TileMap works its props out before it draws (sized(), TileMap.tsx), so
    // the manifest cannot read their defaults: these are those it gives. The
    // map's width and height are the widest and tallest of its layers.
    [
      { name: 'src', type: 'string' },
      { name: 'tileSize', type: 'number', default: 32 },
      { name: 'tilesetColumns', type: 'number', default: 16 },
      { name: 'layers', type: 'expression' },
      { name: 'mapWidth', type: 'number' },
      { name: 'mapHeight', type: 'number' },
      { name: 'scale', type: 'number', default: 1 },
      { name: 'className', type: 'string' },
    ],
    false
  ),
  comp(    'AreaChart',
    'Charts',
    'area-chart',
    'Area chart visualization',
    { series: '[]' },
    [
      { name: 'series', type: 'expression', description: 'Series as [{ name, data: [{ x, y }] }]' },
      { name: 'height', type: 'number' },
      { name: 'width', type: 'number' },
      { name: 'stacked', type: 'boolean' },
      { name: 'gradient', type: 'boolean' },
      { name: 'showGrid', type: 'boolean' },
      { name: 'showLegend', type: 'boolean' },
      { name: 'xAxisLabel', type: 'string' },
      { name: 'yAxisLabel', type: 'string' },
      { name: 'interactive', type: 'boolean' },
      { name: 'className', type: 'string' },
    ],
    false
  ),
  comp(    'RadarChart',
    'Charts',
    'radar',
    'Radar/spider chart visualization',
    { series: '[]', axes: '[]' },
    [
      { name: 'series', type: 'expression', description: 'Series as [{ name, data: [{ axis, value }] }]' },
      { name: 'axes', type: 'expression', description: 'Axis names as ["speed", "power"]' },
      { name: 'maxValue', type: 'number' },
      { name: 'levels', type: 'number' },
      { name: 'height', type: 'number' },
      { name: 'width', type: 'number' },
      { name: 'showLegend', type: 'boolean' },
      { name: 'interactive', type: 'boolean' },
      { name: 'className', type: 'string' },
    ],
    false
  ),
  comp(
    'GaugeChart',
    'Charts',
    'gauge',
    'Gauge chart for single-value progress',
    { value: 65, min: 0, max: 100 },
    [
      { name: 'value', type: 'number' },
      { name: 'min', type: 'number' },
      { name: 'max', type: 'number' },
      { name: 'label', type: 'string' },
      { name: 'className', type: 'string' },
    ],
    false
  ),
  comp(
    'Scene3D',
    'Display',
    'cube',
    'Interactive 3D scene viewer',
    { width: 800, height: 600, orbitControls: true },
    [
      { name: 'width', type: 'number' },
      { name: 'height', type: 'number' },
      { name: 'background', type: 'color' },
      { name: 'shadows', type: 'boolean' },
      { name: 'orbitControls', type: 'boolean' },
      { name: 'autoRotate', type: 'boolean' },
      { name: 'autoRotateSpeed', type: 'number' },
      { name: 'mouseLook', type: 'boolean' },
      { name: 'mouseLookSensitivity', type: 'number' },
      { name: 'pointerLock', type: 'boolean' },
      { name: 'pitchLimit', type: 'number' },
      { name: 'cameraSmoothing', type: 'number' },
      { name: 'maxPixelRatio', type: 'number' },
      { name: 'expandable', type: 'boolean' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  // ==================== VALUES, PROGRESS AND HISTORY ====================
  comp(
    'Stat',
    'Display',
    'trending-up',
    'One figure with its label and how it moved',
    { label: 'Open tasks', value: '128', change: 12, changeLabel: 'since last week' },
    [
      { name: 'label', type: 'string' },
      { name: 'value', type: 'string', description: 'The figure, or an expression for it' },
      { name: 'prefix', type: 'string', description: 'Text before the value, such as a currency sign' },
      { name: 'suffix', type: 'string', description: 'Text after the value, such as a unit' },
      { name: 'change', type: 'expression', description: 'A number is shown as a percentage, text as written' },
      { name: 'changeLabel', type: 'string', description: 'What the change is measured against' },
      { name: 'trend', type: 'select', description: 'Worked out from a numeric change when left empty' },
      { name: 'positive', type: 'select', description: 'Which direction is good news' },
      { name: 'helpText', type: 'string' },
      { name: 'variant', type: 'select' },
      { name: 'size', type: 'select' },
      { name: 'align', type: 'select' },
      { name: 'className', type: 'string' },
    ],
    true
  ),
  comp(
    'Kbd',
    'Display',
    'keyboard',
    'A keyboard key or shortcut',
    { keys: 'Ctrl+K' },
    [
      { name: 'keys', type: 'string', description: 'A key, or keys joined with +' },
      { name: 'separator', type: 'string' },
      { name: 'size', type: 'select' },
      { name: 'className', type: 'string' },
    ],
    false
  ),
  comp(
    'Skeleton',
    'Display',
    'text',
    'Loading placeholder shaped like the content to come',
    { variant: 'text', lines: 3 },
    [
      { name: 'variant', type: 'select' },
      { name: 'width', type: 'string' },
      { name: 'height', type: 'string' },
      { name: 'lines', type: 'number', description: 'Lines of text (text variant)' },
      { name: 'animation', type: 'select' },
      { name: 'speed', type: 'select' },
      { name: 'loading', type: 'expression', description: 'While true the placeholder shows; after, the children' },
      { name: 'className', type: 'string' },
    ],
    true
  ),
  comp(
    'Steps',
    'Navigation',
    'breadcrumb',
    'Where someone is in a sequence of steps',
    { items: ['Details', 'Review', 'Done'], current: 1 },
    [
      { name: 'items', type: 'json', description: 'Step names, or [{ key?, label, description?, disabled? }]' },
      { name: 'current', type: 'expression', description: 'The step in progress: its position from zero, or its key' },
      { name: 'orientation', type: 'select' },
      { name: 'size', type: 'select' },
      { name: 'status', type: 'select' },
      { name: 'onChange', type: 'event', description: 'Makes the steps buttons; receives the chosen step' },
      { name: 'className', type: 'string' },
    ],
    false
  ),
  comp(
    'Timeline',
    'Data',
    'list',
    'Things that happened, in order, on a line',
    { items: [{ title: 'Created', time: 'Mon' }, { title: 'Reviewed', time: 'Tue', variant: 'success' }] },
    [
      { name: 'items', type: 'json', description: 'Entries as [{ title, description?, time?, variant?, key? }]' },
      { name: 'size', type: 'select' },
      { name: 'timePosition', type: 'select' },
      { name: 'showLine', type: 'boolean' },
      { name: 'reverse', type: 'boolean', description: 'Newest first' },
      { name: 'emptyText', type: 'string', description: 'Shown when there are no entries' },
      { name: 'className', type: 'string' },
    ],
    false
  ),
  comp(
    'Rating',
    'Form',
    'star',
    'A score out of a few stars, to read or to set',
    { max: 5, defaultValue: 3 },
    [
      { name: 'value', type: 'expression' },
      { name: 'defaultValue', type: 'number' },
      { name: 'max', type: 'number' },
      { name: 'readOnly', type: 'boolean' },
      { name: 'disabled', type: 'boolean' },
      { name: 'allowClear', type: 'boolean', description: 'Choosing the current score again clears it' },
      { name: 'size', type: 'select' },
      { name: 'character', type: 'string', description: 'The character drawn for each star' },
      { name: 'color', type: 'color' },
      { name: 'onChange', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),
  comp(
    'SegmentedControl',
    'Form',
    'toggle',
    'A choice of one from a few, side by side',
    { options: ['List', 'Board', 'Calendar'], defaultValue: 'List' },
    [
      { name: 'options', type: 'json', description: 'Values, or [{ value, label?, disabled? }]' },
      { name: 'value', type: 'expression' },
      { name: 'defaultValue', type: 'string' },
      { name: 'size', type: 'select' },
      { name: 'fullWidth', type: 'boolean' },
      { name: 'disabled', type: 'boolean' },
      { name: 'onChange', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),
  comp(
    'NumberInput',
    'Form',
    'input',
    'A number to type or to step',
    { defaultValue: 1, min: 0, step: 1 },
    [
      { name: 'value', type: 'expression' },
      { name: 'defaultValue', type: 'number' },
      { name: 'min', type: 'number' },
      { name: 'max', type: 'number' },
      { name: 'step', type: 'number' },
      { name: 'precision', type: 'number', description: 'Decimal places kept; worked out from the step when empty' },
      { name: 'placeholder', type: 'string' },
      { name: 'disabled', type: 'boolean' },
      { name: 'readOnly', type: 'boolean' },
      { name: 'error', type: 'boolean' },
      { name: 'hideControls', type: 'boolean' },
      { name: 'size', type: 'select' },
      { name: 'fullWidth', type: 'boolean' },
      { name: 'onChange', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  // ==================== THE PIECES APPS LAID OUT BY HAND ====================
  comp(
    'DescriptionList',
    'Display',
    'list',
    'The facts about one thing: labels and their values',
    {
      items: [
        { label: 'Status', value: 'Shipped' },
        { label: 'Customer', value: 'Ada Lovelace' },
        { label: 'Total', value: '$48.00' },
      ],
      columns: 1,
    },
    [
      { name: 'items', type: 'json', description: '[{ label, value, hint? }], or a record whose keys are the labels' },
      { name: 'columns', type: 'number', description: '1 to 4; fewer where there is not the room' },
      { name: 'layout', type: 'select' },
      { name: 'size', type: 'select' },
      { name: 'dividers', type: 'boolean' },
      { name: 'emptyText', type: 'string', description: 'Shown for a value that is not there' },
      { name: 'labelWidth', type: 'string', description: 'Width of the labels in the inline layout' },
      { name: 'className', type: 'string' },
    ],
    false
  ),
  comp(
    'Field',
    'Form',
    'input',
    'A label, a hint and an error around any control',
    { label: 'Label', hint: 'A note about this field' },
    [
      { name: 'label', type: 'string' },
      { name: 'hint', type: 'string' },
      { name: 'error', type: 'expression', description: 'Text shown in place of the hint; true marks the field without a message' },
      { name: 'required', type: 'boolean' },
      { name: 'layout', type: 'select' },
      { name: 'labelWidth', type: 'string', description: 'Width of the label in the horizontal layout' },
      { name: 'disabled', type: 'boolean' },
      { name: 'className', type: 'string' },
    ],
    true
  ),
  comp(
    'CopyButton',
    'Form',
    'copy',
    'A button that copies text and says it has',
    // Its children are its label (`children ?? label ?? 'Copy'`), so its
    // words are its Text like a Button's: a new one says "Copy" as text,
    // where it used to be given a `label` and no Text field to change it in.
    { value: 'Text to copy', children: 'Copy' },
    [
      { name: 'value', type: 'string', description: 'The text to copy; {invite} for a value from logic' },
      { name: 'children', type: 'string', default: 'Copy' },
      { name: 'label', type: 'string', description: 'The same words as a property; the Text above is used when both are there' },
      { name: 'copiedLabel', type: 'string' },
      { name: 'iconOnly', type: 'boolean' },
      { name: 'variant', type: 'select', options: ['primary', 'secondary', 'outline', 'danger', 'success', 'warning', 'ghost', 'link'] },
      { name: 'size', type: 'select', options: ['xs', 'sm', 'md', 'lg', 'xl'] },
      { name: 'resetAfter', type: 'number', description: 'How long it says it has copied, in milliseconds' },
      { name: 'disabled', type: 'boolean' },
      { name: 'onCopy', type: 'event' },
      { name: 'onError', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),
  comp(
    'ButtonGroup',
    'Form',
    'button',
    'Buttons that belong together, joined edge to edge',
    {},
    [
      { name: 'orientation', type: 'select' },
      { name: 'attached', type: 'boolean', description: 'Off keeps the buttons apart with a small gap' },
      { name: 'fullWidth', type: 'boolean' },
      { name: 'className', type: 'string' },
    ],
    true,
    ['Button']
  ),
  comp(
    'Confirm',
    'Feedback',
    'message-square',
    'A question with two answers, asked before something is done',
    { title: 'Are you sure?', message: 'This cannot be undone.', confirmText: 'Confirm', cancelText: 'Cancel' },
    [
      { name: 'open', type: 'expression', description: 'Whether the question is being asked' },
      { name: 'title', type: 'string' },
      { name: 'message', type: 'string' },
      { name: 'confirmText', type: 'string' },
      { name: 'cancelText', type: 'string' },
      { name: 'variant', type: 'select' },
      { name: 'loading', type: 'expression', description: 'While true both answers are held' },
      { name: 'size', type: 'select' },
      { name: 'onConfirm', type: 'event' },
      { name: 'onCancel', type: 'event', description: 'The other button, Escape, or a click outside' },
      { name: 'className', type: 'string' },
    ],
    true
  ),
  comp(
    'AvatarGroup',
    'Display',
    'user',
    'Avatars overlapping in a row, with a count of the rest',
    { max: 4, size: 'md' },
    [
      { name: 'max', type: 'number', description: 'How many to show before "+N"' },
      { name: 'size', type: 'select' },
      { name: 'spacing', type: 'number', description: 'Pixels between avatars; negative overlaps them (default -8)' },
      { name: 'borderColor', type: 'color', description: 'The ring that parts each from the next; the page colour by default' },
      { name: 'className', type: 'string' },
    ],
    true,
    ['Avatar']
  ),
  comp(
    'TagGroup',
    'Display',
    'tag',
    'A row of tags that wraps',
    { gap: 'sm' },
    [
      { name: 'gap', type: 'select', options: ['xs', 'sm', 'md', 'lg'] },
      { name: 'wrap', type: 'boolean' },
      { name: 'className', type: 'string' },
    ],
    true,
    ['Tag']
  ),
];

/**
 * The accessibility props the components take (component-manifest.json), and
 * the few others added with them. Kept as one table rather than spread over
 * thirty entries, so what a screen reader is told is edited in one place. The
 * property panel files these under Accessibility (ACCESSIBILITY_PROP_NAMES).
 */
const ariaLabel = (description: string): PropSchema => ({ name: 'ariaLabel', type: 'string', description });
const NAME_WHEN_UNLABELLED = 'Accessible name, read by screen readers when nothing visible names it';
const CHART_ALTERNATIVE = 'Text alternative for the chart; a summary of its values by default';

const MANIFEST_PROPS: Record<string, PropSchema[]> = {
  Accordion: [{ name: 'headingLevel', type: 'number', description: 'Heading level of the item headers (2–6, default 3)' }],
  Alert: [
    {
      name: 'role',
      type: 'select',
      description: 'How it is announced: alert at once, status when the reader is free, none for an alert that is part of the page',
    },
  ],
  AreaChart: [ariaLabel(CHART_ALTERNATIVE)],
  Avatar: [ariaLabel('Accessible label, for an interactive avatar')],
  BarChart: [ariaLabel(CHART_ALTERNATIVE)],
  CodeEditor: [ariaLabel('Accessible name for the text field, when no visible label names it')],
  ButtonGroup: [ariaLabel('What the group of buttons is for')],
  DPad: [ariaLabel('Accessible name for the pad as a whole')],
  DataGrid: [ariaLabel('Accessible name for the grid')],
  Drawer: [ariaLabel('Accessible name for the drawer when it has no title')],
  GaugeChart: [ariaLabel('Accessible name for the meter; the label, or "Gauge", by default')],
  Icon: [ariaLabel('What the icon means, when nothing beside it says so; without one the icon is decoration')],
  LineChart: [ariaLabel(CHART_ALTERNATIVE)],
  MarkdownEditor: [
    ariaLabel('Accessible name for the text area (default "Markdown")'),
    { name: 'onViewModeChange', type: 'event', description: 'Called when the user switches view mode' },
  ],
  Menu: [ariaLabel('Accessible name for the trigger, when its content (an icon) does not give one')],
  Modal: [ariaLabel('Accessible name for the dialog when it has no title')],
  NumberInput: [ariaLabel('Accessible name, when no visible label names the field')],
  Pagination: [ariaLabel(NAME_WHEN_UNLABELLED)],
  PieChart: [ariaLabel(CHART_ALTERNATIVE)],
  PixelCanvas: [ariaLabel(NAME_WHEN_UNLABELLED)],
  Popover: [ariaLabel('Accessible name for the popup')],
  Progress: [ariaLabel('Accessible name for the bar (default "Progress")')],
  QRCode: [ariaLabel(NAME_WHEN_UNLABELLED)],
  RadarChart: [ariaLabel(CHART_ALTERNATIVE)],
  Rating: [ariaLabel('Accessible name for the group (default "Rating")')],
  RichTextEditor: [ariaLabel(NAME_WHEN_UNLABELLED)],
  Section: [{ name: 'headingLevel', type: 'number', description: 'Heading level of the title (1–6, default 2)' }],
  SegmentedControl: [ariaLabel('Accessible name for the group')],
  Slider: [ariaLabel('Accessible name for the slider')],
  SortableList: [ariaLabel(NAME_WHEN_UNLABELLED)],
  Spacer: [{ name: 'className', type: 'string' }],
  Split: [ariaLabel('Accessible name for the divider (default "Resize panes")')],
  Sprite: [ariaLabel(NAME_WHEN_UNLABELLED)],
  Steps: [ariaLabel('Accessible name for the list (default "Progress")')],
  Table: [
    { name: 'caption', type: 'string', description: 'Visible caption naming the table' },
    ariaLabel('Accessible name for the table, when it has no caption'),
  ],
  Tabs: [ariaLabel(NAME_WHEN_UNLABELLED)],
  Tag: [{ name: 'removeLabel', type: 'string', description: 'Accessible name for the remove button (default "Remove" and the tag’s text)' }],
  Timeline: [ariaLabel('Accessible name for the list (default "Timeline")')],
  TreeView: [ariaLabel(NAME_WHEN_UNLABELLED)],
};

/** Props the property panel shows under Accessibility rather than Advanced. */
export const ACCESSIBILITY_PROP_NAMES: ReadonlySet<string> = new Set(['ariaLabel', 'removeLabel', 'caption', 'headingLevel', 'role']);

/**
 * Components that draw a fixed number of children and no more. A Split
 * takes its first two for its panes; a third was on the canvas and in the
 * file, and not on the page.
 */
const MAX_CHILDREN: Record<string, number> = { Split: 2 };

/**
 * The components that stand in a line of words: each draws a `span` or a
 * `kbd`, or a box laid out inline, has no width of its own to fill, and
 * does nothing when pressed. An element whose content is its words takes
 * one of these beside the words (utils/blocks.ts, takesInline), which is
 * how `<Button><Icon name="plus" /> Add</Button>` is made on the canvas.
 *
 * Read from the component sources: Icon is a `span` around its `svg`, Kbd a
 * `kbd`, Badge and Tag a `span`, each `inline-flex`; Spinner is a `div`
 * laid out `inline-flex`. AnimatedNumber and Typewriter (a `span` each) and
 * Avatar (an inline box) would fit the same description and are left out
 * until somebody wants them: each one more is one more thing a drag over a
 * heading goes into.
 */
const INLINE_KINDS: ReadonlySet<string> = new Set(['Icon', 'Kbd', 'Badge', 'Tag', 'Spinner']);

/**
 * The components the canvas draws as themselves (components/canvas/
 * DrawnComponent.tsx), where every other is a card with its name on it. A
 * component is here only when all of this holds for it:
 *
 *  - mounted with what a page can write for it and no handler, it listens
 *    to nothing on the document or the window and starts no timer, frame or
 *    observer (held for each one by drawnComponents.test.ts), so it cannot
 *    take a key or a pointer from the canvas while it sits there;
 *  - it opens nothing over the page: no dialog, drawer, toast or popup that
 *    is laid out outside its own box;
 *  - it asks for no device and draws from no data the canvas does not have;
 *  - what it shows is there without its children, or its children are words:
 *    the canvas puts an element's own children below its drawing, which is
 *    the wrong place for a component that lays them out itself.
 *
 * Left out, each for one of those: Modal, Drawer, Toast, Popover, Tooltip,
 * Menu and Confirm open over the page (and Modal, Toast and Confirm start a
 * timer as they mount); AnimatedBox, AnimatedNumber, Sprite, GaugeChart,
 * Typewriter, Marquee and PanView start a frame, a timer or an observer;
 * Camera, Microphone, AudioStream, QRReader, Scene3D, TileMap and the pixel
 * canvases ask for a device or a scene to paint; the charts, the Smart
 * components, DataGrid and TreeView draw from data the canvas does not
 * have, and would be a picture of numbers nobody wrote; and every layout
 * component, the groups (TagGroup, AvatarGroup, ButtonGroup), List, Field,
 * Accordion, Collapse and NavItem are their children laid out. Spacer is
 * nothing to see, and its card is how it is found. The editors are whole
 * applications. Of the ten the canvas draws by hand, Input and TextArea
 * are drawn as themselves now (their own drawing has the label and the
 * helper text a hand-drawn field left out, and nothing on the canvas
 * measured the hand-drawn one); Button, Text and Heading stay, because
 * where a drop goes among their words is measured on their drawing, and
 * Card, Stack, Box, Image and Alert stay as they are.
 */
const DRAWN_FOR_REAL: ReadonlySet<string> = new Set([
  'Badge', 'Tag', 'Kbd', 'Icon', 'Avatar', 'Divider', 'Progress', 'Skeleton', 'Stat', 'Spinner', 'DescriptionList',
  'Breadcrumb', 'Steps', 'Tabs', 'Pagination', 'Timeline', 'Table', 'EmptyState', 'QRCode', 'CopyButton',
  'Input', 'TextArea', 'Select', 'Checkbox', 'Radio', 'Switch', 'Slider', 'NumberInput', 'Rating', 'SegmentedControl',
  'DatePicker', 'ColorPicker',
]);

/**
 * A prop as the component has it. Its `default` is what the component does
 * when a page writes nothing, which the panel shows for an unwritten prop and
 * writes as nothing: it is the component's own (componentProps.generated.ts,
 * from component-manifest.json), and the entry's is used only for a prop
 * whose default the manifest cannot read. A list of choices is the one the
 * component's type names. Where its type takes other values too, an entry
 * may give a list of its own with the values it also takes, in the order to
 * offer them (an App's theme is `system` as well as `light` or `dark`); the
 * type's are added to it.
 */
export function withComponentFacts(componentName: string, prop: PropSchema): PropSchema {
  const facts = COMPONENT_PROPS[componentName]?.[prop.name];
  if (!facts) return prop;
  const next: PropSchema = { ...prop };
  if (!facts.defaultUnknown) {
    delete next.default;
    if ('default' in facts) next.default = facts.default;
  }
  if (prop.type === 'select' && facts.options) {
    const named = facts.options;
    const own = facts.takesOthers ? prop.options ?? [] : [];
    next.options = [...own, ...named.filter((option) => !own.includes(option))];
  }
  return next;
}

export const componentRegistry: ComponentMeta[] = baseRegistry.map((meta) => {
  const extra = (MANIFEST_PROPS[meta.name] ?? []).filter((prop) => !meta.propSchema.some((own) => own.name === prop.name));
  const limit = MAX_CHILDREN[meta.name];
  const inline = INLINE_KINDS.has(meta.name);
  const drawn = DRAWN_FOR_REAL.has(meta.name);
  return {
    ...meta,
    propSchema: [...meta.propSchema, ...extra].map((prop) => withComponentFacts(meta.name, prop)),
    ...(limit !== undefined ? { maxChildren: limit } : {}),
    ...(inline ? { inline: true } : {}),
    ...(drawn ? { drawn: true } : {}),
  };
});

/**
 * What the palette offers: every component but the page itself. `App` is an
 * entry because the page's own properties are edited from it; it is the
 * root of a page and there is one, so it is not something to take and drop.
 */
export const paletteComponents: ComponentMeta[] = componentRegistry.filter((meta) => meta.name !== PAGE_TYPE);

// Group components by category
export function getComponentsByCategory(): Map<string, ComponentMeta[]> {
  const grouped = new Map<string, ComponentMeta[]>();

  for (const comp of paletteComponents) {
    const existing = grouped.get(comp.category) || [];
    existing.push(comp);
    grouped.set(comp.category, existing);
  }

  return grouped;
}

// Get component metadata by name
export function getComponentMeta(name: string): ComponentMeta | undefined {
  return componentRegistry.find((c) => c.name === name) ?? getNativeHtmlMeta(name);
}

// Category order for display
export const categoryOrder: ComponentCategory[] = [
  'Layout',
  'Form',
  'Display',
  'Feedback',
  'Navigation',
  'Utility',
  'Data',
  'Charts',
  'Editors',
  'Smart',
];
