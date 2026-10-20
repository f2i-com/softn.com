/**
 * The components every app is likely to use and no app is hurt by: layout,
 * forms, display, feedback, navigation, the data views and the light
 * utilities. Measured with esbuild, minified, dependencies external: about
 * 245 KB together, and nothing beyond React and @softn/core in their import
 * graphs. Everything heavier or rarer — Three.js behind Scene3D, the QR
 * scanner and the camera and microphone behind the media group, the editors,
 * the charts, the Smart family, the animation primitives, the date and colour
 * pickers, the game pieces — lives in its own entry and reaches the registry
 * as a loader (see lazy.ts).
 *
 * A host that wants a component directly imports it from here or from the
 * feature entry that owns it, never from the root barrel: the barrel is the
 * eager path and drags every feature into whichever chunk imports it.
 */

import type { ComponentRegistry, SoftNComponent } from '@softn/core';
import { getDefaultRegistry } from '@softn/core';
import { declareBuiltinPropKinds } from '../prop-kinds';

export * from '../layout';
// The form controls but the pickers, which are an entry of their own.
export * from '../form/Button';
export * from '../form/Input';
export * from '../form/Form';
export * from '../form/TextArea';
export * from '../form/Select';
export * from '../form/Checkbox';
export * from '../form/Switch';
export * from '../form/Radio';
export * from '../form/Slider';
export * from '../form/FileChooser';
export * from '../form/NumberInput';
export * from '../form/Rating';
export * from '../form/SegmentedControl';
export * from '../form/ButtonGroup';
export * from '../form/Field';
export * from '../form/CopyButton';
export * from '../display';
export * from '../feedback';
export * from '../navigation';
export * from '../data';
export * from '../utility/Accordion';
export * from '../utility/Collapse';
export * from '../utility/Tooltip';
export * from '../utility/Loop';

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
import { FileChooser } from '../form/FileChooser';
import { NumberInput } from '../form/NumberInput';
import { Rating } from '../form/Rating';
import { SegmentedControl } from '../form/SegmentedControl';
import { ButtonGroup } from '../form/ButtonGroup';
import { Field } from '../form/Field';
import { CopyButton } from '../form/CopyButton';
import { Text } from '../display/Text';
import { Heading } from '../display/Heading';
import { Badge } from '../display/Badge';
import { Tag, TagGroup } from '../display/Tag';
import { Avatar, AvatarGroup } from '../display/Avatar';
import { Progress } from '../display/Progress';
import { Spinner } from '../display/Spinner';
import { Image } from '../display/Image';
import { Icon } from '../display/Icon';
import { Skeleton } from '../display/Skeleton';
import { Stat } from '../display/Stat';
import { Kbd } from '../display/Kbd';
import { DescriptionList } from '../display/DescriptionList';
import { Alert } from '../feedback/Alert';
import { Modal } from '../feedback/Modal';
import { Toast } from '../feedback/Toast';
import { Drawer } from '../feedback/Drawer';
import { Popover } from '../feedback/Popover';
import { EmptyState } from '../feedback/EmptyState';
import { Confirm } from '../feedback/Confirm';
import { List, ListItem } from '../data/List';
import { Table } from '../data/Table';
import { TreeView } from '../data/TreeView';
import { Pagination } from '../data/Pagination';
import { DataGrid } from '../data/DataGrid';
import { Timeline } from '../data/Timeline';
import { Tabs } from '../navigation/Tabs';
import { Breadcrumb } from '../navigation/Breadcrumb';
import { Menu } from '../navigation/Menu';
import { NavItem } from '../navigation/NavItem';
import { Steps } from '../navigation/Steps';
import { Accordion } from '../utility/Accordion';
import { Collapse } from '../utility/Collapse';
import { Tooltip } from '../utility/Tooltip';
import { Loop } from '../utility/Loop';

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
  FileChooser,
  NumberInput,
  Rating,
  SegmentedControl,
  ButtonGroup,
  Field,
  CopyButton,

  // Display
  Text,
  Heading,
  Badge,
  Tag,
  TagGroup,
  Avatar,
  AvatarGroup,
  Progress,
  Spinner,
  Image,
  Icon,
  Skeleton,
  Stat,
  Kbd,
  DescriptionList,

  // Feedback
  Alert,
  Modal,
  Toast,
  Drawer,
  Popover,
  EmptyState,
  Confirm,

  // Data
  List,
  ListItem,
  Table,
  TreeView,
  Pagination,
  DataGrid,
  Timeline,

  // Navigation
  Tabs,
  Breadcrumb,
  Menu,
  NavItem,
  Steps,

  // Light utilities
  Accordion,
  Collapse,
  Tooltip,
  Loop,
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
  declareBuiltinPropKinds(registry);
}
