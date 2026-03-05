/**
 * SoftN Helpers Tests
 *
 * Tests for built-in helper functions available in templates.
 */

import { describe, it, expect } from 'vitest';
import {
  filter,
  sort,
  find,
  first,
  last,
  count,
  some,
  every,
  map,
  groupBy,
  unique,
  pluck,
  truncate,
  capitalize,
  titleCase,
  formatNumber,
  currency,
  percent,
  formatDate,
  timeAgo,
  get,
  isEmpty,
  isNotEmpty,
  data,
  field,
  json,
  when,
  maybe,
} from '../src/runtime/helpers';

// Mock XDB records for testing
const createMockRecords = () => [
  {
    id: '1',
    collection: 'todos',
    data: { title: 'Task 1', completed: false, priority: 'high' },
    created_at: '2024-01-01',
    updated_at: '2024-01-01',
    deleted: false,
  },
  {
    id: '2',
    collection: 'todos',
    data: { title: 'Task 2', completed: true, priority: 'low' },
    created_at: '2024-01-02',
    updated_at: '2024-01-02',
    deleted: false,
  },
  {
    id: '3',
    collection: 'todos',
    data: { title: 'Task 3', completed: false, priority: 'medium' },
    created_at: '2024-01-03',
    updated_at: '2024-01-03',
    deleted: false,
  },
];

describe('Collection Helpers', () => {
  describe('filter', () => {
    it('should filter with a function predicate', () => {
      const items = [1, 2, 3, 4, 5];
      const result = filter(items, (x) => x > 2);
      expect(result).toEqual([3, 4, 5]);
    });

    it('should filter XDB records with object match', () => {
      const records = createMockRecords();
      const result = filter(records, { completed: false });
      expect(result).toHaveLength(2);
    });

    it('should return empty array for non-array input', () => {
      expect(filter(null as unknown as unknown[], () => true)).toEqual([]);
      expect(filter(undefined as unknown as unknown[], () => true)).toEqual([]);
    });
  });

  describe('sort', () => {
    it('should sort by key ascending', () => {
      const records = createMockRecords();
      const result = sort(records, 'title');
      expect(result[0].data.title).toBe('Task 1');
      expect(result[2].data.title).toBe('Task 3');
    });

    it('should sort by key descending', () => {
      const records = createMockRecords();
      const result = sort(records, 'title', 'desc');
      expect(result[0].data.title).toBe('Task 3');
      expect(result[2].data.title).toBe('Task 1');
    });

    it('should sort with custom comparator', () => {
      const items = [{ n: 3 }, { n: 1 }, { n: 2 }];
      const result = sort(items, (a, b) => a.n - b.n);
      expect(result.map((x) => x.n)).toEqual([1, 2, 3]);
    });
  });

  describe('find', () => {
    it('should find with function predicate', () => {
      const items = [1, 2, 3, 4, 5];
      const result = find(items, (x) => x === 3);
      expect(result).toBe(3);
    });

    it('should find XDB record by object match', () => {
      const records = createMockRecords();
      const result = find(records, { id: '2' });
      expect(result?.data.title).toBe('Task 2');
    });

    it('should return undefined if not found', () => {
      const items = [1, 2, 3];
      expect(find(items, (x) => x === 10)).toBeUndefined();
    });
  });

  describe('first', () => {
    it('should return first item', () => {
      const items = [1, 2, 3];
      expect(first(items)).toBe(1);
    });

    it('should return first n items', () => {
      const items = [1, 2, 3, 4, 5];
      expect(first(items, 3)).toEqual([1, 2, 3]);
    });

    it('should return undefined for empty array', () => {
      expect(first([])).toBeUndefined();
    });
  });

  describe('last', () => {
    it('should return last item', () => {
      const items = [1, 2, 3];
      expect(last(items)).toBe(3);
    });

    it('should return last n items', () => {
      const items = [1, 2, 3, 4, 5];
      expect(last(items, 3)).toEqual([3, 4, 5]);
    });
  });

  describe('count', () => {
    it('should return array length', () => {
      const items = [1, 2, 3, 4, 5];
      expect(count(items)).toBe(5);
    });

    it('should count filtered items', () => {
      const items = [1, 2, 3, 4, 5];
      expect(count(items, (x) => x > 2)).toBe(3);
    });

    it('should return 0 for non-array', () => {
      expect(count(null as unknown as unknown[])).toBe(0);
    });
  });

  describe('some', () => {
    it('should return true if any item matches', () => {
      const items = [1, 2, 3, 4, 5];
      expect(some(items, (x) => x > 4)).toBe(true);
    });

    it('should return false if no item matches', () => {
      const items = [1, 2, 3, 4, 5];
      expect(some(items, (x) => x > 10)).toBe(false);
    });
  });

  describe('every', () => {
    it('should return true if all items match', () => {
      const items = [2, 4, 6, 8];
      expect(every(items, (x) => x % 2 === 0)).toBe(true);
    });

    it('should return false if any item does not match', () => {
      const items = [2, 4, 5, 8];
      expect(every(items, (x) => x % 2 === 0)).toBe(false);
    });
  });

  describe('map', () => {
    it('should map items', () => {
      const items = [1, 2, 3];
      const result = map(items, (x) => x * 2);
      expect(result).toEqual([2, 4, 6]);
    });
  });

  describe('groupBy', () => {
    it('should group by key', () => {
      const records = createMockRecords();
      const result = groupBy(records, 'priority');
      expect(Object.keys(result)).toHaveLength(3);
      expect(result['high']).toHaveLength(1);
      expect(result['low']).toHaveLength(1);
      expect(result['medium']).toHaveLength(1);
    });

    it('should group with getter function', () => {
      const records = createMockRecords();
      const result = groupBy(records, (r) => (r.data.completed ? 'done' : 'pending'));
      expect(result['done']).toHaveLength(1);
      expect(result['pending']).toHaveLength(2);
    });
  });

  describe('unique', () => {
    it('should return unique items', () => {
      const items = [1, 2, 2, 3, 3, 3];
      expect(unique(items)).toEqual([1, 2, 3]);
    });

    it('should return unique by key', () => {
      const records = createMockRecords();
      const result = unique(records, 'completed');
      expect(result).toHaveLength(2);
    });
  });

  describe('pluck', () => {
    it('should pluck values from XDB records', () => {
      const records = createMockRecords();
      const result = pluck(records, 'title');
      expect(result).toEqual(['Task 1', 'Task 2', 'Task 3']);
    });
  });
});

