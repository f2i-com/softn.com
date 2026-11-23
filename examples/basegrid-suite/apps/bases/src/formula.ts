import type { FieldMeta, RecordRow } from './types';

/**
 * Pure, safe, zero-eval relational field resolver & Airtable formula evaluator:
 * supports Linked Records, Lookups, Rollups (SUM/AVG/COUNT/MIN/MAX),
 * AI Field Agent local synthesis, and arithmetic/function Formulas
 * (`ROUND`, `MAX`, `MIN`, `ABS`, `IF`, `SUM`, `AVG`, `CONCAT`, `LEN`).
 */

export interface WorkspaceIndex {
  fieldsByTable: Map<number, FieldMeta[]>;
  fieldById: Map<number, FieldMeta>;
  recordsById: Map<number, RecordRow>;
  recordsByTable: Map<number, RecordRow[]>;
  primaryFieldByTable: Map<number, FieldMeta>;
}

export function buildWorkspaceIndex(fields: FieldMeta[], records: RecordRow[]): WorkspaceIndex {
  const fieldsByTable = new Map<number, FieldMeta[]>();
  const fieldById = new Map<number, FieldMeta>();
  const primaryFieldByTable = new Map<number, FieldMeta>();

  for (const f of fields) {
    fieldById.set(f.id, f);
    const list = fieldsByTable.get(f.table_id) ?? [];
    list.push(f);
    fieldsByTable.set(f.table_id, list);
    if (f.is_primary) {
      primaryFieldByTable.set(f.table_id, f);
    }
  }

  const recordsById = new Map<number, RecordRow>();
  const recordsByTable = new Map<number, RecordRow[]>();
  for (const r of records) {
    recordsById.set(r.id, r);
    const list = recordsByTable.get(r.table_id) ?? [];
    list.push(r);
    recordsByTable.set(r.table_id, list);
  }

  return { fieldsByTable, fieldById, recordsById, recordsByTable, primaryFieldByTable };
}

export function getRecordTitle(record: RecordRow, idx: WorkspaceIndex): string {
  const pf = idx.primaryFieldByTable.get(record.table_id);
  if (pf) {
    const val = record.cells[String(pf.id)];
    if (val !== undefined && val !== null && String(val).trim() !== '') {
      return String(val);
    }
  }
  return `Record #${record.id}`;
}

export function resolveFieldValue(
  record: RecordRow,
  field: FieldMeta,
  idx: WorkspaceIndex,
  depth = 0
): unknown {
  if (depth > 4) return null;

  if (field.field_type === 'lookup') {
    const linkFieldId = field.options.linkFieldId;
    const targetFieldId = field.options.targetFieldId;
    if (!linkFieldId || !targetFieldId) return [];
    const linkedIds = asNumberArray(record.cells[String(linkFieldId)]);
    const targetField = idx.fieldById.get(targetFieldId);
    if (!targetField) return [];
    return linkedIds
      .map((id) => idx.recordsById.get(id))
      .filter((r): r is RecordRow => Boolean(r))
      .map((r) => resolveFieldValue(r, targetField, idx, depth + 1))
      .filter((v) => v !== null && v !== undefined && String(v) !== '');
  }

  if (field.field_type === 'rollup') {
    const linkFieldId = field.options.linkFieldId;
    const targetFieldId = field.options.targetFieldId;
    const agg = field.options.agg ?? 'SUM';
    if (!linkFieldId || !targetFieldId) return 0;
    const linkedIds = asNumberArray(record.cells[String(linkFieldId)]);
    const targetField = idx.fieldById.get(targetFieldId);
    if (!targetField) return 0;
    const nums = linkedIds
      .map((id) => idx.recordsById.get(id))
      .filter((r): r is RecordRow => Boolean(r))
      .map((r) => toNum(resolveFieldValue(r, targetField, idx, depth + 1)));

    if (agg === 'COUNT') return linkedIds.length;
    if (nums.length === 0) return 0;
    if (agg === 'SUM') return round2(nums.reduce((a, b) => a + b, 0));
    if (agg === 'AVG') return round2(nums.reduce((a, b) => a + b, 0) / nums.length);
    if (agg === 'MIN') return Math.min(...nums);
    if (agg === 'MAX') return Math.max(...nums);
    return 0;
  }

  if (field.field_type === 'formula') {
    const expr = field.options.formula ?? '';
    return evaluateFormula(expr, record, idx, depth + 1);
  }

  return record.cells[String(field.id)] ?? null;
}

