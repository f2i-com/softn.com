import {check, fields, integer, shapeSize, sameShape} from './common.mjs';
import {residentFormat} from './gguf.mjs';

/** The block format a tensor can stay in on a device, or null. */
const residentDtype = (weights, name) =>
  typeof weights.residentDtype === 'function' ? weights.residentDtype(name) : null;

/**
 * Cached decoding: one prepared graph, run once per token.
 *
 * The eager path in `bindings.mjs` rebuilds and resubmits the whole model for
 * every token, re-uploading every weight and recomputing the whole context. It
 * is the correctness oracle and stays exactly as it was. This is the other
 * shape of the same model, and it is what makes a real checkpoint usable:
 *
 *   * `runtime.prepare` validates the plan once and uploads every static input
 *     once, so weights stop crossing the boundary per token. For a 50,257-entry
 *     vocabulary that alone is 12.9 MiB of upload removed from every step.
 *   * Key and value caches are graph inputs marked `carry`, so the device keeps
 *     them between runs and the host never sees them.
 *   * Each step attends over the cache instead of recomputing the context, so a
 *     token costs what one position costs rather than what the prompt costs.
 *
 * The protocol has no scatter, so a plugin writes into its cache with a one-hot
 * column the host feeds per step: `cache * (1 - write) + write @ new`. That is
 * ordinary arithmetic on tensors the backend already knows how to multiply.
 *
 * The host fills four kinds of per-step input, none of which require knowing
 * what the model is: a gathered embedding row, an additive mask for the
 * positions written so far, that one-hot write column, and -- for a rotary
 * model -- the cosines and sines of the current position. Those last are
 * trigonometry over a position and a dimension, never over the data, so they
 * belong on this side of the boundary rather than in a kernel.
 */
// `hidden` is the seam between two stages of one model: a stage that does not
// start at layer 0 is handed the residual stream instead of looking a token up.
// `select` picks the one row of a chunk that is projected onto the vocabulary.
const STEP_SLOTS = new Set(['rows', 'mask', 'write', 'rope', 'hidden', 'select']);
const ROPE_PARTS = new Set(['cos', 'sin', 'matrix']);
const INDEXES = new Set(['token', 'position']);
/** Graph v2 wants finite float32; this is the mask sentinel, not -Infinity. */
const MASKED = -1e9;

export function validateDecodeTemplate(template, limits) {
  // `stage` and `hidden_size` are optional and describe a graph that covers
  // part of a model rather than all of it: which layers it runs, and how wide
  // the residual stream it hands on is.
  fields(template, ['version', 'kind', 'context', 'graph', 'bindings', 'stage',
    'hidden_size', 'manifest'], ['version', 'kind', 'context', 'graph', 'bindings']);
  check(template.version === 1 && template.kind === 'decode', 'VERSION', 'Unsupported decode template');
  if (template.stage !== undefined) {
    fields(template.stage, ['first_layer', 'last_layer'], ['first_layer', 'last_layer']);
    integer(template.stage.first_layer, 0, 4095, 'Stage first layer');
    integer(template.stage.last_layer, template.stage.first_layer, 4095, 'Stage last layer');
  }
  if (template.hidden_size !== undefined) integer(template.hidden_size, 1, 1 << 20, 'Hidden size');
  if (template.manifest !== undefined) {
    validateStageManifest(template.manifest);
    // Which weights a stage runs is the host's to say. A plugin is handed a
    // configuration and never the file, so a digest from it would be a claim
    // about something it has not seen.
    check(template.manifest.checkpoint_digest === undefined, 'FORMAT',
      'A plugin cannot say which weights it will run; the host does, with prepareDecode({checkpoint})');
  }
  const graph = template.graph;
  fields(graph, ['version', 'nodes', 'outputs'], ['version', 'nodes', 'outputs']);
  check(graph.version === 2, 'VERSION', 'Expected ZIPP Graph v2');
  check(Array.isArray(graph.nodes) && graph.nodes.length > 0 && graph.nodes.length <= limits.maxNodes,
    'LIMIT', 'Decode graph node budget exceeded');
  integer(template.context, 1, limits.maxContext, 'Decode context');
  check(Array.isArray(graph.outputs) && graph.outputs.length >= 1, 'FORMAT', 'Decode graph needs outputs');
  const outputs = new Map();
  for (const output of graph.outputs) {
    fields(output, ['name', 'id'], ['name', 'id']);
    check(typeof output.name === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(output.name), 'FORMAT', 'Invalid output name');
    check(!outputs.has(output.name), 'FORMAT', 'Duplicate output name');
    integer(output.id, 0, graph.nodes.length - 1, 'Output node id');
    outputs.set(output.name, output.id);
  }
  // Logits, or the residual stream for whoever runs the rest of the model. A
  // stage that ends mid-model has no vocabulary to project onto, and demanding
  // logits of it would mean every stage carrying the output head.
  check(outputs.has('logits') || outputs.has('hidden'), 'FORMAT',
    'A decode graph must expose logits, or hidden if it stops before the last layer');
  check(!(outputs.has('logits') && outputs.has('hidden')), 'FORMAT',
    'A decode graph ends the model or hands it on, not both');
  check(Array.isArray(template.bindings) && template.bindings.length <= graph.nodes.length,
    'LIMIT', 'Invalid decode binding count');
  return {graph, outputs};
}

