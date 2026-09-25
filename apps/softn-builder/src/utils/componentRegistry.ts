/**
 * SoftN Component Registry
 * Metadata for all 65+ built-in components
 */

import type { ComponentMeta, ComponentCategory, PropSchema } from '../types/builder';
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
      { name: 'theme', type: 'select', options: ['light', 'dark', 'system'], default: 'system' },
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

  comp(    'Card',
    'Layout',
    'credit-card',
    'Elevated container with shadow',
    { padding: 'md', variant: 'elevated' },
    [
      { name: 'variant', type: 'select', options: ['default', 'outlined', 'elevated', 'filled', 'ghost', 'glass', 'gradient'], default: 'elevated' },
      { name: 'padding', type: 'select', options: ['none', 'sm', 'md', 'lg', 'xl'], default: 'md' },
      { name: 'borderRadius', type: 'select', options: ['none', 'sm', 'md', 'lg', 'xl'], default: 'md' },
      { name: 'title', type: 'string' },
      { name: 'subtitle', type: 'string' },
      { name: 'hover', type: 'boolean', default: false },
      { name: 'interactive', type: 'boolean', default: false },
      { name: 'dividers', type: 'boolean', default: false },
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

  comp(    'Container',
    'Layout',
    'maximize',
    'Constrained width wrapper',
    { size: 'lg', centered: true },
    [
      { name: 'size', type: 'select', options: ['sm', 'md', 'lg', 'xl', '2xl', 'full'], default: 'lg' },
      { name: 'centered', type: 'boolean', default: true },
      { name: 'padding', type: 'select', options: ['none', 'xs', 'sm', 'md', 'lg', 'xl'], default: 'md' },
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
      { name: 'direction', type: 'select', options: ['horizontal', 'vertical'], default: 'horizontal' },
      { name: 'label', type: 'string' },
      { name: 'thickness', type: 'string' },
      { name: 'color', type: 'color' },
      { name: 'margin', type: 'select', options: ['none', 'xs', 'sm', 'md', 'lg', 'xl'], default: 'md' },
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

  comp(    'Split',
    'Layout',
    'columns',
    'Two-column layout',
    { direction: 'horizontal', initialSize: '50%' },
    [
      { name: 'direction', type: 'select', options: ['horizontal', 'vertical'], default: 'horizontal' },
      { name: 'initialSize', type: 'string', default: '50%', description: 'Size of the first pane (CSS length or percentage)' },
      { name: 'minSize', type: 'number' },
      { name: 'maxSize', type: 'number' },
      { name: 'gutterSize', type: 'number', default: 8 },
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

  comp(    'Sidebar',
    'Layout',
    'sidebar',
    'Sidebar container',
    { position: 'left', width: '280px' },
    [
      { name: 'position', type: 'select', options: ['left', 'right'], default: 'left' },
      { name: 'width', type: 'string', default: '280px' },
      { name: 'collapsedWidth', type: 'string', default: '64px' },
      { name: 'collapsible', type: 'boolean', default: false },
      { name: 'collapsed', type: 'boolean', default: false },
      { name: 'showToggle', type: 'boolean', default: true },
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
      { name: 'ariaLabel', type: 'string', description: 'Accessible name — needed when the label is only a glyph' },
      { name: 'title', type: 'string', description: 'Tooltip' },
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

  comp(    'Slider',
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
      { name: 'showTooltip', type: 'boolean', default: true },
      { name: 'size', type: 'select', options: ['sm', 'md', 'lg'], default: 'md' },
      { name: 'variant', type: 'select', options: ['primary', 'secondary', 'success', 'warning', 'danger'], default: 'primary' },
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
      { name: 'placeholder', type: 'string', default: 'Select date...' },
      { name: 'label', type: 'string' },
      { name: 'value', type: 'expression' },
      { name: 'format', type: 'select', options: ['yyyy-mm-dd', 'mm/dd/yyyy', 'dd/mm/yyyy'], default: 'yyyy-mm-dd' },
      { name: 'min', type: 'string' },
      { name: 'max', type: 'string' },
      { name: 'disabled', type: 'boolean', default: false },
      { name: 'required', type: 'boolean', default: false },
      { name: 'size', type: 'select', options: ['sm', 'md', 'lg'], default: 'md' },
      { name: 'onChange', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    false
  ),

  comp(    'ColorPicker',
    'Form',
    'droplet',
    'Color input',
    { defaultValue: 'var(--coral)' },
    [
      { name: 'value', type: 'expression' },
      { name: 'defaultValue', type: 'color', default: 'var(--coral)' },
      { name: 'label', type: 'string' },
      { name: 'showInput', type: 'boolean', default: true },
      { name: 'disabled', type: 'boolean', default: false },
      { name: 'size', type: 'select', options: ['sm', 'md', 'lg'], default: 'md' },
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

  comp(    'Heading',
    'Display',
    'hash',
    'Semantic heading',
    { level: 1, children: 'Heading' },
    [
      { name: 'level', type: 'select', options: ['1', '2', '3', '4', '5', '6'], default: '1' },
      { name: 'variant', type: 'select', options: ['default', 'muted', 'primary', 'gradient'], default: 'default' },
      { name: 'align', type: 'select', options: ['left', 'center', 'right'], default: 'left' },
      { name: 'transform', type: 'select', options: ['none', 'uppercase', 'lowercase', 'capitalize'], default: 'none' },
      { name: 'letterSpacing', type: 'select', options: ['tight', 'normal', 'wide'], default: 'normal' },
      { name: 'truncate', type: 'boolean', default: false },
      { name: 'underline', type: 'boolean', default: false },
      { name: 'color', type: 'color' },
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

  comp(    'Tag',
    'Display',
    'tag',
    'Tag element',
    { children: 'Tag' },
    [
      { name: 'variant', type: 'select', options: ['default', 'primary', 'secondary', 'success', 'warning', 'danger', 'info'], default: 'default' },
      { name: 'tagStyle', type: 'select', options: ['solid', 'subtle', 'outline'], default: 'subtle' },
      { name: 'size', type: 'select', options: ['sm', 'md', 'lg'], default: 'md' },
      { name: 'removable', type: 'boolean', default: false },
      { name: 'rounded', type: 'boolean', default: false },
      { name: 'disabled', type: 'boolean', default: false },
      { name: 'onRemove', type: 'event' },
      { name: 'onClick', type: 'event' },
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

  comp(    'Progress',
    'Display',
    'bar-chart-2',
    'Progress bar',
    { value: 50, max: 100 },
    [
      { name: 'value', type: 'number', default: 50 },
      { name: 'max', type: 'number', default: 100 },
      { name: 'size', type: 'select', options: ['xs', 'sm', 'md', 'lg', 'xl'], default: 'md' },
      { name: 'variant', type: 'select', options: ['primary', 'success', 'warning', 'danger', 'info'], default: 'primary' },
      { name: 'showLabel', type: 'boolean', default: false },
      { name: 'labelPosition', type: 'select', options: ['inside', 'outside', 'top'], default: 'outside' },
      { name: 'striped', type: 'boolean', default: false },
      { name: 'animated', type: 'boolean', default: false },
      { name: 'indeterminate', type: 'boolean', default: false },
      { name: 'borderRadius', type: 'select', options: ['none', 'sm', 'md', 'lg', 'full'], default: 'full' },
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

  comp(    'Image',
    'Display',
    'image',
    'Image display',
    { alt: 'Image' },
    [
      { name: 'src', type: 'string', description: 'Image URL' },
      { name: 'alt', type: 'string', default: 'Image' },
      { name: 'width', type: 'string' },
      { name: 'height', type: 'string' },
      { name: 'objectFit', type: 'select', options: ['contain', 'cover', 'fill', 'none', 'scale-down'], default: 'cover' },
      { name: 'borderRadius', type: 'select', options: ['none', 'sm', 'md', 'lg', 'full'], default: 'none' },
      { name: 'fallbackSrc', type: 'string', description: 'Image shown when src fails to load' },
      { name: 'loading', type: 'select', options: ['lazy', 'eager'], default: 'lazy' },
      { name: 'showPlaceholder', type: 'boolean', default: true },
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
      { name: 'name', type: 'string', default: 'check' },
      { name: 'svg', type: 'string' },
      { name: 'size', type: 'number', default: 20 },
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
      { name: 'variant', type: 'select', options: ['info', 'success', 'warning', 'error'], default: 'info' },
      { name: 'alertStyle', type: 'select', options: ['filled', 'light', 'outline', 'subtle'], default: 'light' },
      { name: 'title', type: 'string' },
      { name: 'dismissible', type: 'boolean', default: false },
      { name: 'showIcon', type: 'boolean', default: true },
      { name: 'borderRadius', type: 'select', options: ['none', 'sm', 'md', 'lg', 'xl'], default: 'md' },
      { name: 'onDismiss', type: 'event' },
      { name: 'children', type: 'string', default: 'This is an alert message.' },
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
      { name: 'title', type: 'string', default: 'Modal Title' },
      { name: 'open', type: 'expression' },
      { name: 'size', type: 'select', options: ['sm', 'md', 'lg', 'xl', 'full'], default: 'md' },
      { name: 'closeOnOverlayClick', type: 'boolean', default: true },
      { name: 'closeOnEscape', type: 'boolean', default: true },
      { name: 'showCloseButton', type: 'boolean', default: true },
      { name: 'centered', type: 'boolean', default: true },
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
      { name: 'message', type: 'string', default: 'Notification message' },
      { name: 'title', type: 'string' },
      { name: 'variant', type: 'select', options: ['info', 'success', 'warning', 'error'], default: 'info' },
      { name: 'duration', type: 'number', default: 5000 },
      { name: 'position', type: 'select', options: ['top-right', 'top-left', 'top-center', 'bottom-right', 'bottom-left', 'bottom-center'], default: 'top-right' },
      { name: 'showClose', type: 'boolean', default: true },
      { name: 'showProgress', type: 'boolean', default: false },
      { name: 'onClose', type: 'event' },
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

  comp(    'Popover',
    'Feedback',
    'message-square',
    'Popover tooltip',
    { triggerMode: 'click' },
    [
      { name: 'triggerMode', type: 'select', options: ['click', 'hover'], default: 'click' },
      { name: 'placement', type: 'select', options: ['top', 'right', 'bottom', 'left'], default: 'bottom' },
      { name: 'offset', type: 'number', default: 8 },
      { name: 'showArrow', type: 'boolean', default: true },
      { name: 'closeOnOutsideClick', type: 'boolean', default: true },
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
    { defaultActiveKey: 'tab1' },
    [
      { name: 'tabs', type: 'json', description: 'Tabs as [{ key, label, disabled? }]; the content is the children under each key' },
      { name: 'defaultActiveKey', type: 'string', default: 'tab1' },
      { name: 'activeKey', type: 'expression' },
      { name: 'variant', type: 'select', options: ['default', 'pills', 'underline'], default: 'default' },
      { name: 'size', type: 'select', options: ['sm', 'md', 'lg'], default: 'md' },
      { name: 'fullWidth', type: 'boolean', default: false },
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

  comp(    'Menu',
    'Navigation',
    'menu',
    'Navigation menu',
    {  },
    [
      { name: 'items', type: 'json', description: 'Menu items as [{ key, label, icon?, disabled?, divider? }]' },
      { name: 'placement', type: 'select', options: ['bottom-start', 'bottom-end', 'top-start', 'top-end'], default: 'bottom-start' },
      { name: 'width', type: 'string' },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(    'NavItem',
    'Navigation',
    'link',
    'Menu item',
    { label: 'Menu Item' },
    [
      { name: 'label', type: 'string', default: 'Menu Item' },
      { name: 'page', type: 'string', description: 'Page to show when chosen' },
      { name: 'navigate', type: 'string', description: 'Route or URL to go to when chosen' },
      { name: 'active', type: 'boolean', default: false },
      { name: 'collapsed', type: 'boolean', default: false },
      { name: 'icon', type: 'string' },
      { name: 'variant', type: 'select', options: ['default', 'ghost', 'primary'], default: 'default' },
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
      { name: 'multiple', type: 'boolean', default: false },
      { name: 'defaultOpenKeys', type: 'json', description: 'Keys open at first, as ["a", "b"]' },
      { name: 'variant', type: 'select', options: ['default', 'bordered', 'separated'], default: 'default' },
      { name: 'onChange', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(    'Collapse',
    'Utility',
    'chevron-down',
    'Single collapsible panel',
    { isOpen: true },
    [
      { name: 'isOpen', type: 'expression', description: 'Whether the children are shown' },
      { name: 'duration', type: 'number', default: 200 },
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
      { name: 'content', type: 'string', default: 'Tooltip text' },
      { name: 'placement', type: 'select', options: ['top', 'bottom', 'left', 'right', 'top-start', 'top-end', 'bottom-start', 'bottom-end'], default: 'top' },
      { name: 'showDelay', type: 'number', default: 200 },
      { name: 'hideDelay', type: 'number', default: 0 },
      { name: 'arrow', type: 'boolean', default: true },
      { name: 'variant', type: 'select', options: ['dark', 'light', 'primary', 'success', 'warning', 'danger'], default: 'dark' },
      { name: 'size', type: 'select', options: ['sm', 'md', 'lg'], default: 'md' },
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
      { name: 'variant', type: 'select', options: ['default', 'bordered', 'divided'], default: 'default' },
      { name: 'spacing', type: 'select', options: ['none', 'sm', 'md', 'lg'], default: 'sm' },
      { name: 'ordered', type: 'boolean', default: false },
      { name: 'hoverable', type: 'boolean', default: false },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(    'ListItem',
    'Data',
    'minus',
    'List item',
    {  },
    [
      { name: 'active', type: 'boolean', default: false },
      { name: 'disabled', type: 'boolean', default: false },
      { name: 'onClick', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(    'Table',
    'Data',
    'table',
    'Data table',
    {  },
    [
      { name: 'data', type: 'expression', description: 'Array of row objects' },
      { name: 'columns', type: 'json', description: 'Column definitions' },
      { name: 'rowKey', type: 'string', description: 'Field that identifies a row' },
      { name: 'variant', type: 'select', options: ['default', 'striped', 'bordered'], default: 'default' },
      { name: 'size', type: 'select', options: ['sm', 'md', 'lg'], default: 'md' },
      { name: 'hoverable', type: 'boolean', default: true },
      { name: 'stickyHeader', type: 'boolean', default: false },
      { name: 'sortColumn', type: 'string' },
      { name: 'sortDirection', type: 'select', options: ['asc', 'desc'] },
      { name: 'onSort', type: 'event' },
      { name: 'onRowClick', type: 'event' },
      { name: 'className', type: 'string' },
    ],
    true
  ),

  comp(    'TreeView',
    'Data',
    'git-branch',
    'Hierarchical tree structure',
    {  },
    [
      { name: 'nodes', type: 'expression', description: 'Tree nodes as [{ id, label, children? }]' },
      { name: 'defaultExpandAll', type: 'boolean', default: false },
      { name: 'showLines', type: 'boolean', default: true },
      { name: 'indent', type: 'number', default: 20 },
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
      { name: 'pageSize', type: 'number', default: 10 },
      { name: 'showPageSize', type: 'boolean', default: false },
      { name: 'showTotal', type: 'boolean', default: false },
      { name: 'showFirstLast', type: 'boolean', default: true },
      { name: 'siblingCount', type: 'number', default: 1 },
      { name: 'size', type: 'select', options: ['sm', 'md', 'lg'], default: 'md' },
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
      { name: 'virtualized', type: 'boolean', default: true },
      { name: 'bordered', type: 'boolean', default: false },
      { name: 'striped', type: 'boolean', default: false },
      { name: 'hoverable', type: 'boolean', default: true },
      { name: 'selectionMode', type: 'select', options: ['none', 'single', 'multiple'], default: 'none' },
      { name: 'sortKey', type: 'string' },
      { name: 'sortDirection', type: 'select', options: ['asc', 'desc'] },
      { name: 'loading', type: 'boolean', default: false },
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
      { name: 'height', type: 'number', default: 300 },
      { name: 'width', type: 'number' },
      { name: 'showGrid', type: 'boolean', default: true },
      { name: 'showLegend', type: 'boolean', default: true },
      { name: 'showXAxis', type: 'boolean', default: true },
      { name: 'showYAxis', type: 'boolean', default: true },
      { name: 'xAxisLabel', type: 'string' },
      { name: 'yAxisLabel', type: 'string' },
      { name: 'yMin', type: 'number' },
      { name: 'yMax', type: 'number' },
      { name: 'interactive', type: 'boolean', default: true },
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
      { name: 'height', type: 'number', default: 300 },
      { name: 'width', type: 'number' },
      { name: 'orientation', type: 'select', options: ['vertical', 'horizontal'], default: 'vertical' },
      { name: 'grouped', type: 'boolean', default: false },
      { name: 'stacked', type: 'boolean', default: false },
      { name: 'showGrid', type: 'boolean', default: true },
      { name: 'showValues', type: 'boolean', default: false },
      { name: 'showLegend', type: 'boolean', default: true },
      { name: 'interactive', type: 'boolean', default: true },
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
      { name: 'height', type: 'number', default: 300 },
      { name: 'width', type: 'number' },
      { name: 'innerRadius', type: 'number', default: 0, description: 'Greater than 0 makes a donut' },
      { name: 'showLabels', type: 'boolean', default: true },
      { name: 'showLegend', type: 'boolean', default: true },
      { name: 'showValues', type: 'boolean', default: false },
      { name: 'centerLabel', type: 'string' },
      { name: 'interactive', type: 'boolean', default: true },
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
      { name: 'language', type: 'select', options: ['javascript', 'typescript', 'json', 'html', 'css', 'python', 'sql', 'markdown', 'plain'], default: 'javascript' },
      { name: 'placeholder', type: 'string' },
      { name: 'minHeight', type: 'string', default: '200px' },
      { name: 'maxHeight', type: 'string', default: '500px' },
      { name: 'tabSize', type: 'number', default: 2 },
      { name: 'readOnly', type: 'boolean', default: false },
      { name: 'disabled', type: 'boolean', default: false },
      { name: 'lineNumbers', type: 'boolean', default: true },
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
      { name: 'viewMode', type: 'select', options: ['edit', 'preview', 'split'], default: 'split' },
      { name: 'showToolbar', type: 'boolean', default: true },
      { name: 'minHeight', type: 'string', default: '300px' },
      { name: 'maxHeight', type: 'string', default: '600px' },
      { name: 'readOnly', type: 'boolean', default: false },
      { name: 'disabled', type: 'boolean', default: false },
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
      { name: 'placeholder', type: 'string', default: 'Start writing...' },
      { name: 'showToolbar', type: 'boolean', default: true },
      { name: 'minHeight', type: 'string', default: '200px' },
      { name: 'maxHeight', type: 'string', default: '500px' },
      { name: 'readOnly', type: 'boolean', default: false },
      { name: 'disabled', type: 'boolean', default: false },
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
      { name: 'layout', type: 'select', options: ['vertical', 'horizontal', 'inline'], default: 'vertical' },
      { name: 'columns', type: 'number' },
      { name: 'submitText', type: 'string', default: 'Submit' },
      { name: 'cancelText', type: 'string' },
      { name: 'showCancel', type: 'boolean', default: false },
      { name: 'loading', type: 'boolean', default: false },
      { name: 'disabled', type: 'boolean', default: false },
      { name: 'collection', type: 'string', description: 'XDB collection to save into' },
      { name: 'recordId', type: 'expression' },
      { name: 'mode', type: 'select', options: ['create', 'edit'] },
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
      { name: 'layout', type: 'select', options: ['card', 'list', 'inline', 'grid'], default: 'list' },
      { name: 'gridColumns', type: 'number' },
      { name: 'showLabels', type: 'boolean', default: true },
      { name: 'labelPosition', type: 'select', options: ['top', 'left', 'inline'], default: 'top' },
      { name: 'title', type: 'string' },
      { name: 'showEmpty', type: 'boolean', default: false },
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
      { name: 'layout', type: 'select', options: ['grid', 'row', 'compact'], default: 'grid' },
      { name: 'columns', type: 'number' },
      { name: 'variant', type: 'select', options: ['default', 'gradient', 'outline', 'minimal'], default: 'default' },
      { name: 'size', type: 'select', options: ['sm', 'md', 'lg'], default: 'md' },
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
      { name: 'columns', type: 'number', default: 3 },
      { name: 'variant', type: 'select', options: ['default', 'elevated', 'outline', 'compact'], default: 'default' },
      { name: 'searchable', type: 'boolean', default: false },
      { name: 'selectable', type: 'boolean', default: false },
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
      { name: 'dividers', type: 'boolean', default: true },
      { name: 'variant', type: 'select', options: ['default', 'compact', 'card'], default: 'default' },
      { name: 'selectable', type: 'boolean', default: false },
      { name: 'maxItems', type: 'number' },
      { name: 'showViewAll', type: 'boolean', default: false },
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
      { name: 'time', type: 'string', default: 'date', description: 'Field holding the time' },
      { name: 'title', type: 'string', default: 'title', description: 'Field shown as the title' },
      { name: 'description', type: 'string', default: 'description', description: 'Field shown as the description' },
      { name: 'status', type: 'string' },
      { name: 'actor', type: 'string' },
      { name: 'variant', type: 'select', options: ['default', 'compact', 'card'], default: 'default' },
      { name: 'showLine', type: 'boolean', default: true },
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
      { name: 'title', type: 'string', default: 'No data yet' },
      { name: 'description', type: 'string', default: 'Get started by creating your first item.' },
      { name: 'size', type: 'select', options: ['sm', 'md', 'lg'], default: 'md' },
      { name: 'variant', type: 'select', options: ['default', 'card', 'minimal'], default: 'default' },
      { name: 'animated', type: 'boolean', default: true },
      { name: 'className', type: 'string' },
    ],
    false
  ),
  comp(    'Loop',
    'Utility',
    'repeat',
    'Render repeated content from an array expression',
    { interval: 1000, running: false },
    [
      { name: 'interval', type: 'number', default: 1000, description: 'Milliseconds between ticks' },
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
      { name: 'rows', type: 'number', default: 16 },
      { name: 'cols', type: 'number', default: 16 },
      { name: 'cellSize', type: 'number', default: 12 },
      { name: 'items', type: 'expression', description: 'Cells as [{ x, y, color }]' },
      { name: 'background', type: 'color' },
      { name: 'showGrid', type: 'boolean', default: false },
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
      { name: 'width', type: 'number', default: 160 },
      { name: 'height', type: 'number', default: 144 },
      // Omitted, the canvas takes the largest whole multiple that fits.
      { name: 'scale', type: 'number' },
      { name: 'palette', type: 'expression' },
      { name: 'getFrame', type: 'expression' },
      { name: 'frame', type: 'expression' },
      { name: 'running', type: 'boolean', default: true },
      { name: 'smooth', type: 'boolean', default: false },
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
      { name: 'sampleRate', type: 'number', default: 48000 },
      { name: 'channels', type: 'select', options: ['1', '2'], default: '2' },
      { name: 'format', type: 'select', options: ['i16', 'f32'], default: 'i16' },
      { name: 'bufferMs', type: 'number', default: 80 },
      { name: 'running', type: 'boolean', default: true },
      { name: 'muted', type: 'boolean', default: false },
      { name: 'volume', type: 'number', default: 1 },
      { name: 'showControls', type: 'boolean', default: true },
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
    'Microphone',
    'Utility',
    'mic',
    'Record audio as WAV, stream samples live, or meter the level',
    { mode: 'clip', sampleRate: 48000, processing: true },
    [
      { name: 'mode', type: 'select', options: ['clip', 'live', 'level'], default: 'clip' },
      { name: 'active', type: 'boolean', default: true },
      { name: 'sampleRate', type: 'number', default: 48000 },
      { name: 'frameSize', type: 'number', default: 2048 },
      // Echo cancellation, noise suppression and gain control together. On for
      // speech; off for anything measuring the sound rather than listening to it.
      { name: 'processing', type: 'boolean', default: true },
      { name: 'showControls', type: 'boolean', default: true },
      { name: 'showMeter', type: 'boolean', default: true },
      { name: 'maxSeconds', type: 'number', default: 60 },
      { name: 'autoStart', type: 'boolean', default: false },
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
  comp(    'Draggable',
    'Utility',
    'move',
    'Drag-and-drop wrapper for any child content',
    { axis: 'both' },
    [
      { name: 'axis', type: 'select', options: ['both', 'x', 'y'], default: 'both' },
      { name: 'disabled', type: 'boolean', default: false },
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
      { name: 'renderKey', type: 'string', default: 'id', description: 'Field that identifies an item' },
      { name: 'primary', type: 'string' },
      { name: 'secondary', type: 'string' },
      { name: 'direction', type: 'select', options: ['vertical', 'horizontal'], default: 'vertical' },
      { name: 'gap', type: 'number', default: 8 },
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
      { name: 'contentWidth', type: 'number', default: 800 },
      { name: 'contentHeight', type: 'number', default: 600 },
      { name: 'scale', type: 'number', default: 1 },
      { name: 'centered', type: 'boolean', default: true },
      { name: 'recenterKey', type: 'expression' },
      { name: 'draggable', type: 'boolean', default: true },
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
  comp(    'AreaChart',
    'Charts',
    'area-chart',
    'Area chart visualization',
    { series: '[]' },
    [
      { name: 'series', type: 'expression', description: 'Series as [{ name, data: [{ x, y }] }]' },
      { name: 'height', type: 'number' },
      { name: 'width', type: 'number' },
      { name: 'stacked', type: 'boolean', default: false },
      { name: 'gradient', type: 'boolean', default: true },
      { name: 'showGrid', type: 'boolean', default: true },
      { name: 'showLegend', type: 'boolean', default: true },
      { name: 'xAxisLabel', type: 'string' },
      { name: 'yAxisLabel', type: 'string' },
      { name: 'interactive', type: 'boolean', default: true },
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
      { name: 'levels', type: 'number', default: 5 },
      { name: 'height', type: 'number' },
      { name: 'width', type: 'number' },
      { name: 'showLegend', type: 'boolean', default: true },
      { name: 'interactive', type: 'boolean', default: true },
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
    { width: 800, height: 600, orbitControls: true },
    [
      { name: 'width', type: 'number', default: 800 },
      { name: 'height', type: 'number', default: 600 },
      { name: 'background', type: 'color', default: '#1a1a2e' },
      { name: 'shadows', type: 'boolean', default: false },
      { name: 'orbitControls', type: 'boolean', default: true },
      { name: 'autoRotate', type: 'boolean', default: false },
      { name: 'autoRotateSpeed', type: 'number', default: 2 },
      { name: 'mouseLook', type: 'boolean', default: false },
      { name: 'mouseLookSensitivity', type: 'number', default: 0.003 },
      { name: 'pointerLock', type: 'boolean', default: false },
      { name: 'pitchLimit', type: 'number', default: 0.8 },
      { name: 'cameraSmoothing', type: 'number', default: 0 },
      { name: 'maxPixelRatio', type: 'number', default: 2 },
      { name: 'expandable', type: 'boolean', default: false },
      { name: 'className', type: 'string' },
    ],
    false
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
      options: ['alert', 'status', 'none'],
      description: 'How it is announced: alert at once, status when the reader is free, none for an alert that is part of the page',
    },
  ],
  AreaChart: [ariaLabel(CHART_ALTERNATIVE)],
  Avatar: [ariaLabel('Accessible label, for an interactive avatar')],
  BarChart: [ariaLabel(CHART_ALTERNATIVE)],
  CodeEditor: [ariaLabel('Accessible name for the text field, when no visible label names it')],
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
  Pagination: [ariaLabel(NAME_WHEN_UNLABELLED)],
  PieChart: [ariaLabel(CHART_ALTERNATIVE)],
  PixelCanvas: [ariaLabel(NAME_WHEN_UNLABELLED)],
  Popover: [ariaLabel('Accessible name for the popup')],
  Progress: [ariaLabel('Accessible name for the bar (default "Progress")')],
  QRCode: [ariaLabel(NAME_WHEN_UNLABELLED)],
  RadarChart: [ariaLabel(CHART_ALTERNATIVE)],
  RichTextEditor: [ariaLabel(NAME_WHEN_UNLABELLED)],
  Section: [{ name: 'headingLevel', type: 'number', description: 'Heading level of the title (1–6, default 2)' }],
  Slider: [ariaLabel('Accessible name for the slider')],
  SortableList: [ariaLabel(NAME_WHEN_UNLABELLED)],
  Spacer: [{ name: 'className', type: 'string' }],
  Split: [ariaLabel('Accessible name for the divider (default "Resize panes")')],
  Sprite: [ariaLabel(NAME_WHEN_UNLABELLED)],
  Table: [
    { name: 'caption', type: 'string', description: 'Visible caption naming the table' },
    ariaLabel('Accessible name for the table, when it has no caption'),
  ],
  Tabs: [ariaLabel(NAME_WHEN_UNLABELLED)],
  Tag: [{ name: 'removeLabel', type: 'string', description: 'Accessible name for the remove button (default "Remove" and the tag’s text)' }],
  TreeView: [ariaLabel(NAME_WHEN_UNLABELLED)],
};

/** Props the property panel shows under Accessibility rather than Advanced. */
export const ACCESSIBILITY_PROP_NAMES: ReadonlySet<string> = new Set(['ariaLabel', 'removeLabel', 'caption', 'headingLevel', 'role']);

export const componentRegistry: ComponentMeta[] = baseRegistry.map((meta) => {
  const extra = (MANIFEST_PROPS[meta.name] ?? []).filter((prop) => !meta.propSchema.some((own) => own.name === prop.name));
  return extra.length ? { ...meta, propSchema: [...meta.propSchema, ...extra] } : meta;
});

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
  return componentRegistry.find((c) => c.name === name) ?? getNativeHtmlMeta(name);
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
