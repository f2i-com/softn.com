/**
 * The order a validated plan's work runs in on one backend: its execution
 * items, and the use counts that decide when each item's result is freed.
 *
 * Three things make it shorter than the plan's node list, none of which
 * changes a computed value:
 *
 * - Dead nodes (no output depends on them) are left out on every backend.
 * - In a prepared session, a node that depends on nothing that changes
 *   between steps (a `full`, and operations on constants) is `static`: the
 *   session computes it once and keeps it.
 * - A backend may compute several nodes in one item (`impl.fusion(plan,
 *   context)`): Adam's three updates of a parameter (graph.mjs adamGroups),
 *   and whatever else it can compute with each element's arithmetic
 *   unchanged. Such an item runs where its last input exists, reads only
 *   nodes outside it, and produces the handles of its `exposed` nodes; its
 *   other nodes (`elided`) never exist as tensors.
 *
 * Use counts are recounted over the items, so a node an item elides simply
 * has no uses and what it would have read is kept alive by the items that
 * read it instead.
 */
const cache = new WeakMap();

/** Every node an output depends on, following references through reshapes. */
export function liveNodes(plan) {
  const live = new Uint8Array(plan.nodes.length), stack = plan.outputs.map(o => o.id);
  while (stack.length) {
    const id = stack.pop();
    if (live[id]) continue;
    live[id] = 1;
    for (const r of plan.nodes[id].refs) stack.push(r);
  }
  return live;
}

/** Nodes whose value is the same every step of a session (see above). */
function staticNodes(plan, live) {
  const stat = new Uint8Array(plan.nodes.length), root = plan.root;
  for (const n of plan.nodes) {
    if (!live[n.id]) continue;
    if (n.op === 'input') { stat[n.id] = n.data !== undefined && !n.fed && n.carry === undefined ? 1 : 0; continue; }
    // Step-dependent operations are never static.
    if (n.op === 'uniform' || n.op.startsWith('adam') || n.op === 'sgd_update' || n.op === 'momentum_update') continue;
    stat[n.id] = n.refs.every(r => stat[root[r]] === 1 && stat[r] === 1) ? 1 : 0;
  }
  return stat;
}

/**
 * `{items, uses}` for `plan` on `impl` (cached per plan and backend).
 * `session`: the plan is a prepared session's (static nodes are marked).
 * Each item: `{kind: 'node', id, node}` or a backend's group `{kind, id,
 * refs, exposed, ...}`; every item has `refs` (the node ids it reads),
 * `exposed` (the node ids it produces) and, in a session, `static`.
 */
export function execution(plan, impl, {session = false} = {}) {
  const key = `${impl.name}|${session}|${impl.fusionKey?.() ?? ''}`;
  let byImpl = cache.get(plan);
  if (!byImpl) cache.set(plan, byImpl = new Map());
  let exec = byImpl.get(key);
  if (exec) return exec;
  const nodes = plan.nodes, root = plan.root, live = liveNodes(plan);
  const groups = impl.fusion?.(plan, {live, session}) ?? {groups: [], elided: new Set()};
  const byAnchor = new Map(groups.groups.map(g => [g.id, g]));
  const stat = session ? staticNodes(plan, live) : null;
  const items = [];
  for (const n of nodes) {
    if (n.alias || !live[n.id]) continue;
    const g = byAnchor.get(n.id);
    if (g) { items.push(g); continue; }
    if (groups.elided.has(n.id)) continue;
    items.push({kind: 'node', id: n.id, node: n, refs: n.refs, exposed: [n.id], static: stat ? stat[n.id] === 1 : false});
  }
  const uses = Array(nodes.length).fill(0);
  for (const item of items) for (const r of item.refs) uses[root[r]]++;
  for (const o of plan.outputs) uses[root[o.id]]++;
  exec = {items, uses};
  byImpl.set(key, exec);
  return exec;
}