/**
 * Resolve a decode template into a program `runtime.prepare` accepts, plus the
 * per-step plan the caller feeds it. Weight reads happen once, here.
 *
 * `checkpoint` is the sha256 of the weights this plan is prepared from, as the
 * host that opened them knows it, and becomes the stage manifest's
 * `checkpoint_digest`. A host whose stages hand hidden states to one another
 * should pass it: the configuration digest a plugin can compute says which
 * architecture a stage runs, and only this says which model.
 */
export async function prepareDecode(template, weights, limits, {quantize = null, checkpoint} = {}) {
  const {graph, outputs} = validateDecodeTemplate(template, limits);
  if (checkpoint !== undefined) {
    check(typeof checkpoint === 'string' && /^[0-9a-f]{64}$/.test(checkpoint), 'FORMAT',
      'A checkpoint digest is the sha256 of the weights, in lowercase hex');
    check(template.manifest !== undefined, 'FORMAT',
      'Only a stage has a manifest to carry a checkpoint digest');
  }
  const byNode = new Map();
  for (const binding of template.bindings) {
    check(binding && typeof binding === 'object', 'FORMAT', 'Invalid binding');
    integer(binding.node, 0, graph.nodes.length - 1, 'Binding node');
    check(!byNode.has(binding.node), 'FORMAT', 'Duplicate input binding');
    byNode.set(binding.node, binding);
  }
  const steps = [], carries = new Map();
  let residentElements = 0;
  // How many tokens a step covers: one for a decode step, more for a chunk of
  // a prompt. Every per-step input says, by its shape, and they must agree.
  const sizes = new Set();
  const nodes = graph.nodes.map((raw, id) => {
    check(raw && typeof raw === 'object' && raw.id === id, 'GRAPH', 'Nonconsecutive graph id');
    const node = {...raw};
    if (node.op !== 'input') {
      check(!byNode.has(id), 'FORMAT', 'Only input nodes may bind assets or step data');
      return node;
    }
    fields(node, ['id', 'op', 'shape', 'carry', 'data'], ['id', 'op', 'shape']);
    const size = shapeSize(node.shape, limits);
    const binding = byNode.get(id);
    // A literal is a constant the graph carries itself -- a rotation matrix, a
    // selector -- and is the one input that needs no binding. Exactly one
    // source, as in the eager path.
    if (Object.hasOwn(node, 'data')) {
      check(!binding, 'FORMAT', 'An input has one data source: a literal or a binding, not both');
      check(Array.isArray(node.data) && node.data.length === size, 'SHAPE', 'Literal input size mismatch');
      check(!Object.hasOwn(node, 'carry'), 'FORMAT', 'A literal is constant, not carried');
      return node;
    }
    check(binding, 'FORMAT', 'Every decode input needs a binding: a weight, a zeroed cache, or step data');
    if (Object.hasOwn(node, 'carry')) {
      check(typeof node.carry === 'string' && outputs.has(node.carry), 'FORMAT',
        `carry names no output: ${String(node.carry)}`);
      check(!carries.has(node.carry), 'FORMAT', 'Two inputs carry the same output');
      carries.set(node.carry, id);
      residentElements += size;
      integer(residentElements, 0, limits.maxTensorElements, 'Resident cache elements');
    }
    return node;
  });
  for (const [id, binding] of byNode) {
    const node = nodes[id];
    check(node.op === 'input', 'FORMAT', 'Binding target must be an input');
    if (binding.kind === 'matrix' || binding.kind === 'blocks') {
      // The checkpoint's own [out, in] matrix, kept in its block format where a
      // backend can read it. Without this a cached decode would hold the model
      // expanded, which is the arithmetic the whole path exists to avoid.
      fields(binding, ['node', 'kind', 'tensor'], ['node', 'kind', 'tensor']);
      const info = weights.info(binding.tensor);
      check(info.shape.length === 2, 'SHAPE', `A weight matrix is rank two: ${binding.tensor}`);
      check(sameShape(info.shape, node.shape), 'SHAPE',
        `${binding.tensor} is ${JSON.stringify(info.shape)}, not ${JSON.stringify(node.shape)}`);
      check(!Object.hasOwn(node, 'carry'), 'FORMAT', 'A weight is static, not carried');
      if (binding.kind === 'blocks') {
        check(residentDtype(weights, binding.tensor) !== null, 'DTYPE',
          `${binding.tensor} is ${info.dtype}; no backend holds that format, so bind it as a matrix`);
      }
    } else if (binding.kind === 'tensor') {
      fields(binding, ['node', 'kind', 'tensor', 'transpose'], ['node', 'kind', 'tensor']);
      const shape = weights.info(binding.tensor).shape;
      if (Object.hasOwn(binding, 'transpose')) {
        check(binding.transpose === true, 'FORMAT', 'transpose is true when present');
        check(shape.length === 2, 'SHAPE', `Only a matrix can be transposed: ${binding.tensor}`);
      }
      check(sameShape(binding.transpose ? [shape[1], shape[0]] : shape, node.shape), 'SHAPE',
        `Weight shape mismatch: ${binding.tensor}`);
      check(!Object.hasOwn(node, 'carry'), 'FORMAT', 'A weight is static, not carried');
    } else if (binding.kind === 'fixed' || binding.kind === 'fixed_scales') {
      // `matmul_fixed`'s bind-time form, in the path where it pays: a decode
      // step is one token, so quantising the weight per step costs more than
      // the product does. Quantized once here instead, and held like any other
      // static weight. Two bindings over one tensor -- the quants as `b` and
      // their per-row scales as `c` -- and the tensor is read once for both.
      fields(binding, ['node', 'kind', 'tensor'], ['node', 'kind', 'tensor']);
      check(typeof quantize === 'function', 'HOST',
        'A fixed binding needs the quantizer: pass {quantize}, which is quantizeWeight from gpu-lab, to prepareDecode');
      const info = weights.info(binding.tensor);
      check(info.shape.length === 2, 'SHAPE', `A weight matrix is rank two: ${binding.tensor}`);
      check(!Object.hasOwn(node, 'carry'), 'FORMAT', 'A weight is static, not carried');
      if (binding.kind === 'fixed') {
        check(sameShape(info.shape, node.shape), 'SHAPE',
          `${binding.tensor} is ${JSON.stringify(info.shape)}, not ${JSON.stringify(node.shape)}`);
      } else {
        check(sameShape(node.shape, [info.shape[0]]), 'SHAPE',
          `${binding.tensor} has ${info.shape[0]} rows, so its scales are [${info.shape[0]}], not ${JSON.stringify(node.shape)}`);
      }
    } else if (binding.kind === 'zeros') {
      fields(binding, ['node', 'kind'], ['node', 'kind']);
      check(Object.hasOwn(node, 'carry'), 'FORMAT', 'A zeroed input is only useful as a carried cache');
    } else if (binding.kind === 'step') {
      fields(binding, ['node', 'kind', 'slot', 'tensor', 'index', 'window', 'part', 'dim', 'base'],
        ['node', 'kind', 'slot']);
      check(STEP_SLOTS.has(binding.slot), 'FORMAT', `Unknown per-step slot: ${String(binding.slot)}`);
      check(!Object.hasOwn(node, 'carry'), 'FORMAT', 'Step data is fed, not carried');
      if (binding.slot === 'rope') {
        fields(binding, ['node', 'kind', 'slot', 'part', 'dim', 'base'],
          ['node', 'kind', 'slot', 'part', 'dim', 'base']);
        check(ROPE_PARTS.has(binding.part), 'FORMAT', 'A rotary table is cos or sin');
        integer(binding.dim, 2, 4096, 'Rotary dimension');
        check(binding.dim % 2 === 0, 'SHAPE', 'Rotary embeddings need an even dimension');
        check(typeof binding.base === 'number' && Number.isFinite(binding.base) && binding.base > 1,
          'FORMAT', 'A rotary base is a finite number above one');
        const d = binding.dim;
        if (binding.part === 'matrix') {
          check(sameShape(node.shape, [d, d]) || (node.shape.length === 3 && sameShape(node.shape.slice(1), [d, d])),
            'SHAPE', 'A rotary matrix is [dim, dim], or [tokens, dim, dim] for a chunk');
          sizes.add(node.shape.length === 3 ? node.shape[0] : 1);
        } else {
          check(node.shape.length === 3 && node.shape[1] === 1 && node.shape[2] === d,
            'SHAPE', 'A rotary table is [1, 1, dim], or [tokens, 1, dim] for a chunk');
          sizes.add(node.shape[0]);
        }
      } else if (binding.slot === 'rows') {
        check(INDEXES.has(binding.index), 'FORMAT', 'A gathered row is indexed by token or position');
        const shape = weights.info(binding.tensor).shape;
        check(shape.length === 2 && node.shape.length === 2 && node.shape[1] === shape[1], 'SHAPE',
          `Gathered row shape mismatch: ${binding.tensor}`);
        sizes.add(node.shape[0]);
      } else if (binding.slot === 'mask') {
        if (binding.window !== undefined) integer(binding.window, 1, template.context, 'Local attention window');
        check(sameShape(node.shape, [1, template.context]) ||
          (node.shape.length === 3 && node.shape[1] === 1 && node.shape[2] === template.context),
          'SHAPE', 'A decode mask is [1, context], or [tokens, 1, context] for a chunk');
        sizes.add(node.shape.length === 3 ? node.shape[0] : 1);
      } else if (binding.slot === 'hidden') {
        check(node.shape.length === 2 && node.shape[0] >= 1 && node.shape[1] >= 1,
          'SHAPE', 'A hidden state is [tokens, hidden_size]');
        sizes.add(node.shape[0]);
      } else if (binding.slot === 'select') {
        check(node.shape.length === 2 && node.shape[0] === 1 && node.shape[1] >= 1,
          'SHAPE', 'A row selector is [1, tokens]');
        sizes.add(node.shape[1]);
      } else {
        check(node.shape.length === 2 && node.shape[0] === template.context && node.shape[1] >= 1,
          'SHAPE', 'A write is [context, 1], or [context, tokens] for a chunk');
        sizes.add(node.shape[1]);
      }
      steps.push({node: id, ...binding,
        ...(binding.slot === 'hidden' ? {width: node.shape[1]} : {})});
    } else check(false, 'FORMAT', `Unknown decode binding: ${String(binding.kind)}`);
  }
  check(steps.some(step => step.slot === 'write') === carries.size > 0, 'FORMAT',
    'A cache that is carried must be written, and a write needs a cache');
  check(sizes.size <= 1, 'SHAPE', `A step's inputs disagree about how many tokens it covers: ${[...sizes].join(', ')}`);
  const tokens = sizes.size ? [...sizes][0] : 1;
  integer(tokens, 1, template.context, 'Tokens a step covers');
  // What the plan will hold, charged before any of it is read or quantized,
  // against the same budget and at the same rates as the eager path in
  // bindings.mjs: blocks cost what the file does, int16 quants two bytes a
  // value, and everything else -- decoded weights, scales, zeroed caches,
  // literals, per-step inputs -- four. A plan too large to hold is refused
  // here rather than after the reads that would have filled it.
  let inputBytes = 0;
  for (const node of nodes) {
    if (node.op !== 'input') continue;
    const binding = byNode.get(node.id), size = shapeSize(node.shape, limits);
    const format = binding?.kind === 'matrix' || binding?.kind === 'blocks'
      ? residentFormat(weights, binding.tensor) : null;
    inputBytes += format ? (size / format.block) * format.bytes
      : binding?.kind === 'fixed' ? size * 2 : size * 4;
    check(inputBytes <= limits.maxBoundInputBytes, 'LIMIT', 'Bound graph inputs exceed budget');
  }
  // Weights and zeroed caches become the plan's static data, uploaded once.
  // A tensor bound as `fixed` is quantized once and kept, so that naming it for
  // both its quants and its scales reads and quantizes it a single time.
  const quantized = new Map();
  for (const [id, binding] of byNode) {
    if (binding.kind === 'fixed' || binding.kind === 'fixed_scales') {
      const [n, k] = weights.info(binding.tensor).shape;
      if (!quantized.has(binding.tensor)) {
        const resident = residentDtype(weights, binding.tensor);
        quantized.set(binding.tensor, resident
          ? await weights.blocks(binding.tensor).then(({dtype, bytes}) => quantize(bytes, n, k, dtype))
          : quantize(await weights.tensor(binding.tensor), n, k, 'f32'));
      }
      const {quants, scales} = quantized.get(binding.tensor);
      if (binding.kind === 'fixed') { nodes[id].dtype = 'i16'; nodes[id].data = quants; }
      else nodes[id].data = scales;
    } else if (binding.kind === 'matrix' || binding.kind === 'blocks') {
      if (residentDtype(weights, binding.tensor) !== null) {
        const {dtype, bytes} = await weights.blocks(binding.tensor);
        nodes[id].dtype = dtype;
        nodes[id].data = bytes;
      } else {
        nodes[id].data = await weights.tensor(binding.tensor);
      }
    } else if (binding.kind === 'tensor') {
      const data = await weights.tensor(binding.tensor);
      if (!binding.transpose) nodes[id].data = data;
      else {
        const [rows, columns] = weights.info(binding.tensor).shape, out = new Float32Array(data.length);
        for (let row = 0; row < rows; row++) {
          for (let column = 0; column < columns; column++) out[column * rows + row] = data[row * columns + column];
        }
        nodes[id].data = out;
      }
    } else if (binding.kind === 'zeros') {
      nodes[id].data = new Float32Array(shapeSize(nodes[id].shape, limits));
    }
  }
  return {
    program: {version: 2, nodes, outputs: graph.outputs.map(o => ({...o}))},
    steps, context: template.context,
    // One for a decode step; more for a chunk of a prompt (see chunkInputs).
    tokens,
    resident: [...carries.keys()],
    // Present when this graph is part of a model rather than all of it: which
    // layers it runs, and how wide the residual stream it passes on is. A host
    // holding several stages uses these to say what it has without
    // re-deriving it from the tensor names.
    ...(template.stage !== undefined ? {stage: {...template.stage}} : {}),
    ...(template.hidden_size !== undefined ? {hidden_size: template.hidden_size} : {}),
    // With the host's checkpoint digest when it gave one. A copy: the
    // template's own manifest is the plugin's statement and stays as it was.
    ...(template.manifest !== undefined ? {manifest: checkpoint === undefined
      ? template.manifest : {...template.manifest, checkpoint_digest: checkpoint}} : {}),
  };
}

