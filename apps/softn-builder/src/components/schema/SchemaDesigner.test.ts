import { expect, it } from 'vitest';
import type { Node } from '@xyflow/react';
import { nextEntityPosition } from './SchemaDesigner';

function node(id: string, x: number, y: number, width = 220, height = 160): Node {
  return { id, position: { x, y }, measured: { width, height }, data: {} };
}

it('places a new collection beyond the selected measured node, not over its center', () => {
  const position = nextEntityPosition([node('tasks', 100, 100, 310, 260)], 'tasks', { x: 250, y: 250 });
  expect(position).toEqual({ x: 490, y: 100 });
});

it('skips existing neighbours and preserves all authored positions', () => {
  const nodes = [node('tasks', 100, 100), node('clients', 400, 100, 280), node('notes', 760, 100)];
  const before = structuredClone(nodes);
  const position = nextEntityPosition(nodes, 'tasks', { x: 100, y: 100 });
  expect(position.x).toBeGreaterThanOrEqual(1060);
  expect(position.y).toBe(100);
  expect(nodes).toEqual(before);
});

it('chooses the nearest collection in a panned viewport when nothing is selected', () => {
  expect(nextEntityPosition([node('far', 100, 100), node('near', 1200, -200)], null, { x: 1300, y: -150 })).toEqual({ x: 1500, y: -200 });
  expect(nextEntityPosition([], null, { x: 1400, y: -200 })).toEqual({ x: 1290, y: -270 });
});
