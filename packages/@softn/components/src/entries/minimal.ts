/**
 * The components every app is likely to use and no app is hurt by: layout,
 * forms, display, feedback, navigation, the data views and the light
 * utilities. Measured with esbuild, minified, dependencies external: about
 * 190 KB together, and nothing beyond React and @softn/core in their import
 * graphs. Everything heavier — Three.js behind Scene3D, the QR scanner and
 * the camera and microphone behind the media group, the editors, the charts,
 * the Smart family, the animation primitives — lives in its own entry and
 * reaches the registry as a loader (see lazy.ts).
 *
 * A host that wants a component directly imports it from here or from the
 * feature entry that owns it, never from the root barrel: the barrel is the
 * eager path and drags every feature into whichever chunk imports it.
 */

import type { ComponentRegistry, SoftNComponent } from '@softn/core';
import { getDefaultRegistry } from '@softn/core';

export * from '../layout';
export * from '../form';
export * from '../display';
export * from '../feedback';
export * from '../navigation';
export * from '../data';
export * from '../utility/Accordion';
export * from '../utility/Collapse';
export * from '../utility/Tooltip';
export * from '../utility/Loop';
export * from '../utility/PixelGrid';
export * from '../utility/PixelCanvas';
export * from '../utility/DPad';

import { Stack } from '../layout/Stack';
import { Box } from '../layout/Box';
import { Card } from '../layout/Card';
import { Grid } from '../layout/Grid';
import { Container } from '../layout/Container';
import { Divider } from '../layout/Divider';
import { Spacer } from '../layout/Spacer';
import { Center } from '../layout/Center';
import { Sidebar } from '../layout/Sidebar';
import { Split } from '../layout/Split';
import { App } from '../layout/App';
import { Layout } from '../layout/Layout';
import { Header } from '../layout/Header';
import { Content } from '../layout/Content';
import { Section } from '../layout/Section';
import { Button } from '../form/Button';
import { Input } from '../form/Input';
import { Form } from '../form/Form';
import { TextArea } from '../form/TextArea';
import { Select } from '../form/Select';
import { Checkbox } from '../form/Checkbox';
import { Switch } from '../form/Switch';
import { Radio } from '../form/Radio';
import { Slider } from '../form/Slider';
import { DatePicker } from '../form/DatePicker';
import { ColorPicker } from '../form/ColorPicker';
import { FileChooser } from '../form/FileChooser';
import { Text } from '../display/Text';
import { Heading } from '../display/Heading';
import { Badge } from '../display/Badge';
import { Tag } from '../display/Tag';
import { Avatar } from '../display/Avatar';
import { Progress } from '../display/Progress';
import { Spinner } from '../display/Spinner';
import { Image } from '../display/Image';
import { Icon } from '../display/Icon';
import { Alert } from '../feedback/Alert';
import { Modal } from '../feedback/Modal';
import { Toast } from '../feedback/Toast';
import { Drawer } from '../feedback/Drawer';
import { Popover } from '../feedback/Popover';
import { EmptyState } from '../feedback/EmptyState';
import { List, ListItem } from '../data/List';
import { Table } from '../data/Table';
import { TreeView } from '../data/TreeView';
import { Pagination } from '../data/Pagination';
import { DataGrid } from '../data/DataGrid';
import { Tabs } from '../navigation/Tabs';
import { Breadcrumb } from '../navigation/Breadcrumb';
import { Menu } from '../navigation/Menu';
import { NavItem } from '../navigation/NavItem';
import { Accordion } from '../utility/Accordion';
import { Collapse } from '../utility/Collapse';
import { Tooltip } from '../utility/Tooltip';
import { Loop } from '../utility/Loop';
import { PixelGrid } from '../utility/PixelGrid';
import { PixelCanvas } from '../utility/PixelCanvas';
import { DPad } from '../utility/DPad';

/**
 * The minimal set, by registry name. The keys are the tag names a document
 * uses; the same names appear in registry.ts's eager `builtinComponents`.
 */
export const minimalComponents = {
  // Layout
  Stack,
  Box,
  Card,
  Grid,
  Container,
  Divider,
  Spacer,
  Center,
  Sidebar,
  Split,
  App,
  Layout,
  Header,
  Content,
  Section,

  // Form
  Button,
  Input,
  Form,
  TextArea,
  Select,
  Checkbox,
  Switch,
  Radio,
  Slider,
  DatePicker,
  ColorPicker,
  FileChooser,

  // Display
  Text,
  Heading,
  Badge,
  Tag,
  Avatar,
  Progress,
  Spinner,
  Image,
  Icon,

  // Feedback
  Alert,
  Modal,
  Toast,
  Drawer,
  Popover,
  EmptyState,

  // Data
  List,
  ListItem,
  Table,
  TreeView,
  Pagination,
  DataGrid,

  // Navigation
  Tabs,
  Breadcrumb,
  Menu,
  NavItem,

  // Light utilities
  Accordion,
  Collapse,
  Tooltip,
  Loop,
  PixelGrid,
  PixelCanvas,
  DPad,
};

/**
 * Register the minimal set eagerly. On its own this is a host that renders
 * plain documents; registerRuntimeComponents() in lazy.ts adds every other
 * built-in by loader.
 */
export function registerMinimalComponents(
  registry: ComponentRegistry = getDefaultRegistry()
): void {
  registry.registerAll(minimalComponents as unknown as Record<string, SoftNComponent>);
}