/** What a stage says it is, so a peer can refuse one it should not accept.
 *
 * Checked on the way in rather than trusted, because a manifest travels with a
 * hidden state and arrives from wherever that did. */
export function validateStageManifest(manifest) {
  fields(manifest, ['plugin', 'plugin_version', 'family', 'checkpoint_format',
    'tokenizer_formats', 'config_digest', 'first_layer', 'last_layer', 'num_layers',
    'role', 'hidden_size', 'hidden_dtype', 'context', 'graph_version', 'protocol_version',
    'fixed', 'checkpoint_digest'],
    ['plugin', 'config_digest', 'first_layer', 'last_layer', 'role', 'hidden_size',
     'hidden_dtype']);
  // Which of this stage's weights are multiplied as integers. Optional, and
  // absent means none, so a manifest written before this existed still reads.
  // It matters between peers rather than across a seam: two peers running the
  // same layers of the same checkpoint compute different numbers if one is on
  // the fixed-point path, so a checker has to compare stages that answer the
  // same question. The seam itself is f32 either way.
  if (manifest.fixed !== undefined) check(['none', 'layers', 'all'].includes(manifest.fixed),
    'FORMAT', `Unknown fixed-weight policy: ${String(manifest.fixed)}`);
  check(typeof manifest.config_digest === 'string' && /^[0-9a-f]{64}$/.test(manifest.config_digest),
    'FORMAT', 'A configuration digest is a sha256');
  // The weights' own sha256, attached by the host that opened them (see
  // prepareDecode). Optional here because a plugin's manifest never has one.
  if (manifest.checkpoint_digest !== undefined) {
    check(typeof manifest.checkpoint_digest === 'string' && /^[0-9a-f]{64}$/.test(manifest.checkpoint_digest),
      'FORMAT', 'A checkpoint digest is a sha256');
  }
  check(['head', 'middle', 'tail', 'whole'].includes(manifest.role), 'FORMAT',
    `Unknown stage role: ${String(manifest.role)}`);
  check(manifest.hidden_dtype === 'f32', 'FORMAT',
    `A seam carries f32, not ${String(manifest.hidden_dtype)}`);
  integer(manifest.first_layer, 0, 1 << 20, 'Stage first layer');
  integer(manifest.last_layer, manifest.first_layer, 1 << 20, 'Stage last layer');
  integer(manifest.hidden_size, 1, 1 << 20, 'Stage hidden size');
  return manifest;
}

