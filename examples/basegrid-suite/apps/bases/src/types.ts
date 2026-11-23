export type FieldType =
  | 'text'
  | 'long_text'
  | 'number'
  | 'currency'
  | 'percent'
  | 'checkbox'
  | 'single_select'
  | 'multi_select'
  | 'date'
  | 'rating'
  | 'email'
  | 'url'
  | 'attachment'
  | 'link'
  | 'lookup'
  | 'rollup'
  | 'formula'
  | 'ai_agent';

export type ViewType =
  | 'grid'
  | 'kanban'
  | 'calendar'
  | 'gallery'
  | 'timeline'
  | 'list'
  | 'inbox';

export interface BaseSummary {
  id: number;
  name: string;
  description: string;
  color: string;
  icon: string;
  created_at: string;
  tableCount?: number;
  recordCount?: number;
}

export interface TableMeta {
  id: number;
  base_id: number;
  name: string;
  description: string;
  position: number;
}

export interface FieldOptions {
  choices?: string[];
  symbol?: string;
  max?: number;
  targetTableId?: number;
  linkFieldId?: number;
  targetFieldId?: number;
  agg?: 'SUM' | 'AVG' | 'COUNT' | 'MIN' | 'MAX';
  formula?: string;
  prompt?: string;
  mode?: string;
}

export interface FieldMeta {
  id: number;
  table_id: number;
  name: string;
  field_type: FieldType;
  options: FieldOptions;
  is_primary: boolean;
  width: number;
  position: number;
}

export interface FilterRule {
  fieldId: number;
  op: 'contains' | 'equals' | 'not_equals' | 'gt' | 'lt' | 'is_empty' | 'not_empty';
  value: string;
}

export interface SortRule {
  fieldId: number;
  dir: 'asc' | 'desc';
}

export interface ViewConfig {
  rowHeight?: 'compact' | 'medium' | 'tall';
  groupBy?: number | null;
  groupFieldId?: number;
  dateFieldId?: number;
  startFieldId?: number;
  endFieldId?: number;
  statusFieldId?: number;
  coverFieldId?: number;
  checkFieldId?: number;
  hiddenFieldIds?: number[];
  filters?: FilterRule[];
  sorts?: SortRule[];
  summaryAgg?: Record<string, 'SUM' | 'AVG' | 'MIN' | 'MAX' | 'COUNT' | 'FILLED'>;
}

export interface ViewMeta {
  id: number;
  table_id: number;
  name: string;
  view_type: ViewType;
  config: ViewConfig;
  position: number;
}

export interface RecordRow {
  id: number;
  table_id: number;
  cells: Record<string, unknown>;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface BaseWorkspace {
  base: BaseSummary;
  tables: TableMeta[];
  fields: FieldMeta[];
  views: ViewMeta[];
  records: RecordRow[];
}

export interface RecordComment {
  id: number;
  record_id: number;
  author: string;
  body: string;
  created_at: string;
}

export interface RecordHistoryItem {
  id: number;
  record_id: number;
  actor: string;
  field_name: string;
  old_value: string;
  new_value: string;
  created_at: string;
}