export function synthesizeAiAgentValue(record: RecordRow, field: FieldMeta, idx: WorkspaceIndex): string {
  const tableFields = idx.fieldsByTable.get(record.table_id) ?? [];
  const primary = getRecordTitle(record, idx);
  let status = '';
  let money = 0;
  let pct = 0;
  for (const f of tableFields) {
    if (f.id === field.id) continue;
    const v = resolveFieldValue(record, f, idx, 1);
    if (!status && f.field_type === 'single_select' && v) status = String(v);
    if (!money && f.field_type === 'currency') money = toNum(v);
    if (!pct && f.field_type === 'percent') pct = toNum(v);
  }
  const mode = field.options.mode ?? 'summary';
  if (mode === 'risk') {
    if (/risk|block|delay/i.test(status)) {
      return `High attention: ${primary} flagged "${status}" — schedule exec alignment.`;
    }
    return `Healthy signal: ${primary} (${status || 'Active'}) tracking cleanly${money > 0 ? ` at $${String(Math.round(money)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}` : ''}.`;
  }
  return `AI Brief: ${primary} is ${status || 'Active'}${pct > 0 ? ` (${pct}% confidence)` : ''}${money > 0 ? ` · $${String(Math.round(money)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} allocated` : ''}.`;
}

function asNumberArray(val: unknown): number[] {
  if (!Array.isArray(val)) return [];
  return val.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0);
}

function toNum(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const cleaned = v.replace(/[$,%\s,]/g, '');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ==================== SAFE RECURSIVE DESCENT FORMULA PARSER ====================
type Token =
  | { type: 'num'; val: number }
  | { type: 'str'; val: string }
  | { type: 'ident'; val: string }
  | { type: 'op'; val: string }
  | { type: 'punct'; val: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '"' || ch === "'") {
      const q = ch;
      let s = '';
      i++;
      while (i < input.length && input[i] !== q) {
        s += input[i++];
      }
      i++;
      tokens.push({ type: 'str', val: s });
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let numStr = '';
      while (i < input.length && /[0-9.]/.test(input[i])) {
        numStr += input[i++];
      }
      tokens.push({ type: 'num', val: Number(numStr) || 0 });
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let id = '';
      while (i < input.length && /[a-zA-Z0-9_]/.test(input[i])) {
        id += input[i++];
      }
      tokens.push({ type: 'ident', val: id.toUpperCase() });
      continue;
    }
    const two = input.slice(i, i + 2);
    if (two === '>=' || two === '<=' || two === '!=' || two === '==') {
      tokens.push({ type: 'op', val: two });
      i += 2;
      continue;
    }
    if ('+-*/><='.includes(ch)) {
      tokens.push({ type: 'op', val: ch });
      i++;
      continue;
    }
    if ('(),'.includes(ch)) {
      tokens.push({ type: 'punct', val: ch });
      i++;
      continue;
    }
    i++;
  }
  return tokens;
}