/** That `hidden` is the output of the stage before this one, of this model.
 * Shared by a single step and a chunk. */
function checkSeam(plan, from) {
  if (from === undefined) return;
  check(from && typeof from === 'object', 'FORMAT', 'A stage manifest is an object');
  const mine = plan.manifest;
  check(mine !== undefined, 'FORMAT',
    'This plan has no manifest to check a hidden state against');
  // It arrived with the hidden state, from wherever that did.
  validateStageManifest(from);
  check(from.config_digest === mine.config_digest, 'CHECKPOINT',
    `That hidden state is from a different configuration (${from.config_digest} not ` +
    `${mine.config_digest}). A matching residual width is not a matching model.`);
  // A configuration names an architecture, not a model: a fine-tune of the
  // same base, or the same model quantized another way, has every field the
  // same and other weights. Which weights is the host's to say, and it says so
  // with the checkpoint digest prepareDecode attaches. Compared whenever
  // either side has one, and a side without one is refused rather than waved
  // through -- an identity that can be passed by leaving it out checks nothing.
  if (mine.checkpoint_digest !== undefined || from.checkpoint_digest !== undefined) {
    check(from.checkpoint_digest !== undefined, 'CHECKPOINT',
      `That stage does not say which weights it ran; this one runs ${mine.checkpoint_digest}`);
    check(mine.checkpoint_digest !== undefined, 'CHECKPOINT',
      `That stage ran ${from.checkpoint_digest}, and this plan was prepared without a ` +
      'checkpoint digest to compare it with: pass {checkpoint} to prepareDecode');
    check(from.checkpoint_digest === mine.checkpoint_digest, 'CHECKPOINT',
      `That hidden state is from a different checkpoint (${from.checkpoint_digest} not ` +
      `${mine.checkpoint_digest}). A matching configuration is not matching weights.`);
  }
  check(from.hidden_dtype === mine.hidden_dtype, 'FORMAT',
    `That stage sends ${from.hidden_dtype}, this one reads ${mine.hidden_dtype}`);
  check(from.last_layer + 1 === mine.first_layer, 'SHAPE',
    `That stage ends at layer ${from.last_layer}; this one begins at ` +
    `${mine.first_layer}, so ${mine.first_layer - from.last_layer - 1} layers are missing`);
}

