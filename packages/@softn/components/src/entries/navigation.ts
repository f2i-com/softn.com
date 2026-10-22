/**
 * Ways through a page: tabs, breadcrumbs, menus, navigation items, steps,
 * accordions and collapsing sections. Fetched the first time a page draws
 * one.
 */
export * from '../navigation/Tabs';
export * from '../navigation/Breadcrumb';
export * from '../navigation/Menu';
export * from '../navigation/NavItem';
export * from '../navigation/Steps';
export * from '../utility/Accordion';
export * from '../utility/Collapse';

import { Tabs } from '../navigation/Tabs';
import { Breadcrumb } from '../navigation/Breadcrumb';
import { Menu } from '../navigation/Menu';
import { NavItem } from '../navigation/NavItem';
import { Steps } from '../navigation/Steps';
import { Accordion } from '../utility/Accordion';
import { Collapse } from '../utility/Collapse';

export const navigationComponents = { Tabs, Breadcrumb, Menu, NavItem, Steps, Accordion, Collapse };
