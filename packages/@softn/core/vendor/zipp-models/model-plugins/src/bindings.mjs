import {check, fields, integer, shapeSize, sameShape} from './common.mjs';
import {RESIDENT as RESIDENT_NAMES, residentFormat} from './gguf.mjs';
const OPS = new Set(['input', 'full', 'add', 'sub', 'mul', 'div', 'relu', 'positive', 'gelu', 'exp', 'log',
  'neg', 'tanh', 'sigmoid', 'sqrt', 'matmul', 'matmul_fixed', 'transpose', 'reshape', 'permute',
  'mean', 'sum', 'softmax', 'log_softmax']);

/** Resolve only data bindings. The returned object is still passed through
 * the existing ZIPP graph validator by runtime.execute(). No validation bypass.
 */
export async function bindGraph(template, weights, limits, {feed = {}, quantize = null} = {}) {
  // `quantize` is gpu-lab's `quantizeWeight`, handed in rather than imported.
  // This package does not depend on the compute runtime -- the caller supplies
  // that too -- and the alternative is a second copy of a quantisation that has
  // to stay bit-identical to the one four backends implement. One authority,
  // passed in, is the same arrangement `runtime` already has.
  const quantized = new Map();
  const quantizeOnce = async (tensor, n, k) => {
    if (quantized.has(tensor)) return quantized.get(tensor);
    const format = residentFormat(weights, tensor);
    // Quantized in the file or not, what is quantized is the values, so the
    // blocks are read as blocks where that is possible and decoded where it is
    // not. Either way the result is what those values quantize to.
    const result = format
      ? await weights.blocks(tensor).then(({dtype, bytes}) => quantize(bytes, n, k, dtype))
      : quantize(await weights.tensor(tensor), n, k, 'f32');
    quantized.set(tensor, result);
    return result;
  };
  // `stage` is optional and says which layers this graph covers, for a graph
  // that is part of a model rather than all of it.
  fields(template, ['version', 'graph', 'bindings', 'stage', 'manifest'],
    ['version', 'graph', 'bindings']);
  check(template.version === 1, 'VERSION', 'Unsupported model binding protocol');
  const graph = template.graph;
  fields(graph, ['version', 'nodes', 'outputs'], ['version', 'nodes', 'outputs']);
  check(graph.version === 2, 'VERSION', 'Expected ZIPP Graph v2');
  check(Array.isArray(graph.nodes) && graph.nodes.length > 0 && graph.nodes.length <= limits.maxNodes, 'LIMIT', 'Graph node budget exceeded');
  check(Array.isArray(template.bindings) && template.bindings.length <= graph.nodes.length, 'LIMIT', 'Invalid binding count');
  check(Array.isArray(graph.outputs) && graph.outputs.length === 1, 'FORMAT', 'Model graph must expose exactly one output');
  fields(graph.outputs[0], ['name', 'id'], ['name', 'id']);
  // Logits, or the residual stream for whoever runs the rest of the model.
  check(graph.outputs[0].name === 'logits' || graph.outputs[0].name === 'hidden', 'FORMAT',
    'Model output must be named logits, or hidden if it stops before the last layer');
  integer(graph.outputs[0].id, 0, graph.nodes.length - 1, 'Output node id');
  const byNode = new Map();
  for (const binding of template.bindings) {
    check(binding && typeof binding === 'object', 'FORMAT', 'Invalid binding');
    integer(binding.node, 0, graph.nodes.length - 1, 'Binding node');
    check(!byNode.has(binding.node), 'FORMAT', 'Duplicate input binding'); byNode.set(binding.node, binding);
  }
  let inputBytes = 0;
  const nodes = graph.nodes.map((raw, id) => {
    check(raw && typeof raw === 'object' && raw.id === id && OPS.has(raw.op), 'GRAPH', 'Unknown op or nonconsecutive graph id');
    const node = {...raw};
    if (Object.hasOwn(node, 'shape')) shapeSize(node.shape, limits);
    if (node.op === 'input') {
      fields(node, ['id', 'op', 'shape', 'data', 'dtype'], ['id', 'op', 'shape']);
      check(!Object.hasOwn(node, 'dtype'), 'FORMAT', 'A dtype comes from a blocks or fixed binding, not from the template');
      // A matrix, blocks or fixed binding charges what it actually costs,
      // below; everything else is four bytes a value.
      if (!['matrix', 'blocks', 'fixed'].includes(byNode.get(id)?.kind)) {
        inputBytes += shapeSize(node.shape, limits) * 4;
        check(inputBytes <= limits.maxBoundInputBytes, 'LIMIT', 'Bound graph inputs exceed budget');
      }
      check(byNode.has(id) !== Object.hasOwn(node, 'data'), 'FORMAT', 'Input must have exactly one data source');
      if (Object.hasOwn(node, 'data')) check(Array.isArray(node.data) && node.data.length === shapeSize(node.shape, limits), 'SHAPE', 'Literal input size mismatch');
    } else check(!byNode.has(id), 'FORMAT', 'Only input nodes may bind assets');
    return node;
  });
  // Preflight every binding before a potentially large weight read/allocation.
  for (const [id, b] of byNode) {
    const node = nodes[id]; check(node.op === 'input', 'FORMAT', 'Binding target must be an input');
    if (b.kind === 'tensor') {
      fields(b, ['node', 'kind', 'tensor', 'transpose'], ['node', 'kind', 'tensor']);
      const shape = weights.info(b.tensor).shape;
      // A checkpoint stores a linear layer as [out, in]; this graph protocol
      // multiplies [tokens, in] by [in, out]. Transposing on the way in lets a
      // plugin read the checkpoint's own tensors instead of requiring a
      // rewritten copy on disk. It is a relabelling of a matrix, not a licence
      // to reinterpret a tensor: rank two only, and the shape must still match.
      if (Object.hasOwn(b, 'transpose')) {
        check(b.transpose === true, 'FORMAT', 'transpose is true when present');
        check(shape.length === 2, 'SHAPE', `Only a matrix can be transposed: ${b.tensor}`);
      }
      check(sameShape(b.transpose ? [shape[1], shape[0]] : shape, node.shape), 'SHAPE', `Weight shape mismatch: ${b.tensor}`);
    } else if (b.kind === 'matrix') {
      // A weight matrix in the checkpoint's own [out, in] layout, kept as
      // blocks where a backend can decode them and expanded where one cannot.
      // The graph multiplies it transposed either way, so which happened does
      // not change the graph -- only what the device holds.
      fields(b, ['node', 'kind', 'tensor'], ['node', 'kind', 'tensor']);
      const info = weights.info(b.tensor);
      check(info.shape.length === 2, 'SHAPE', `A weight matrix is rank two: ${b.tensor}`);
      check(sameShape(info.shape, node.shape), 'SHAPE',
        `${b.tensor} is ${JSON.stringify(info.shape)}, not ${JSON.stringify(node.shape)}`);
      const format = residentFormat(weights, b.tensor);
      inputBytes += format
        ? (shapeSize(node.shape, limits) / format.block) * format.bytes
        : shapeSize(node.shape, limits) * 4;
      check(inputBytes <= limits.maxBoundInputBytes, 'LIMIT', 'Bound graph inputs exceed budget');
    } else if (b.kind === 'blocks') {
      // The weight stays in the file's own format and the backend decodes it
      // inside the matmul. That is only possible in the layout the blocks are
      // written in -- they run along the last axis -- so there is no transpose
      // here and the graph's matmul must carry `transposed: true`.
      fields(b, ['node', 'kind', 'tensor'], ['node', 'kind', 'tensor']);
      const info = weights.info(b.tensor);
      const format = residentFormat(weights, b.tensor);
      check(format !== undefined && format !== null, 'DTYPE',
        `${b.tensor} is ${info.dtype}; this build keeps ${Object.values(RESIDENT_NAMES).map(f => f.dtype).join(', ')} resident and decodes the rest, so bind it as a tensor`);
      check(info.shape.length === 2, 'SHAPE', `A quantized weight is a matrix: ${b.tensor}`);
      check(sameShape(info.shape, node.shape), 'SHAPE',
        `Blocks bind in the layout they are stored in; ${b.tensor} is ${JSON.stringify(info.shape)}`);
      // What the device actually holds, which is the point of binding this way.
      inputBytes += (shapeSize(node.shape, limits) / format.block) * format.bytes;
      check(inputBytes <= limits.maxBoundInputBytes, 'LIMIT', 'Bound graph inputs exceed budget');
    } else if (b.kind === 'fixed' || b.kind === 'fixed_scales') {
      // `matmul_fixed`'s bind-time form: the weight quantized to int16 once,
      // here, instead of on every step. Two bindings over one tensor, because
      // the quants and their per-row scales are two graph inputs -- the weight
      // as `b` and the scales as `c`. They are quantized together and cached,
      // so naming the tensor twice reads and quantizes it once.
      fields(b, ['node', 'kind', 'tensor'], ['node', 'kind', 'tensor']);
      check(typeof quantize === 'function', 'HOST',
        'A fixed binding needs the quantizer: pass {quantize}, which is quantizeWeight from gpu-lab, to bindGraph');
      const info = weights.info(b.tensor);
      check(info.shape.length === 2, 'SHAPE', `A weight matrix is rank two: ${b.tensor}`);
      if (b.kind === 'fixed') {
        // Stored layout, like `blocks`: the quants run along K in the order the
        // file has them, and the graph's matmul_fixed carries `transposed`.
        check(sameShape(info.shape, node.shape), 'SHAPE',
          `${b.tensor} is ${JSON.stringify(info.shape)}, not ${JSON.stringify(node.shape)}`);
        // Two bytes a value, which is the whole trade and is charged as such:
        // 3.56 times what the same weight costs as Q4_K blocks.
        inputBytes += shapeSize(node.shape, limits) * 2;
        check(inputBytes <= limits.maxBoundInputBytes, 'LIMIT', 'Bound graph inputs exceed budget');
      } else {
        check(sameShape(node.shape, [info.shape[0]]), 'SHAPE',
          `${b.tensor} has ${info.shape[0]} rows, so its scales are [${info.shape[0]}], not ${JSON.stringify(node.shape)}`);
      }
    } else if (b.kind === 'rows') {
      fields(b, ['node', 'kind', 'tensor', 'indices'], ['node', 'kind', 'tensor', 'indices']);
      const info = weights.info(b.tensor);
      check(info.shape.length === 2 && Array.isArray(b.indices) && b.indices.length > 0 && b.indices.length <= limits.maxContext,
        'SHAPE', 'Row gathering requires a bounded index list and matrix');
      for (const index of b.indices) integer(index, 0, info.shape[0] - 1, 'Embedding index');
      check(sameShape(node.shape, [b.indices.length, info.shape[1]]), 'SHAPE', 'Embedding shape mismatch');
    } else if (b.kind === 'feed') {
      // Data the caller supplies rather than the checkpoint: the residual
      // stream a previous stage produced. Checked on arrival for shape and
      // finiteness, because it comes from somewhere else and may have crossed
      // a worker, a process or a network on the way here.
      fields(b, ['node', 'kind', 'name'], ['node', 'kind', 'name']);
      check(typeof b.name === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(b.name),
        'FORMAT', 'Invalid fed input name');
      const given = feed[b.name];
      check(given instanceof Float32Array, 'SHAPE',
        `This graph begins mid-model and needs {${b.name}}: the output of the stage before it`);
      // The node's shape was already bounded above; this is just its product.
      const wanted = node.shape.reduce((a, n) => a * n, 1);
      check(given.length === wanted, 'SHAPE',
        `${b.name} is ${wanted} values for this stage, got ${given.length}`);
      for (let i = 0; i < given.length; i++) {
        check(Number.isFinite(given[i]), 'NUMBER', `Non-finite value in ${b.name}`);
      }
    } else if (b.kind === 'causal') {
      fields(b, ['node', 'kind', 'length', 'window'], ['node', 'kind', 'length']);
      integer(b.length, 1, limits.maxContext, 'Attention length');
      if (b.window !== undefined) integer(b.window, 1, limits.maxContext, 'Local attention window');
      check(sameShape(node.shape, [b.length, b.length]), 'SHAPE', 'Attention mask shape mismatch');
    } else check(false, 'FORMAT', 'Unknown model asset binding');
  }
  for (const [id, b] of byNode) {
    if (b.kind === 'tensor') {
      const data = await weights.tensor(b.tensor);
      if (!b.transpose) nodes[id].data = data;
      else {
        // A fresh array: the store's copy is shared with every other binding.
        const [rows, columns] = weights.info(b.tensor).shape, out = new Float32Array(data.length);
        for (let row = 0; row < rows; row++) {
          for (let column = 0; column < columns; column++) out[column * rows + row] = data[row * columns + column];
        }
        nodes[id].data = out;
      }
    }
    else if (b.kind === 'blocks') {
      const {dtype, bytes} = await weights.blocks(b.tensor);
      nodes[id].dtype = dtype;
      nodes[id].data = bytes;
    }
    else if (b.kind === 'matrix') {
      if (residentFormat(weights, b.tensor)) {
        const {dtype, bytes} = await weights.blocks(b.tensor);
        nodes[id].dtype = dtype;
        nodes[id].data = bytes;
      } else {
        // Decoded, but still in the stored layout: the matmul transposes.
        nodes[id].data = await weights.tensor(b.tensor);
      }
    }
    else if (b.kind === 'fixed' || b.kind === 'fixed_scales') {
      const [n, k] = weights.info(b.tensor).shape;
      const {quants, scales} = await quantizeOnce(b.tensor, n, k);
      if (b.kind === 'fixed') { nodes[id].dtype = 'i16'; nodes[id].data = quants; }
      else nodes[id].data = scales;
    }
    else if (b.kind === 'feed') {
      nodes[id].data = feed[b.name];
    }
    else if (b.kind === 'rows') {
      const info = weights.info(b.tensor), width = info.shape[1];
      // A store that can read rows does; otherwise the whole tensor is decoded
      // once and sliced, which is what a Safetensors file wants anyway.
      const gathered = typeof weights.rows === 'function' ? await weights.rows(b.tensor, b.indices) : null;
      if (gathered) { nodes[id].data = gathered; }
      else {
        const data = await weights.tensor(b.tensor);
        const rows = new Float32Array(b.indices.length * width);
        b.indices.forEach((index, i) => rows.set(data.subarray(index * width, (index + 1) * width), i * width));
        nodes[id].data = rows;
      }
    } else {
      const data = new Float32Array(b.length * b.length);
      for (let row = 0; row < b.length; row++) for (let col = 0; col < b.length; col++) {
        // Graph v2 requires finite values. -1e9 is deliberate, not JSON -Infinity.
        if (col > row || (b.window !== undefined && col <= row - b.window)) data[row * b.length + col] = -1e9;
      }
      nodes[id].data = data;
    }
  }
  return {version: 2, nodes, outputs: graph.outputs.map(o => ({...o}))};
}