export function evaluateFormula(
  formula: string,
  record: RecordRow,
  idx: WorkspaceIndex,
  depth = 1
): string | number {
  if (!formula.trim()) return '';
  const tableFields = idx.fieldsByTable.get(record.table_id) ?? [];
  const fieldByName = new Map<string, FieldMeta>();
  for (const f of tableFields) {
    fieldByName.set(f.name.toLowerCase(), f);
  }

  // Substitute {Field Name} tokens with literal values
  const substituted = formula.replace(/\{([^}]+)\}/g, (_m, rawName: string) => {
    const f = fieldByName.get(rawName.trim().toLowerCase());
    if (!f) return '0';
    const val = resolveFieldValue(record, f, idx, depth + 1);
    if (typeof val === 'number') return String(val);
    if (typeof val === 'boolean') return val ? '1' : '0';
    if (val === null || val === undefined || val === '') return '0';
    const numeric = Number(String(val).replace(/[$,%\s,]/g, ''));
    if (Number.isFinite(numeric) && String(val).trim() !== '') {
      return String(numeric);
    }
    return JSON.stringify(String(val));
  });

  try {
    const tokens = tokenize(substituted);
    let pos = 0;

    const peek = () => tokens[pos];
    const consume = () => tokens[pos++];

    const parseComparison = (): string | number => {
      let left = parseAddSub();
      while (peek()?.type === 'op' && ['>', '<', '>=', '<=', '=', '==', '!='].includes((peek() as { val: string }).val)) {
        const op = (consume() as { val: string }).val;
        const right = parseAddSub();
        if (op === '>') left = toNum(left) > toNum(right) ? 1 : 0;
        else if (op === '<') left = toNum(left) < toNum(right) ? 1 : 0;
        else if (op === '>=') left = toNum(left) >= toNum(right) ? 1 : 0;
        else if (op === '<=') left = toNum(left) <= toNum(right) ? 1 : 0;
        else if (op === '=' || op === '==') left = String(left) === String(right) ? 1 : 0;
        else if (op === '!=') left = String(left) !== String(right) ? 1 : 0;
      }
      return left;
    };

    const parseAddSub = (): string | number => {
      let left = parseMulDiv();
      while (peek()?.type === 'op' && ['+', '-'].includes((peek() as { val: string }).val)) {
        const op = (consume() as { val: string }).val;
        const right = parseMulDiv();
        if (op === '+') {
          if (typeof left === 'string' || typeof right === 'string') {
            left = String(left) + String(right);
          } else {
            left = toNum(left) + toNum(right);
          }
        } else {
          left = toNum(left) - toNum(right);
        }
      }
      return left;
    };

    const parseMulDiv = (): string | number => {
      let left = parseUnary();
      while (peek()?.type === 'op' && ['*', '/'].includes((peek() as { val: string }).val)) {
        const op = (consume() as { val: string }).val;
        const right = parseUnary();
        if (op === '*') left = toNum(left) * toNum(right);
        else left = toNum(right) === 0 ? 0 : toNum(left) / toNum(right);
      }
      return left;
    };

    const parseUnary = (): string | number => {
      if (peek()?.type === 'op' && (peek() as { val: string }).val === '-') {
        consume();
        return -toNum(parseUnary());
      }
      return parsePrimary();
    };

    const parsePrimary = (): string | number => {
      const t = peek();
      if (!t) return 0;
      if (t.type === 'num') { consume(); return t.val; }
      if (t.type === 'str') { consume(); return t.val; }
      if (t.type === 'punct' && t.val === '(') {
        consume();
        const inner = parseComparison();
        if (peek()?.type === 'punct' && (peek() as { val: string }).val === ')') consume();
        return inner;
      }
      if (t.type === 'ident') {
        consume();
        const fn = t.val;
        const args: (string | number)[] = [];
        if (peek()?.type === 'punct' && (peek() as { val: string }).val === '(') {
          consume();
          while (peek() && !(peek()?.type === 'punct' && (peek() as { val: string }).val === ')')) {
            args.push(parseComparison());
            if (peek()?.type === 'punct' && (peek() as { val: string }).val === ',') consume();
          }
          if (peek()?.type === 'punct' && (peek() as { val: string }).val === ')') consume();
        }
        return runFormulaFn(fn, args);
      }
      consume();
      return 0;
    };

    const result = parseComparison();
    if (typeof result === 'number') {
      return Number.isFinite(result) ? Math.round(result * 100) / 100 : 0;
    }
    return result;
  } catch {
    return '#ERR';
  }
}

function runFormulaFn(fn: string, args: (string | number)[]): string | number {
  const nums = args.map(toNum);
  switch (fn) {
    case 'ROUND': {
      const decimals = Math.max(0, Math.min(4, Math.round(nums[1] ?? 0)));
      const factor = Math.pow(10, decimals);
      return Math.round((nums[0] ?? 0) * factor) / factor;
    }
    case 'MAX':
      return nums.length ? Math.max(...nums) : 0;
    case 'MIN':
      return nums.length ? Math.min(...nums) : 0;
    case 'ABS':
      return Math.abs(nums[0] ?? 0);
    case 'SUM':
      return nums.reduce((a, b) => a + b, 0);
    case 'AVG':
    case 'AVERAGE':
      return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
    case 'IF':
      return toNum(args[0]) !== 0 ? (args[1] ?? '') : (args[2] ?? '');
    case 'CONCAT':
      return args.map((a) => String(a ?? '')).join('');
    case 'LEN':
      return String(args[0] ?? '').length;
    case 'UPPER':
      return String(args[0] ?? '').toUpperCase();
    case 'LOWER':
      return String(args[0] ?? '').toLowerCase();
    default:
      return nums[0] ?? 0;
  }
}