describe('String Helpers', () => {
  describe('truncate', () => {
    it('should truncate long strings', () => {
      const result = truncate('This is a very long string', 10);
      expect(result).toBe('This is...');
    });

    it('should not truncate short strings', () => {
      const result = truncate('Short', 10);
      expect(result).toBe('Short');
    });

    it('should handle custom suffix', () => {
      const result = truncate('This is a very long string', 10, ' [more]');
      expect(result).toBe('Thi [more]');
    });
  });

  describe('capitalize', () => {
    it('should capitalize first letter', () => {
      expect(capitalize('hello')).toBe('Hello');
      expect(capitalize('HELLO')).toBe('HELLO');
    });
  });

  describe('titleCase', () => {
    it('should convert to title case', () => {
      expect(titleCase('hello world')).toBe('Hello World');
    });
  });
});

describe('Number Helpers', () => {
  describe('formatNumber', () => {
    it('should format numbers', () => {
      const result = formatNumber(1234567.89);
      expect(result).toContain('1');
      expect(result).toContain('234');
    });
  });

  describe('currency', () => {
    it('should format as currency', () => {
      const result = currency(99.99, 'USD');
      expect(result).toContain('99.99');
    });
  });

  describe('percent', () => {
    it('should format as percentage', () => {
      const result = percent(0.75);
      expect(result).toContain('75');
      expect(result).toContain('%');
    });
  });
});

describe('Date Helpers', () => {
  describe('formatDate', () => {
    it('should format dates', () => {
      const result = formatDate('2024-01-15');
      expect(result).toBeTruthy();
    });

    it('should return empty string for invalid dates', () => {
      expect(formatDate('')).toBe('');
      expect(formatDate('invalid')).toBe('');
    });
  });

  describe('timeAgo', () => {
    it('should return relative time', () => {
      const recentDate = new Date(Date.now() - 1000 * 60 * 5).toISOString(); // 5 minutes ago
      const result = timeAgo(recentDate);
      expect(result).toBeTruthy();
    });
  });
});

describe('Object Helpers', () => {
  describe('get', () => {
    it('should get nested values', () => {
      const obj = { a: { b: { c: 'value' } } };
      expect(get(obj, 'a.b.c')).toBe('value');
    });

    it('should return default for missing paths', () => {
      const obj = { a: 1 };
      expect(get(obj, 'a.b.c', 'default')).toBe('default');
    });
  });

  describe('isEmpty', () => {
    it('should detect empty values', () => {
      expect(isEmpty(null)).toBe(true);
      expect(isEmpty(undefined)).toBe(true);
      expect(isEmpty('')).toBe(true);
      expect(isEmpty([])).toBe(true);
      expect(isEmpty({})).toBe(true);
    });

    it('should detect non-empty values', () => {
      expect(isEmpty('text')).toBe(false);
      expect(isEmpty([1])).toBe(false);
      expect(isEmpty({ a: 1 })).toBe(false);
    });
  });

  describe('isNotEmpty', () => {
    it('should be inverse of isEmpty', () => {
      expect(isNotEmpty('text')).toBe(true);
      expect(isNotEmpty('')).toBe(false);
    });
  });
});

describe('XDB Helpers', () => {
  describe('data', () => {
    it('should extract data from XDB record', () => {
      const record = createMockRecords()[0];
      const result = data(record);
      expect(result.title).toBe('Task 1');
    });

    it('should return object as-is for non-XDB objects', () => {
      const obj = { title: 'Test' };
      const result = data(obj);
      expect(result.title).toBe('Test');
    });
  });

  describe('field', () => {
    it('should get field from XDB record', () => {
      const record = createMockRecords()[0];
      expect(field(record, 'title')).toBe('Task 1');
    });
  });
});

describe('JSON Helpers', () => {
  describe('json', () => {
    it('should stringify objects', () => {
      expect(json({ a: 1 })).toBe('{"a":1}');
    });

    it('should pretty print when requested', () => {
      const result = json({ a: 1 }, true);
      expect(result).toContain('\n');
    });
  });
});

describe('Conditional Helpers', () => {
  describe('when', () => {
    it('should return trueValue when condition is true', () => {
      expect(when(true, 'yes', 'no')).toBe('yes');
    });

    it('should return falseValue when condition is false', () => {
      expect(when(false, 'yes', 'no')).toBe('no');
    });
  });

  describe('maybe', () => {
    it('should return value when condition is true', () => {
      expect(maybe(true, 'badge')).toBe('badge');
    });

    it('should return empty string when condition is false', () => {
      expect(maybe(false, 'badge')).toBe('');
    });
  });
});