/** The rotation of one position as a [dim, dim] matrix, written into `out`. */
function rotationAt(out, offset, position, dim, base) {
  const half = dim / 2;
  for (let j = 0; j < dim; j++) {
    const a = position / base ** ((2 * (j % half)) / dim);
    out[offset + j * dim + j] = Math.cos(a);
    const partner = j < half ? j + half : j - half;
    out[offset + partner * dim + j] = j < half ? -Math.sin(a) : Math.sin(a);
  }
}

/**
 * The inputs for a chunk: `count` consecutive tokens from `position`, in a
 * plan built for `plan.tokens` of them.
 *
 * Everything a single step is fed, one per token -- a row, a rotation, a mask
 * row reaching as far as that token's own position, a write column -- plus the
 * selector naming the last real token. A chunk shorter than the plan is
 * padded, and the padding is inert by construction: its rows are zero, they
 * write nothing into the caches (their columns are empty), and the real rows
 * cannot see them, since every one of them lies after every real position.
 * Their outputs are computed and ignored.
 *
 * `tokens` are the ids, for a plan that looks them up; `hidden` is
 * [count, width] from the stage before, for one that does not.
 */
async function chunkInputs(plan, weights, {position, tokens, hidden, from, count}) {
  const size = plan.tokens;
  integer(count, 1, size, 'Tokens in this chunk');
  integer(position, 0, plan.context - count, 'Chunk position');
  const inputs = {};
  for (const step of plan.steps) {
    if (step.slot === 'rows') {
      const info = weights.info(step.tensor), width = info.shape[1];
      let indices;
      if (step.index === 'token') {
        check(Array.isArray(tokens) && tokens.length === count, 'SHAPE',
          `A chunk of ${count} needs ${count} token ids`);
        indices = tokens;
      } else indices = Array.from({length: count}, (_, t) => position + t);
      for (const index of indices) integer(index, 0, info.shape[0] - 1, step.index === 'token' ? 'Token id' : 'Position');
      const out = new Float32Array(size * width);
      const gathered = typeof weights.rows === 'function' ? await weights.rows(step.tensor, indices) : null;
      if (gathered) out.set(gathered.subarray(0, count * width));
      else {
        const data = await weights.tensor(step.tensor);
        indices.forEach((index, t) => out.set(data.subarray(index * width, (index + 1) * width), t * width));
      }
      inputs[step.node] = out;
    } else if (step.slot === 'rope') {
      if (step.part === 'matrix') {
        const out = new Float32Array(size * step.dim * step.dim);
        for (let t = 0; t < size; t++) rotationAt(out, t * step.dim * step.dim, position + t, step.dim, step.base);
        inputs[step.node] = out;
      } else {
        const half = step.dim / 2, out = new Float32Array(size * step.dim);
        for (let t = 0; t < size; t++) {
          for (let i = 0; i < step.dim; i++) {
            const a = (position + t) / step.base ** ((2 * (i % half)) / step.dim);
            out[t * step.dim + i] = step.part === 'cos' ? Math.cos(a) : Math.sin(a);
          }
        }
        inputs[step.node] = out;
      }
    } else if (step.slot === 'hidden') {
      check(hidden instanceof Float32Array, 'SHAPE',
        'This stage begins mid-model and needs {hidden}: the output of the stage before it');
      check(hidden.length === count * step.width, 'SHAPE',
        `A chunk of ${count} for this stage is ${count * step.width} values, got ${hidden.length}`);
      checkSeam(plan, from);
      for (let i = 0; i < hidden.length; i++) check(Number.isFinite(hidden[i]), 'NUMBER', 'Non-finite value in a hidden state');
      const out = new Float32Array(size * step.width);
      out.set(hidden);
      inputs[step.node] = out;
    } else if (step.slot === 'mask') {
      const out = new Float32Array(size * plan.context);
      for (let t = 0; t < size; t++) {
        const at = position + t;
        for (let column = 0; column < plan.context; column++) {
          if (column > at || (step.window !== undefined && column <= at - step.window)) out[t * plan.context + column] = MASKED;
        }
      }
      inputs[step.node] = out;
    } else if (step.slot === 'select') {
      const out = new Float32Array(size);
      out[count - 1] = 1;
      inputs[step.node] = out;
    } else {
      // [context, tokens], row-major: a real token's column marks its row.
      const out = new Float32Array(plan.context * size);
      for (let t = 0; t < count; t++) out[(position + t) * size + t] = 1;
      inputs[step.node] = out;
    }
  }
  return {inputs};
}

