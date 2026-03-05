/**
 * SoftN Component Registry
 * Metadata for all 65+ built-in components
 */

import type { ComponentMeta, ComponentCategory } from '../types/builder';

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

export const componentRegistry: ComponentMeta[] = [
  // ==================== LAYOUT COMPONENTS ====================
  comp(
    'App',
    'Layout',
    'layout',
    'Root application container with theme support',
    { theme: 'light' },
    [
      { name: 'theme', type: 'select', options: ['light', 'dark', 'system'], default: 'light' },
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
      {
        name: 'direction',
        type: 'select',
        options: ['horizontal', 'vertical'],
        default: 'vertical',
      },
      {
        name: 'gap',
        type: 'select',
        options: ['none', 'xs', 'sm', 'md', 'lg', 'xl'],
        default: 'md',
      },
      {
        name: 'align',
        type: 'select',
        options: ['start', 'center', 'end', 'stretch', 'baseline'],
        default: 'stretch',
      },
      {
        name: 'justify',
        type: 'select',
        options: ['start', 'center', 'end', 'between', 'around', 'evenly'],
        default: 'start',
      },
      { name: 'wrap', type: 'boolean', default: false },
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
      {
        name: 'padding',
        type: 'select',
        options: ['none', 'xs', 'sm', 'md', 'lg', 'xl'],
        default: 'md',
      },
      {
        name: 'margin',
        type: 'select',
        options: ['none', 'xs', 'sm', 'md', 'lg', 'xl'],
        default: 'none',
      },
      { name: 'background', type: 'color' },
      {
        name: 'borderRadius',
        type: 'select',
        options: ['none', 'sm', 'md', 'lg', 'full'],
        default: 'none',
      },
      {
        name: 'shadow',
        type: 'select',
        options: ['none', 'sm', 'md', 'lg', 'xl'],
        default: 'none',
      },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(
    'Card',
    'Layout',
    'credit-card',
    'Elevated container with shadow',
    { padding: 'md', shadow: 'md' },
    [
      {
        name: 'padding',
        type: 'select',
        options: ['none', 'xs', 'sm', 'md', 'lg', 'xl'],
        default: 'md',
      },
      { name: 'shadow', type: 'select', options: ['none', 'sm', 'md', 'lg', 'xl'], default: 'md' },
      { name: 'borderRadius', type: 'select', options: ['none', 'sm', 'md', 'lg'], default: 'md' },
      {
        name: 'variant',
        type: 'select',
        options: ['elevated', 'outlined', 'filled'],
        default: 'elevated',
      },
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
      { name: 'columns', type: 'number', default: 2 },
      { name: 'rows', type: 'number' },
      {
        name: 'gap',
        type: 'select',
        options: ['none', 'xs', 'sm', 'md', 'lg', 'xl'],
        default: 'md',
      },
      { name: 'columnGap', type: 'select', options: ['none', 'xs', 'sm', 'md', 'lg', 'xl'] },
      { name: 'rowGap', type: 'select', options: ['none', 'xs', 'sm', 'md', 'lg', 'xl'] },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(
    'Container',
    'Layout',
    'maximize',
    'Constrained width wrapper',
    { maxWidth: 'lg', centered: true },
    [
      {
        name: 'maxWidth',
        type: 'select',
        options: ['sm', 'md', 'lg', 'xl', '2xl', 'full'],
        default: 'lg',
      },
      { name: 'centered', type: 'boolean', default: true },
      {
        name: 'padding',
        type: 'select',
        options: ['none', 'xs', 'sm', 'md', 'lg', 'xl'],
        default: 'md',
      },
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

  comp(
    'Divider',
    'Layout',
    'minus',
    'Visual separator line',
    { orientation: 'horizontal' },
    [
      {
        name: 'orientation',
        type: 'select',
        options: ['horizontal', 'vertical'],
        default: 'horizontal',
      },
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
    [{ name: 'size', type: 'select', options: ['xs', 'sm', 'md', 'lg', 'xl'], default: 'md' }],
    false
  ),

  comp(
    'Split',
    'Layout',
    'columns',
    'Two-column layout',
    { ratio: '1:1' },
    [
      {
        name: 'ratio',
        type: 'select',
        options: ['1:1', '1:2', '2:1', '1:3', '3:1'],
        default: '1:1',
      },
      {
        name: 'gap',
        type: 'select',
        options: ['none', 'xs', 'sm', 'md', 'lg', 'xl'],
        default: 'md',
      },
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
      { name: 'sticky', type: 'boolean', default: false },
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

  comp(
    'Sidebar',
    'Layout',
    'sidebar',
    'Sidebar container',
    { position: 'left', width: 250 },
    [
      { name: 'position', type: 'select', options: ['left', 'right'], default: 'left' },
      { name: 'width', type: 'number', default: 250 },
      { name: 'collapsible', type: 'boolean', default: false },
      { name: 'collapsed', type: 'boolean', default: false },
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
      {
        name: 'variant',
        type: 'select',
        options: [
          'primary',
          'secondary',
          'outline',
          'ghost',
          'danger',
          'success',
          'warning',
          'link',
        ],
        default: 'primary',
      },
      { name: 'size', type: 'select', options: ['xs', 'sm', 'md', 'lg', 'xl'], default: 'md' },
      { name: 'disabled', type: 'boolean', default: false },
      { name: 'loading', type: 'boolean', default: false },
      { name: 'fullWidth', type: 'boolean', default: false },
      { name: 'type', type: 'select', options: ['button', 'submit', 'reset'], default: 'button' },
      { name: 'onClick', type: 'event', description: 'Click handler' },
      { name: 'children', type: 'string', default: 'Click me' },
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
      {
        name: 'type',
        type: 'select',
        options: ['text', 'email', 'password', 'number', 'tel', 'url', 'search'],
        default: 'text',
      },
      { name: 'placeholder', type: 'string', default: 'Enter text...' },
      { name: 'value', type: 'expression' },
      { name: 'defaultValue', type: 'string' },
      {
        name: 'variant',
        type: 'select',
        options: ['outline', 'filled', 'flushed'],
        default: 'outline',
      },
      { name: 'size', type: 'select', options: ['sm', 'md', 'lg'], default: 'md' },
      { name: 'disabled', type: 'boolean', default: false },
      { name: 'required', type: 'boolean', default: false },
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
      { name: 'placeholder', type: 'string', default: 'Enter text...' },
      { name: 'value', type: 'expression' },
      { name: 'rows', type: 'number', default: 4 },
      {
        name: 'resize',
        type: 'select',
        options: ['none', 'vertical', 'horizontal', 'both'],
        default: 'vertical',
      },
      { name: 'disabled', type: 'boolean', default: false },
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
    { placeholder: 'Select an option...' },
    [
      { name: 'placeholder', type: 'string', default: 'Select an option...' },
      { name: 'value', type: 'expression' },
      { name: 'options', type: 'json', description: 'Array of { value, label } objects' },
      { name: 'multiple', type: 'boolean', default: false },
      { name: 'searchable', type: 'boolean', default: false },
      { name: 'disabled', type: 'boolean', default: false },
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
      { name: 'label', type: 'string', default: 'Checkbox' },
      { name: 'checked', type: 'expression' },
      { name: 'defaultChecked', type: 'boolean', default: false },
      { name: 'disabled', type: 'boolean', default: false },
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
    { name: 'radio-group' },
    [
      { name: 'name', type: 'string', default: 'radio-group' },
      { name: 'value', type: 'expression' },
      { name: 'options', type: 'json', description: 'Array of { value, label } objects' },
      {
        name: 'direction',
        type: 'select',
        options: ['horizontal', 'vertical'],
        default: 'vertical',
      },
      { name: 'disabled', type: 'boolean', default: false },
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
      { name: 'label', type: 'string', default: 'Toggle' },
      { name: 'checked', type: 'expression' },
      { name: 'defaultChecked', type: 'boolean', default: false },
      { name: 'disabled', type: 'boolean', default: false },
      { name: 'size', type: 'select', options: ['sm', 'md', 'lg'], default: 'md' },
      { name: 'onChange', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(
    'Slider',
    'Form',
    'sliders',
    'Range slider',
    { min: 0, max: 100, defaultValue: 50 },
    [
      { name: 'min', type: 'number', default: 0 },
      { name: 'max', type: 'number', default: 100 },
      { name: 'step', type: 'number', default: 1 },
      { name: 'value', type: 'expression' },
      { name: 'defaultValue', type: 'number', default: 50 },
      { name: 'disabled', type: 'boolean', default: false },
      { name: 'showValue', type: 'boolean', default: true },
      { name: 'onChange', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(
    'DatePicker',
    'Form',
    'calendar',
    'Calendar date picker',
    { placeholder: 'Select date...' },
    [
      { name: 'placeholder', type: 'string', default: 'Select date...' },
      { name: 'value', type: 'expression' },
      { name: 'format', type: 'string', default: 'YYYY-MM-DD' },
      { name: 'minDate', type: 'string' },
      { name: 'maxDate', type: 'string' },
      { name: 'disabled', type: 'boolean', default: false },
      { name: 'onChange', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(
    'ColorPicker',
    'Form',
    'droplet',
    'Color input',
    { defaultValue: '#3b82f6' },
    [
      { name: 'value', type: 'expression' },
      { name: 'defaultValue', type: 'color', default: '#3b82f6' },
      { name: 'format', type: 'select', options: ['hex', 'rgb', 'hsl'], default: 'hex' },
      { name: 'disabled', type: 'boolean', default: false },
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
      { name: 'multiple', type: 'boolean', default: false },
      { name: 'directory', type: 'boolean', default: false },
      { name: 'label', type: 'string', default: 'Choose File' },
      { name: 'variant', type: 'select', options: ['button', 'dropzone'], default: 'button' },
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
      {
        name: 'size',
        type: 'select',
        options: ['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl'],
        default: 'md',
      },
      {
        name: 'weight',
        type: 'select',
        options: ['light', 'normal', 'medium', 'semibold', 'bold'],
        default: 'normal',
      },
      { name: 'color', type: 'color' },
      {
        name: 'align',
        type: 'select',
        options: ['left', 'center', 'right', 'justify'],
        default: 'left',
      },
      { name: 'truncate', type: 'boolean', default: false },
      { name: 'lineClamp', type: 'number' },
      { name: 'children', type: 'string', default: 'Hello World' },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(
    'Heading',
    'Display',
    'hash',
    'Semantic heading',
    { level: 1, children: 'Heading' },
    [
      { name: 'level', type: 'select', options: ['1', '2', '3', '4', '5', '6'], default: '1' },
      {
        name: 'size',
        type: 'select',
        options: ['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl'],
        default: 'xl',
      },
      {
        name: 'weight',
        type: 'select',
        options: ['normal', 'medium', 'semibold', 'bold'],
        default: 'bold',
      },
      { name: 'children', type: 'string', default: 'Heading' },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(
    'Badge',
    'Display',
    'tag',
    'Small badge/label',
    { variant: 'default', children: 'Badge' },
    [
      {
        name: 'variant',
        type: 'select',
        options: ['default', 'primary', 'secondary', 'success', 'warning', 'danger', 'info'],
        default: 'default',
      },
      { name: 'size', type: 'select', options: ['sm', 'md', 'lg'], default: 'md' },
      { name: 'children', type: 'string', default: 'Badge' },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(
    'Tag',
    'Display',
    'tag',
    'Tag element',
    { children: 'Tag' },
    [
      {
        name: 'variant',
        type: 'select',
        options: ['solid', 'outline', 'subtle'],
        default: 'subtle',
      },
      {
        name: 'colorScheme',
        type: 'select',
        options: ['gray', 'blue', 'green', 'red', 'yellow', 'purple'],
        default: 'gray',
      },
      { name: 'size', type: 'select', options: ['sm', 'md', 'lg'], default: 'md' },
      { name: 'closable', type: 'boolean', default: false },
      { name: 'onClose', type: 'event' },
      { name: 'children', type: 'string', default: 'Tag' },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(
    'Avatar',
    'Display',
    'user',
    'User avatar',
    { size: 'md' },
    [
      { name: 'src', type: 'string', description: 'Image URL' },
      { name: 'name', type: 'string', description: 'Name for initials fallback' },
      {
        name: 'size',
        type: 'select',
        options: ['xs', 'sm', 'md', 'lg', 'xl', '2xl'],
        default: 'md',
      },
      { name: 'shape', type: 'select', options: ['circle', 'square'], default: 'circle' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(
    'Progress',
    'Display',
    'bar-chart-2',
    'Progress bar',
    { value: 50, max: 100 },
    [
      { name: 'value', type: 'number', default: 50 },
      { name: 'max', type: 'number', default: 100 },
      { name: 'size', type: 'select', options: ['xs', 'sm', 'md', 'lg'], default: 'md' },
      {
        name: 'colorScheme',
        type: 'select',
        options: ['blue', 'green', 'red', 'yellow', 'purple'],
        default: 'blue',
      },
      { name: 'showValue', type: 'boolean', default: false },
      { name: 'striped', type: 'boolean', default: false },
      { name: 'animated', type: 'boolean', default: false },
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
      { name: 'size', type: 'select', options: ['xs', 'sm', 'md', 'lg', 'xl'], default: 'md' },
      { name: 'color', type: 'color' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(
    'Image',
    'Display',
    'image',
    'Image display',
    { alt: 'Image' },
    [
      { name: 'src', type: 'string', description: 'Image URL' },
      { name: 'alt', type: 'string', default: 'Image' },
      { name: 'width', type: 'number' },
      { name: 'height', type: 'number' },
      {
        name: 'fit',
        type: 'select',
        options: ['contain', 'cover', 'fill', 'none', 'scale-down'],
        default: 'cover',
      },
      {
        name: 'borderRadius',
        type: 'select',
        options: ['none', 'sm', 'md', 'lg', 'full'],
        default: 'none',
      },
      { name: 'fallback', type: 'string', description: 'Fallback image URL' },
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
      { name: 'name', type: 'string', default: 'check' },
      { name: 'svg', type: 'string' },
      { name: 'size', type: 'number', default: 20 },
      { name: 'color', type: 'color' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  // ==================== FEEDBACK COMPONENTS ====================
  comp(
    'Alert',
    'Feedback',
    'alert-circle',
    'Alert message',
    { variant: 'info', children: 'This is an alert message.' },
    [
      {
        name: 'variant',
        type: 'select',
        options: ['info', 'success', 'warning', 'error'],
        default: 'info',
      },
      {
        name: 'style',
        type: 'select',
        options: ['filled', 'light', 'outline', 'subtle'],
        default: 'light',
      },
      { name: 'title', type: 'string' },
      { name: 'closable', type: 'boolean', default: false },
      { name: 'onClose', type: 'event' },
      { name: 'children', type: 'string', default: 'This is an alert message.' },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(
    'Modal',
    'Feedback',
    'square',
    'Modal dialog',
    { title: 'Modal Title' },
    [
      { name: 'title', type: 'string', default: 'Modal Title' },
      { name: 'open', type: 'expression' },
      { name: 'size', type: 'select', options: ['sm', 'md', 'lg', 'xl', 'full'], default: 'md' },
      { name: 'closeOnOverlay', type: 'boolean', default: true },
      { name: 'closeOnEscape', type: 'boolean', default: true },
      { name: 'onClose', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(
    'Toast',
    'Feedback',
    'bell',
    'Toast notification',
    { message: 'Notification message' },
    [
      { name: 'message', type: 'string', default: 'Notification message' },
      {
        name: 'variant',
        type: 'select',
        options: ['info', 'success', 'warning', 'error'],
        default: 'info',
      },
      { name: 'duration', type: 'number', default: 5000 },
      {
        name: 'position',
        type: 'select',
        options: ['top', 'top-right', 'top-left', 'bottom', 'bottom-right', 'bottom-left'],
        default: 'top-right',
      },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(
    'Drawer',
    'Feedback',
    'sidebar',
    'Side drawer panel',
    { title: 'Drawer' },
    [
      { name: 'title', type: 'string', default: 'Drawer' },
      { name: 'open', type: 'expression' },
      {
        name: 'position',
        type: 'select',
        options: ['left', 'right', 'top', 'bottom'],
        default: 'right',
      },
      { name: 'size', type: 'select', options: ['sm', 'md', 'lg', 'xl', 'full'], default: 'md' },
      { name: 'closeOnOverlay', type: 'boolean', default: true },
      { name: 'onClose', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(
    'Popover',
    'Feedback',
    'message-square',
    'Popover tooltip',
    { trigger: 'click' },
    [
      { name: 'trigger', type: 'select', options: ['click', 'hover', 'focus'], default: 'click' },
      {
        name: 'position',
        type: 'select',
        options: ['top', 'right', 'bottom', 'left'],
        default: 'bottom',
      },
      { name: 'title', type: 'string' },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  // ==================== NAVIGATION COMPONENTS ====================
  comp(
    'Tabs',
    'Navigation',
    'folder',
    'Tab navigation',
    { defaultValue: 'tab1' },
    [
      { name: 'defaultValue', type: 'string', default: 'tab1' },
      { name: 'value', type: 'expression' },
      { name: 'variant', type: 'select', options: ['line', 'enclosed', 'pills'], default: 'line' },
      {
        name: 'orientation',
        type: 'select',
        options: ['horizontal', 'vertical'],
        default: 'horizontal',
      },
      { name: 'onChange', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(
    'Breadcrumb',
    'Navigation',
    'chevrons-right',
    'Breadcrumb trail',
    {},
    [
      { name: 'separator', type: 'string', default: '/' },
      { name: 'items', type: 'json', description: 'Array of { label, href } objects' },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(
    'Menu',
    'Navigation',
    'menu',
    'Navigation menu',
    {},
    [
      {
        name: 'orientation',
        type: 'select',
        options: ['horizontal', 'vertical'],
        default: 'vertical',
      },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(
    'NavItem',
    'Navigation',
    'link',
    'Menu item',
    { label: 'Menu Item' },
    [
      { name: 'label', type: 'string', default: 'Menu Item' },
      { name: 'href', type: 'string' },
      { name: 'active', type: 'boolean', default: false },
      { name: 'icon', type: 'string' },
      { name: 'onClick', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  // ==================== UTILITY COMPONENTS ====================
  comp(
    'Accordion',
    'Utility',
    'chevron-down',
    'Collapsible accordion',
    { allowMultiple: false },
    [
      { name: 'allowMultiple', type: 'boolean', default: false },
      { name: 'defaultIndex', type: 'number' },
      {
        name: 'variant',
        type: 'select',
        options: ['default', 'bordered', 'separated'],
        default: 'default',
      },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(
    'Collapse',
    'Utility',
    'chevron-down',
    'Single collapsible panel',
    { title: 'Collapse Title', defaultOpen: false },
    [
      { name: 'title', type: 'string', default: 'Collapse Title' },
      { name: 'defaultOpen', type: 'boolean', default: false },
      { name: 'open', type: 'expression' },
      { name: 'onToggle', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(
    'Tooltip',
    'Utility',
    'info',
    'Tooltip component',
    { content: 'Tooltip text' },
    [
      { name: 'content', type: 'string', default: 'Tooltip text' },
      {
        name: 'position',
        type: 'select',
        options: ['top', 'right', 'bottom', 'left'],
        default: 'top',
      },
      { name: 'delay', type: 'number', default: 200 },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  // ==================== DATA COMPONENTS ====================
  comp(
    'List',
    'Data',
    'list',
    'List rendering',
    {},
    [
      {
        name: 'variant',
        type: 'select',
        options: ['default', 'ordered', 'unordered'],
        default: 'default',
      },
      { name: 'spacing', type: 'select', options: ['none', 'sm', 'md', 'lg'], default: 'sm' },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(
    'ListItem',
    'Data',
    'minus',
    'List item',
    {},
    [
      { name: 'icon', type: 'string' },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(
    'Table',
    'Data',
    'table',
    'Data table',
    {},
    [
      { name: 'data', type: 'expression', description: 'Array of row objects' },
      { name: 'columns', type: 'json', description: 'Column definitions' },
      { name: 'striped', type: 'boolean', default: false },
      { name: 'hoverable', type: 'boolean', default: true },
      { name: 'bordered', type: 'boolean', default: false },
      { name: 'sortable', type: 'boolean', default: false },
      { name: 'selectable', type: 'boolean', default: false },
      { name: 'onSort', type: 'event' },
      { name: 'onRowClick', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(
    'TreeView',
    'Data',
    'git-branch',
    'Hierarchical tree structure',
    {},
    [
      { name: 'data', type: 'expression', description: 'Tree data structure' },
      { name: 'defaultExpandedKeys', type: 'json' },
      { name: 'selectable', type: 'boolean', default: true },
      { name: 'checkable', type: 'boolean', default: false },
      { name: 'onSelect', type: 'event' },
      { name: 'onExpand', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(
    'Pagination',
    'Data',
    'more-horizontal',
    'Page navigation',
    { total: 100, pageSize: 10, current: 1 },
    [
      { name: 'total', type: 'number', default: 100 },
      { name: 'pageSize', type: 'number', default: 10 },
      { name: 'current', type: 'expression' },
      { name: 'defaultCurrent', type: 'number', default: 1 },
      { name: 'showSizeChanger', type: 'boolean', default: false },
      { name: 'showQuickJumper', type: 'boolean', default: false },
      { name: 'onChange', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(
    'DataGrid',
    'Data',
    'grid',
    'Advanced data grid',
    {},
    [
      { name: 'data', type: 'expression' },
      { name: 'columns', type: 'json' },
      { name: 'pageSize', type: 'number', default: 10 },
      { name: 'sortable', type: 'boolean', default: true },
      { name: 'filterable', type: 'boolean', default: true },
      { name: 'selectable', type: 'boolean', default: false },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  // ==================== CHART COMPONENTS ====================
  comp(
    'LineChart',
    'Charts',
    'trending-up',
    'Line chart visualization',
    { height: 300 },
    [
      { name: 'data', type: 'expression', description: 'Chart data array' },
      { name: 'xKey', type: 'string', default: 'x' },
      { name: 'yKey', type: 'string', default: 'y' },
      { name: 'height', type: 'number', default: 300 },
      { name: 'showGrid', type: 'boolean', default: true },
      { name: 'showLegend', type: 'boolean', default: true },
      { name: 'curved', type: 'boolean', default: false },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(
    'BarChart',
    'Charts',
    'bar-chart',
    'Bar chart visualization',
    { height: 300 },
    [
      { name: 'data', type: 'expression' },
      { name: 'xKey', type: 'string', default: 'x' },
      { name: 'yKey', type: 'string', default: 'y' },
      { name: 'height', type: 'number', default: 300 },
      { name: 'horizontal', type: 'boolean', default: false },
      { name: 'stacked', type: 'boolean', default: false },
      { name: 'showGrid', type: 'boolean', default: true },
      { name: 'showLegend', type: 'boolean', default: true },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(
    'PieChart',
    'Charts',
    'pie-chart',
    'Pie/donut chart',
    { height: 300 },
    [
      { name: 'data', type: 'expression' },
      { name: 'dataKey', type: 'string', default: 'value' },
      { name: 'nameKey', type: 'string', default: 'name' },
      { name: 'height', type: 'number', default: 300 },
      { name: 'donut', type: 'boolean', default: false },
      { name: 'showLabels', type: 'boolean', default: true },
      { name: 'showLegend', type: 'boolean', default: true },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  // ==================== EDITOR COMPONENTS ====================
  comp(
    'CodeEditor',
    'Editors',
    'code',
    'Code syntax highlighting editor',
    { language: 'javascript', height: 300 },
    [
      { name: 'value', type: 'expression' },
      { name: 'defaultValue', type: 'string' },
      {
        name: 'language',
        type: 'select',
        options: ['javascript', 'typescript', 'html', 'css', 'json', 'python', 'rust', 'go', 'sql'],
        default: 'javascript',
      },
      { name: 'height', type: 'number', default: 300 },
      { name: 'readOnly', type: 'boolean', default: false },
      { name: 'showLineNumbers', type: 'boolean', default: true },
      { name: 'theme', type: 'select', options: ['light', 'dark'], default: 'light' },
      { name: 'onChange', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(
    'MarkdownEditor',
    'Editors',
    'file-text',
    'Markdown editor',
    { height: 300 },
    [
      { name: 'value', type: 'expression' },
      { name: 'defaultValue', type: 'string' },
      { name: 'height', type: 'number', default: 300 },
      { name: 'preview', type: 'select', options: ['edit', 'preview', 'split'], default: 'split' },
      { name: 'onChange', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(
    'RichTextEditor',
    'Editors',
    'edit-3',
    'WYSIWYG rich text editor',
    { height: 300 },
    [
      { name: 'value', type: 'expression' },
      { name: 'defaultValue', type: 'string' },
      { name: 'height', type: 'number', default: 300 },
      { name: 'placeholder', type: 'string', default: 'Start writing...' },
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
      { name: 'search', type: 'boolean', default: true },
      { name: 'sort', type: 'boolean', default: true },
      { name: 'pagination', type: 'boolean', default: true },
      { name: 'edit', type: 'boolean', default: false },
      { name: 'delete', type: 'boolean', default: false },
      { name: 'onEdit', type: 'event' },
      { name: 'onDelete', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(
    'SmartForm',
    'Smart',
    'file-text',
    'Auto form generation from field specs',
    {},
    [
      {
        name: 'fields',
        type: 'string',
        description: 'Comma-separated field specs (name, email:email, role:select)',
      },
      { name: 'values', type: 'expression' },
      { name: 'onSubmit', type: 'event' },
      { name: 'onChange', type: 'event' },
      { name: 'submitLabel', type: 'string', default: 'Submit' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(
    'SmartView',
    'Smart',
    'eye',
    'Data display view',
    {},
    [
      { name: 'data', type: 'expression' },
      { name: 'fields', type: 'string', description: 'Comma-separated field names' },
      {
        name: 'layout',
        type: 'select',
        options: ['vertical', 'horizontal', 'grid'],
        default: 'vertical',
      },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(
    'SmartStats',
    'Smart',
    'bar-chart-2',
    'Statistics display',
    {},
    [
      { name: 'data', type: 'expression' },
      { name: 'stats', type: 'string', description: 'Comma-separated stat definitions' },
      { name: 'layout', type: 'select', options: ['row', 'grid'], default: 'row' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(
    'SmartCards',
    'Smart',
    'credit-card',
    'Card-based data display',
    {},
    [
      { name: 'data', type: 'expression' },
      { name: 'titleField', type: 'string' },
      { name: 'descriptionField', type: 'string' },
      { name: 'imageField', type: 'string' },
      { name: 'columns', type: 'number', default: 3 },
      { name: 'onClick', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(
    'SmartList',
    'Smart',
    'list',
    'List with features',
    {},
    [
      { name: 'data', type: 'expression' },
      { name: 'titleField', type: 'string' },
      { name: 'descriptionField', type: 'string' },
      { name: 'search', type: 'boolean', default: true },
      { name: 'onClick', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(
    'SmartTimeline',
    'Smart',
    'clock',
    'Timeline visualization',
    {},
    [
      { name: 'data', type: 'expression' },
      { name: 'dateField', type: 'string', default: 'date' },
      { name: 'titleField', type: 'string', default: 'title' },
      { name: 'descriptionField', type: 'string', default: 'description' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  // ==================== MISSING COMPONENT COVERAGE ====================
  comp(
    'EmptyState',
    'Feedback',
    'inbox',
    'Empty state placeholder with title and description',
    { title: 'No data yet', description: 'Get started by creating your first item.' },
    [
      { name: 'title', type: 'string', default: 'No data yet' },
      { name: 'description', type: 'string', default: 'Get started by creating your first item.' },
      { name: 'actionLabel', type: 'string' },
      { name: 'className', type: 'string' },
    ],
    false
  ),
  comp(
    'Loop',
    'Utility',
    'repeat',
    'Render repeated content from an array expression',
    { each: 'items', as: 'item' },
    [
      { name: 'each', type: 'expression', default: 'items' },
      { name: 'as', type: 'string', default: 'item' },
      { name: 'indexAs', type: 'string', default: 'index' },
      { name: 'className', type: 'string' },
    ],
    true
  ),
  comp(
    'PixelGrid',
    'Utility',
    'grid',
    'Pixel-art style grid renderer',
    { rows: 16, columns: 16, cellSize: 12 },
    [
      { name: 'rows', type: 'number', default: 16 },
      { name: 'columns', type: 'number', default: 16 },
      { name: 'cellSize', type: 'number', default: 12 },
      { name: 'data', type: 'expression' },
      { name: 'className', type: 'string' },
    ],
    false
  ),
  comp(
    'QRCode',
    'Utility',
    'qr-code',
    'Canvas-based QR code generator',
    { value: 'https://softn.com', size: 256 },
    [
      { name: 'value', type: 'string', default: 'https://softn.com' },
      { name: 'size', type: 'number', default: 256 },
      { name: 'color', type: 'color', default: '#000' },
      { name: 'bgColor', type: 'color', default: '#fff' },
      { name: 'errorCorrection', type: 'select', options: ['L', 'M', 'Q', 'H'], default: 'M' },
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
      { name: 'facing', type: 'select', options: ['user', 'environment'], default: 'environment' },
      { name: 'width', type: 'number', default: 640 },
      { name: 'height', type: 'number', default: 480 },
      { name: 'active', type: 'boolean', default: true },
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
      { name: 'mode', type: 'select', options: ['photo', 'video', 'live'], default: 'photo' },
      { name: 'facing', type: 'select', options: ['user', 'environment'], default: 'user' },
      { name: 'width', type: 'number', default: 640 },
      { name: 'height', type: 'number', default: 480 },
      { name: 'active', type: 'boolean', default: true },
      { name: 'showControls', type: 'boolean', default: true },
      { name: 'onCapture', type: 'event' },
      { name: 'onFrame', type: 'event' },
      { name: 'onRecord', type: 'event' },
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
      { name: 'buttonSize', type: 'number', default: 56 },
      { name: 'color', type: 'color', default: 'rgba(255,255,255,0.15)' },
      { name: 'visible', type: 'boolean', default: true },
    ],
    false
  ),
  comp(
    'AnimatedBox',
    'Utility',
    'sparkles',
    'Container with preset enter/exit animation',
    { animation: 'fade', duration: 300, trigger: 'mount' },
    [
      { name: 'animation', type: 'select', options: ['fade', 'slide-up', 'slide-down', 'scale'], default: 'fade' },
      { name: 'duration', type: 'number', default: 300 },
      { name: 'trigger', type: 'select', options: ['mount', 'visible'], default: 'mount' },
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
      { name: 'value', type: 'number', default: 100 },
      { name: 'duration', type: 'number', default: 1200 },
      { name: 'decimals', type: 'number', default: 0 },
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
      { name: 'speed', type: 'number', default: 40 },
      { name: 'direction', type: 'select', options: ['left', 'right'], default: 'left' },
      { name: 'pauseOnHover', type: 'boolean', default: true },
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
      { name: 'text', type: 'string', default: 'Hello, SoftN!' },
      { name: 'speed', type: 'number', default: 60 },
      { name: 'loop', type: 'boolean', default: false },
      { name: 'className', type: 'string' },
    ],
    false
  ),
  comp(
    'Draggable',
    'Utility',
    'move',
    'Drag-and-drop wrapper for any child content',
    { axis: 'both', handle: '' },
    [
      { name: 'axis', type: 'select', options: ['x', 'y', 'both'], default: 'both' },
      { name: 'handle', type: 'string' },
      { name: 'className', type: 'string' },
    ],
    true
  ),
  comp(
    'SortableList',
    'Data',
    'list-ordered',
    'Sortable list with drag reordering',
    { items: '[]', itemKey: 'id' },
    [
      { name: 'items', type: 'expression' },
      { name: 'itemKey', type: 'string', default: 'id' },
      { name: 'className', type: 'string' },
    ],
    false
  ),
  comp(
    'Sprite',
    'Utility',
    'film',
    'CSS-based sprite sheet renderer with animation',
    { frameWidth: 32, frameHeight: 32, columns: 8, rows: 4, row: 0, fps: 10, scale: 1 },
    [
      { name: 'src', type: 'string' },
      { name: 'frameWidth', type: 'number', default: 32 },
      { name: 'frameHeight', type: 'number', default: 32 },
      { name: 'columns', type: 'number', default: 8 },
      { name: 'rows', type: 'number', default: 4 },
      { name: 'row', type: 'number', default: 0 },
      { name: 'colOffset', type: 'number', default: 0 },
      { name: 'playing', type: 'boolean', default: false },
      { name: 'fps', type: 'number', default: 10 },
      { name: 'scale', type: 'number', default: 1 },
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
    [
      { name: 'src', type: 'string' },
      { name: 'tileSize', type: 'number', default: 32 },
      { name: 'tilesetColumns', type: 'number', default: 16 },
      { name: 'layers', type: 'expression' },
      { name: 'mapWidth', type: 'number', default: 16 },
      { name: 'mapHeight', type: 'number', default: 16 },
      { name: 'scale', type: 'number', default: 1 },
      { name: 'className', type: 'string' },
    ],
    false
  ),
  comp(
    'AreaChart',
    'Charts',
    'area-chart',
    'Area chart visualization',
    { data: '[]', xKey: 'name', yKey: 'value' },
    [
      { name: 'data', type: 'expression' },
      { name: 'xKey', type: 'string', default: 'name' },
      { name: 'yKey', type: 'string', default: 'value' },
      { name: 'color', type: 'color', default: '#3b82f6' },
      { name: 'className', type: 'string' },
    ],
    false
  ),
  comp(
    'RadarChart',
    'Charts',
    'radar',
    'Radar/spider chart visualization',
    { data: '[]', dataKey: 'value' },
    [
      { name: 'data', type: 'expression' },
      { name: 'dataKey', type: 'string', default: 'value' },
      { name: 'nameKey', type: 'string', default: 'name' },
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
      { name: 'value', type: 'number', default: 65 },
      { name: 'min', type: 'number', default: 0 },
      { name: 'max', type: 'number', default: 100 },
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
    { modelUrl: '', autoRotate: false, enableControls: true },
    [
      { name: 'modelUrl', type: 'string' },
      { name: 'autoRotate', type: 'boolean', default: false },
      { name: 'enableControls', type: 'boolean', default: true },
      { name: 'background', type: 'color' },
      { name: 'className', type: 'string' },
    ],
    false
  ),
];

// Group components by category
export function getComponentsByCategory(): Map<string, ComponentMeta[]> {
  const grouped = new Map<string, ComponentMeta[]>();

  for (const comp of componentRegistry) {
    const existing = grouped.get(comp.category) || [];
    existing.push(comp);
    grouped.set(comp.category, existing);
  }

  return grouped;
}

// Get component metadata by name
export function getComponentMeta(name: string): ComponentMeta | undefined {
  return componentRegistry.find((c) => c.name === name);
}

// Get all component names
export function getComponentNames(): string[] {
  return componentRegistry.map((c) => c.name);
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
