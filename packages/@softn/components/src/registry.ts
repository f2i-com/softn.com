/**
 * SoftN Component Registry
 *
 * Registers all built-in components.
 */

import React from 'react';
import { ComponentRegistry, registerComponents } from '@softn/core';

// Layout components
import { Stack } from './layout/Stack';
import { Box } from './layout/Box';
import { Card } from './layout/Card';
import { Grid } from './layout/Grid';
import { Container } from './layout/Container';
import { Divider } from './layout/Divider';
import { Spacer } from './layout/Spacer';
import { Center } from './layout/Center';
import { Sidebar } from './layout/Sidebar';
import { Split } from './layout/Split';
import { App } from './layout/App';
import { Layout } from './layout/Layout';
import { Header } from './layout/Header';
import { Content } from './layout/Content';
import { Section } from './layout/Section';

// Form components
import { Button } from './form/Button';
import { Input } from './form/Input';
import { Form } from './form/Form';
import { TextArea } from './form/TextArea';
import { Select } from './form/Select';
import { Checkbox } from './form/Checkbox';
import { Switch } from './form/Switch';
import { Radio } from './form/Radio';
import { Slider } from './form/Slider';
import { DatePicker } from './form/DatePicker';
import { ColorPicker } from './form/ColorPicker';
import { FileChooser } from './form/FileChooser';

// Display components
import { Text } from './display/Text';
import { Heading } from './display/Heading';
import { Badge } from './display/Badge';
import { Tag } from './display/Tag';
import { Avatar } from './display/Avatar';
import { Progress } from './display/Progress';
import { Spinner } from './display/Spinner';
import { Image } from './display/Image';
import { Icon } from './display/Icon';

// Feedback components
import { Alert } from './feedback/Alert';
import { Modal } from './feedback/Modal';
import { Toast } from './feedback/Toast';
import { Drawer } from './feedback/Drawer';
import { Popover } from './feedback/Popover';
import { EmptyState } from './feedback/EmptyState';

// Data components
import { List, ListItem } from './data/List';
import { Table } from './data/Table';
import { TreeView } from './data/TreeView';
import { Pagination } from './data/Pagination';
import { DataGrid } from './data/DataGrid';

// Navigation components
import { Tabs } from './navigation/Tabs';
import { Breadcrumb } from './navigation/Breadcrumb';
import { Menu } from './navigation/Menu';
import { NavItem } from './navigation/NavItem';

// Utility components
import { Accordion } from './utility/Accordion';
import { Collapse } from './utility/Collapse';
import { Tooltip } from './utility/Tooltip';
import { Loop } from './utility/Loop';
import { PixelGrid } from './utility/PixelGrid';
import { QRCode } from './utility/QRCode';
import { QRReader } from './utility/QRReader';
import { Camera } from './utility/Camera';
import { DPad } from './utility/DPad';

// Chart components
import { LineChart } from './charts/LineChart';
import { BarChart } from './charts/BarChart';
import { PieChart } from './charts/PieChart';
import { AreaChart } from './charts/AreaChart';
import { RadarChart } from './charts/RadarChart';
import { GaugeChart } from './charts/GaugeChart';

// Animation components
import { AnimatedBox } from './animation/AnimatedBox';
import { AnimatedNumber } from './animation/AnimatedNumber';
import { Marquee } from './animation/Marquee';
import { Typewriter } from './animation/Typewriter';
import { Draggable } from './animation/Draggable';
import { SortableList } from './animation/SortableList';
import { Sprite } from './animation/Sprite';
import { TileMap } from './animation/TileMap';

// Editor components
import { CodeEditor } from './editors/CodeEditor';
import { MarkdownEditor } from './editors/MarkdownEditor';
import { RichTextEditor } from './editors/RichTextEditor';

// 3D components
import { Scene3D } from './threed/Scene3D';

// Smart components
import { SmartGrid } from './smart/SmartGrid';
import { SmartView } from './smart/SmartView';
import { SmartForm } from './smart/SmartForm';
import { SmartStats } from './smart/SmartStats';
import { SmartCards } from './smart/SmartCards';
import { SmartList } from './smart/SmartList';
import { SmartTimeline } from './smart/SmartTimeline';

/**
 * All built-in components
 */
export const builtinComponents = {
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

  // Utility
  Accordion,
  Collapse,
  Tooltip,
  Loop,
  PixelGrid,
  QRCode,
  QRReader,
  Camera,
  DPad,

  // Charts
  LineChart,
  BarChart,
  PieChart,
  AreaChart,
  RadarChart,
  GaugeChart,

  // Animation
  AnimatedBox,
  AnimatedNumber,
  Marquee,
  Typewriter,
  Draggable,
  SortableList,
  Sprite,
  TileMap,

  // Editors
  CodeEditor,
  MarkdownEditor,
  RichTextEditor,

  // 3D
  Scene3D,

  // Smart Components
  SmartGrid,
  SmartView,
  SmartForm,
  SmartStats,
  SmartCards,
  SmartList,
  SmartTimeline,
};

/**
 * Register all built-in components in the given registry
 */
export function registerBuiltinComponents(registry: ComponentRegistry): void {
  registry.registerAll(builtinComponents as Record<string, React.ComponentType<any>>);
}

/**
 * Register all built-in components in the default registry
 */
export function registerAllBuiltins(): void {
  registerComponents(builtinComponents as Record<string, React.ComponentType<any>>);
}
