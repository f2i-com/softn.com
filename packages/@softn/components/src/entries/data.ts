/**
 * The data views beyond a list: tables, the data grid, trees, pagination and
 * timelines. Fetched the first time a page draws one; List and ListItem are
 * in the start-up set, and the Smart family is a feature of its own.
 */
export * from '../data/Table';
export * from '../data/TreeView';
export * from '../data/Pagination';
export * from '../data/DataGrid';
export * from '../data/Timeline';

import { Table } from '../data/Table';
import { TreeView } from '../data/TreeView';
import { Pagination } from '../data/Pagination';
import { DataGrid } from '../data/DataGrid';
import { Timeline } from '../data/Timeline';

export const dataComponents = { Table, TreeView, Pagination, DataGrid, Timeline };