/** The inputs one token needs: gathered rows, the mask so far, and the write column.
 *
 * A stage that does not start at layer 0 takes `hidden` instead of a token:
 * the residual stream the previous stage produced, which is the only thing
 * that crosses between them.
 *
 * `from` is that stage's manifest -- its plan's `manifest`, as prepareDecode
 * returned it -- and passing it is what turns "this is a float array of the
 * right length" into "this is the output of the stage before this one, of
 * this model". Two checkpoints that share a residual width produce hidden
 * states that compose without error and mean nothing, so the check is against
 * the configuration digest, the checkpoint digest and the layer adjacency
 * rather than against the shape. It is optional because a single process does
 * not need it; anything across a boundary should pass it. */
export async function stepInputs(plan, weights, {token, position, hidden, from, tokens, count}) {
  // A plan for a chunk takes a chunk: ids or hidden rows for `count` tokens.
  if ((plan.tokens ?? 1) > 1) return chunkInputs(plan, weights, {position, tokens, hidden, from, count});
  integer(position, 0, plan.context - 1, 'Decode position');
  const inputs = {};
  for (const step of plan.steps) {
    if (step.slot === 'rows') {
      const info = weights.info(step.tensor), width = info.shape[1];
      const index = step.index === 'token' ? token : position;
      integer(index, 0, info.shape[0] - 1, step.index === 'token' ? 'Token id' : 'Position');
      // One row, read as one row. A quantized embedding table is 155 million
      // values and decoding all of it to reach one of them would cost more per
      // token than the rest of the model put together.
      const gathered = typeof weights.rows === 'function' ? await weights.rows(step.tensor, [index]) : null;
      if (gathered) inputs[step.node] = gathered;
      else {
        const data = await weights.tensor(step.tensor);
        inputs[step.node] = data.slice(index * width, (index + 1) * width);
      }
    } else if (step.slot === 'rope') {
      // The angles depend on the position and the index, never on the data,
      // so they are computed here rather than being an operation.
      const half = step.dim / 2;
      const angle = i => position / step.base ** ((2 * (i % half)) / step.dim);
      if (step.part === 'matrix') {
        // The whole rotation as one matrix, so a graph applies it with one
        // multiply rather than a rotate-half built out of six operations. Two
        // non-zeros a column: x[j] keeps cos, and the other half of its pair
        // arrives with sin, negated for the first half -- which is what
        // rotate-half means, written as the linear map it is.
        const rotation = new Float32Array(step.dim * step.dim);
        for (let j = 0; j < step.dim; j++) {
          const a = angle(j);
          rotation[j * step.dim + j] = Math.cos(a);
          const partner = j < half ? j + half : j - half;
          rotation[partner * step.dim + j] = j < half ? -Math.sin(a) : Math.sin(a);
        }
        inputs[step.node] = rotation;
      } else {
        const table = new Float32Array(step.dim);
        for (let i = 0; i < step.dim; i++) table[i] = step.part === 'cos' ? Math.cos(angle(i)) : Math.sin(angle(i));
        inputs[step.node] = table;
      }
    } else if (step.slot === 'hidden') {
      // Checked rather than trusted: this arrives from another stage, and on
      // the way it may have crossed a worker, a process or a network. A short
      // or non-finite vector here would otherwise become a plausible-looking
      // continuation of somebody else's model.
      check(hidden instanceof Float32Array, 'SHAPE',
        'This stage begins mid-model and needs {hidden}: the output of the stage before it');
      check(hidden.length === step.width, 'SHAPE',
        `A hidden state for this stage is ${step.width} values, got ${hidden.length}`);
      checkSeam(plan, from);
      for (let i = 0; i < hidden.length; i++) {
        check(Number.isFinite(hidden[i]), 'NUMBER', 'Non-finite value in a hidden state');
      }
      inputs[step.node] = hidden;
    } else if (step.slot === 'mask') {
      const mask = new Float32Array(plan.context);
      for (let column = 0; column < plan.context; column++) {
        // Positions not written yet are masked, and a local layer also forgets
        // what fell out of its window -- the same rule the eager mask applies.
        if (column > position || (step.window !== undefined && column <= position - step.window)) mask[column] = MASKED;
      }
      inputs[step.node] = mask;
    } else if (step.slot === 'select') {
      // A selector over a one-token step names that token.
      inputs[step.node] = Float32Array.of(1);
    } else {
      const write = new Float32Array(plan.context);
      write[position] = 1;
      inputs[step.node] = write;
    }
  }
  return {inputs};
}
