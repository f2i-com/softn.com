"""Qwen3: the first checkpoint family this host runs without expanding it.

A separate plugin, not a configuration of the GPT-Neo one. They share the words
"attention" and "MLP" and agree on nothing else that matters:

  * RMSNorm, no bias anywhere, and a second norm applied **per head** to the
    query and key projections before rotation -- the thing that distinguishes
    Qwen3 from Qwen2.
  * Rotary position embeddings with a base of 1,000,000, not learned position
    embeddings.
  * Grouped-query attention: sixteen query heads over eight key/value heads.
  * A gated SwiGLU MLP, three matrices, not two.
  * Attention scaled by 1/sqrt(head_dim), which GPT-Neo omits entirely.
  * The output projection tied to the token embedding.

The configuration comes from the checkpoint itself. A GGUF file carries its own
hyperparameters under its architecture's prefix, so unlike a Hugging Face folder
there is no `config.json` to read and nothing to convert: `config_from_gguf`
maps the metadata this plugin needs and refuses anything it does not recognise.

The weights are read where they lie. Every projection is bound with `matrix`,
which hands the host the checkpoint's own `[out, in]` tensor and lets it keep
the block format where a backend can decode it. For this family that is most of
the file -- a 0.6B Qwen3 is 373 MB resident where float32 would be 2,274 MB --
and the graph is identical either way, because the multiply is transposed
regardless.
"""
from zipp_plugin.graph import Graph, rope_tables

# Who this is, for a stage that has to say so to a peer. The manifest declares
# the same id and version; these are here because a stage describes itself
# without the host reading the manifest back to it.
PLUGIN_ID = "org.zipp.qwen3"
PLUGIN_VERSION = "0.1.0"

CHECKPOINT_FORMAT = "gguf.qwen3-v1"
TOKENIZER_FORMATS = ["qwen2-byte-bpe-v1"]

REQUIRED = {"vocab_size", "context_length", "hidden_size", "num_heads", "num_kv_heads",
            "head_dim", "num_layers", "intermediate_size", "rms_norm_epsilon", "rope_base"}
LIMITS = [("vocab_size", 2, 262144), ("context_length", 1, 262144), ("hidden_size", 1, 8192),
          ("num_heads", 1, 128), ("num_kv_heads", 1, 128), ("head_dim", 2, 512),
          ("num_layers", 1, 64), ("intermediate_size", 1, 32768)]

# GGUF metadata keys, under the architecture's own prefix.
GGUF_KEYS = {
    "hidden_size": "embedding_length", "num_heads": "attention.head_count",
    "num_kv_heads": "attention.head_count_kv", "num_layers": "block_count",
    "intermediate_size": "feed_forward_length", "context_length": "context_length",
    "rms_norm_epsilon": "attention.layer_norm_rms_epsilon", "rope_base": "rope.freq_base",
    "head_dim": "attention.key_length",
}


def config_from_gguf(metadata, vocab_size):
    """The plugin's own configuration, out of the file's own metadata."""
    architecture = metadata.get("general.architecture")
    if architecture != "qwen3":
        raise ValueError("Not a qwen3 checkpoint: " + str(architecture))
    config = {"vocab_size": int(vocab_size)}
    for name, suffix in GGUF_KEYS.items():
        key = "qwen3." + suffix
        if key not in metadata:
            raise ValueError("Checkpoint metadata is missing " + key)
        value = metadata[key]
        config[name] = float(value) if name == "rms_norm_epsilon" else int(value)
    # The rotations here are plain RoPE. A file that asks for scaled rotations
    # (YaRN, for a long-context release) would run with the wrong positions
    # rather than fail, so it is refused unless the scaling is a no-op (a
    # factor of 0 is llama.cpp's "unset").
    scaling = metadata.get("qwen3.rope.scaling.type", "none")
    factor = metadata.get("qwen3.rope.scaling.factor", 1.0)
    if scaling not in ("none", "linear") or (scaling == "linear" and float(factor) not in (0.0, 1.0)):
        raise ValueError("Unsupported rotary scaling: " + str(scaling) + " x" + str(factor))
    return config


def describe(config):
    if set(config) != REQUIRED:
        raise ValueError("Unexpected configuration fields")
    for name, low, high in LIMITS:
        value = config[name]
        if type(value) is not int or not low <= value <= high:
            raise ValueError("Configuration out of range: " + name)
    if config["num_heads"] % config["num_kv_heads"] != 0:
        raise ValueError("Query heads must be a multiple of key/value heads")
    if config["head_dim"] % 2 != 0:
        raise ValueError("Rotary embeddings need an even head dimension")
    epsilon = config["rms_norm_epsilon"]
    if not isinstance(epsilon, float) or not 0.0 < epsilon < 1.0:
        raise ValueError("Configuration out of range: rms_norm_epsilon")
    return {
        "family": "qwen3",
        "checkpoint_format": CHECKPOINT_FORMAT,
        "tokenizer_formats": list(TOKENIZER_FORMATS),
        "vocab_size": config["vocab_size"],
        # The graph is built for one prompt at a time, and every tensor in it is
        # sized by the prompt, so the host's context ceiling is what binds.
        "max_context": config["context_length"],
        "tied_embeddings": True,
    }


def tensor_names(config, first_layer=None, last_layer=None):
    """Every tensor a graph binds, in the checkpoint's own naming. Listed so a
    host can check a file before building anything.

    With a layer range this is the point of the whole exercise: a peer holding
    layers 8..15 is told to load eleven tensors a layer and nothing else, so
    "this device holds part of the model" is a fact about what it read rather
    than a promise about what it uses. `token_embd.weight` is listed only for a
    stage that looks a token up or projects to logits, and `output_norm.weight`
    only for the one that ends the model.
    """
    first, last = layer_range(config, first_layer, last_layer)
    names = []
    if first == 0 or last == config["num_layers"] - 1:
        names.append("token_embd.weight")
    if last == config["num_layers"] - 1:
        names.append("output_norm.weight")
    for layer in range(first, last + 1):
        block = "blk." + str(layer) + "."
        names.extend([block + "attn_norm.weight", block + "attn_q.weight",
                      block + "attn_k.weight", block + "attn_v.weight",
                      block + "attn_q_norm.weight", block + "attn_k_norm.weight",
                      block + "attn_output.weight", block + "ffn_norm.weight",
                      block + "ffn_gate.weight", block + "ffn_up.weight",
                      block + "ffn_down.weight"])
    return names


def _decode_layer(g, x, layer, config, step):
    """One transformer block of a cached decode step.

    Split out of `build_decode_graph` so a graph can be built over any range of
    layers rather than always over all of them. `x` in and `x` out is the
    residual stream, which is the only thing a block hands to the next one --
    every norm a block needs is inside it.

    `step` carries what depends on the position rather than the layer: the
    mask, the write column, its complement and the rotation. Those are the same
    for every block, so they are built once and passed in.

    It also says how many tokens a step covers. One is the decode step it
    always was, emitted operation for operation as before. More is a *chunk*
    of a prompt: every projection multiplies [tokens, width] rather than one
    row, so each weight is read once for the whole chunk instead of once a
    token -- which is where a step's time goes -- while the attention and the
    cache writes are the single-token arithmetic, row by row.
    """
    tokens = step.get("tokens", 1)
    hidden = config["hidden_size"]
    heads, kv_heads = config["num_heads"], config["num_kv_heads"]
    dim = config["head_dim"]
    repeats = heads // kv_heads
    epsilon = config["rms_norm_epsilon"]
    intermediate = config["intermediate_size"]
    q_width, kv_width = heads*dim, kv_heads*dim
    context = step["context"]

    block = "blk." + str(layer) + "."
    n = g.rms_norm(x, block + "attn_norm.weight", hidden, epsilon)
    q = g.op("reshape", a=g.linear(n, block + "attn_q.weight", hidden, q_width),
             shape=[tokens, heads, dim])
    k = g.op("reshape", a=g.linear(n, block + "attn_k.weight", hidden, kv_width),
             shape=[tokens, kv_heads, dim])
    v = g.op("reshape", a=g.linear(n, block + "attn_v.weight", hidden, kv_width),
             shape=[tokens, kv_heads, dim])
    q = g.rms_norm(q, block + "attn_q_norm.weight", dim, epsilon)
    k = g.rms_norm(k, block + "attn_k_norm.weight", dim, epsilon)
    q = g.rope_once(q, heads, dim, step["rotation"], tokens)
    k = g.rope_once(k, kv_heads, dim, step["rotation"], tokens)

    # Into the caches, which are [context, kv_width] and carried. The names
    # carry the absolute layer index, so the caches of a stage holding layers
    # 8..15 never collide with those of a stage holding 0..7.
    keys = g.write_cache("k" + str(layer), g.cache("k" + str(layer), [context, kv_width]),
                         step["keep"], step["write"], g.op("reshape", a=k, shape=[tokens, kv_width]))
    values = g.write_cache("v" + str(layer), g.cache("v" + str(layer), [context, kv_width]),
                           step["keep"], step["write"], g.op("reshape", a=v, shape=[tokens, kv_width]))
    # Grouped-query attention without repeating anything.
    #
    # The prefill path copies each key head out to the query heads it serves,
    # because its mask is [tokens, tokens] and cannot broadcast across a
    # grouped batch. One token needs no such thing: viewing the queries as
    # [kv_heads, repeats, dim] makes the batch dimension the key head itself,
    # so the cache is read where it lies. That removes a [context, heads, dim]
    # copy of both caches every step -- 29 million elements written per token
    # on this model -- and halves what the permutes move.
    kh = g.op("permute", a=g.op("reshape", a=keys, shape=[context, kv_heads, dim]),
              dims=[1, 2, 0])                              # [kv_heads, dim, context]
    vh = g.op("permute", a=g.op("reshape", a=values, shape=[context, kv_heads, dim]),
              dims=[1, 0, 2])                              # [kv_heads, context, dim]
    if tokens == 1:
        qg = g.op("reshape", a=q, shape=[kv_heads, repeats, dim])
        scores = g.op("mul", a=g.op("matmul", a=qg, b=kh), b=step["scale"])
        scores = g.op("add", a=scores, b=step["mask"])     # [1, context] broadcasts
        attended = g.op("matmul", a=g.op("softmax", a=scores, axis=-1), b=vh)
        # [kv_heads, repeats, dim] is already head order, so this is a view.
        attended = g.op("reshape", a=attended, shape=[1, q_width])
    else:
        # The same grouping with the chunk's tokens inside it: each key head
        # serves `repeats` query heads of every token, [tokens*repeats] rows
        # against the one cache. Each token's mask row reaches only as far as
        # its own position, broadcast across the heads that share it.
        qg = g.op("reshape", a=q, shape=[tokens, kv_heads, repeats, dim])
        qg = g.op("permute", a=qg, dims=[1, 0, 2, 3])      # [kv_heads, tokens, repeats, dim]
        qg = g.op("reshape", a=qg, shape=[kv_heads, tokens*repeats, dim])
        scores = g.op("mul", a=g.op("matmul", a=qg, b=kh), b=step["scale"])
        scores = g.op("reshape", a=scores, shape=[kv_heads, tokens, repeats, context])
        scores = g.op("add", a=scores, b=step["mask"])     # [tokens, 1, context] broadcasts
        probs = g.op("reshape", a=g.op("softmax", a=scores, axis=-1),
                       shape=[kv_heads, tokens*repeats, context])
        attended = g.op("matmul", a=probs, b=vh)           # [kv_heads, tokens*repeats, dim]
        attended = g.op("reshape", a=attended, shape=[kv_heads, tokens, repeats, dim])
        attended = g.op("permute", a=attended, dims=[1, 0, 2, 3])
        attended = g.op("reshape", a=attended, shape=[tokens, q_width])
    x = g.op("add", a=x, b=g.linear(attended, block + "attn_output.weight", q_width, hidden))

    n = g.rms_norm(x, block + "ffn_norm.weight", hidden, epsilon)
    gate = g.silu(g.linear(n, block + "ffn_gate.weight", hidden, intermediate))
    up = g.linear(n, block + "ffn_up.weight", hidden, intermediate)
    x = g.op("add", a=x, b=g.linear(g.op("mul", a=gate, b=up),
                                    block + "ffn_down.weight", intermediate, hidden))
    return x


def _decode_step_inputs(g, config, context, tokens=1):
    """What every block of a decode step needs, and no block owns.

    The mask, the write column and the rotation depend on the position, not on
    which layers are being run -- so a stage holding layers 8..15 needs exactly
    the same ones as a stage holding 0..7.

    A chunk's write has a column per token, and a cache row is kept unless one
    of them writes it: (1 - write) summed across the columns, which a multiply
    by a column of ones is.
    """
    write = g.step_write(context, tokens)
    if tokens == 1:
        keep = g.op("sub", a=g.scalar(1.0), b=write)
    else:
        written = g.op("matmul", a=write, b=g.op("full", shape=[tokens, 1], value=1.0))
        keep = g.op("sub", a=g.scalar(1.0), b=written)
    return {
        "context": context,
        "tokens": tokens,
        "mask": g.step_mask(context, tokens),
        "write": write,
        "keep": keep,
        "rotation": g.step_rope("matrix", config["head_dim"], config["rope_base"], tokens),
        "scale": g.scalar(1.0 / (config["head_dim"] ** 0.5)),
    }


def build_decode_graph(config, context=None):
    """The same model as one cached step: read one token, attend over the cache.

    `build_graph` recomputes the whole prompt for every token and is the
    correctness oracle. This is the shape that makes a checkpoint usable: the
    host prepares it once, so every weight -- 372 MB of blocks for the 0.6B --
    is uploaded once instead of per token; the key and value caches live on the
    device and never cross the boundary; and a token costs one position rather
    than the whole context.

    The arithmetic is identical to `build_graph` at the last position. Two
    things differ. The keys and values come from the caches, with this token's
    written in first -- by arithmetic, because the protocol has no scatter. And
    the rotary tables are fed per step rather than built in, because this graph
    is built once and run at every position.

    This is `build_decode_stage` over every layer, which is how it stays the
    definition of what a stage must add up to.
    """
    return build_decode_stage(config, context=context)


def layer_range(config, first_layer=None, last_layer=None):
    """The inclusive layer range a stage covers, checked against the model.

    Defaults to the whole model, so every existing caller means what it always
    meant. A range outside the model is refused here rather than producing a
    graph that binds tensors the checkpoint does not have.
    """
    total = config["num_layers"]

    def exact(value, what):
        # Strict rather than coercive, because this is a boundary between
        # machines. `int(3.7)` is 3 and `int("5")` is 5, and a peer told to run
        # layers 3.7..9 would run a range nobody asked for and say nothing. A
        # bool is an int in Python and is refused here for the same reason.
        if isinstance(value, bool) or type(value) is not int:
            raise ValueError(what + " must be an integer, got " + repr(value))
        return value

    first = 0 if first_layer is None else exact(first_layer, "first_layer")
    last = total - 1 if last_layer is None else exact(last_layer, "last_layer")
    if not 0 <= first <= last < total:
        raise ValueError("Invalid layer range: " + str(first) + ".." + str(last) +
                         " of " + str(total) + " layers")
    return first, last


FIXED_POLICIES = ("none", "layers", "all")


def fixed_weights(config, first, last, policy=None):
    """Which weight matrices to bind for `matmul_fixed`, and why it is a choice.

    `matmul_fixed` quantizes both sides to int16 and sums the products as
    integers. Integer addition is associative, so every backend that implements
    it reaches the *same* answer rather than one within a tolerance of another
    -- which is what lets a second peer check a stage's compute by equality, and
    what a proof over a prime field would need. Bound this way the weight is
    quantized once instead of on every step, and at one token a step that is
    faster than the float32 product it replaces.

    It costs 3.56 times what the same weight costs as Q4_K blocks, so this is a
    memory decision and not a correctness one, and it is made here rather than
    assumed. Three answers:

      * `none` -- the default, and what every stage did before this existed.
      * `layers` -- the projections inside the transformer blocks. For a
        Qwen3-0.6B middle stage that is most of the arithmetic and none of the
        embedding table, which is the single largest tensor in the file and is
        read a row at a time anyway.
      * `all` -- those and the tied `token_embd.weight`, which a stage that
        ends the model also multiplies to reach logits. The biggest gain and
        the biggest cost: for this model that one tensor is 155M values.

    A stage may mix the two forms freely, because they give the same answer.
    """
    if policy is None:
        policy = "none"
    if policy not in FIXED_POLICIES:
        raise ValueError("Unknown fixed-weight policy: " + repr(policy))
    if policy == "none":
        return frozenset()
    names = []
    for layer in range(first, last + 1):
        block = "blk." + str(layer) + "."
        names.extend([block + "attn_q.weight", block + "attn_k.weight",
                      block + "attn_v.weight", block + "attn_output.weight",
                      block + "ffn_gate.weight", block + "ffn_up.weight",
                      block + "ffn_down.weight"])
    # Only where it is a matmul. A stage that begins the model looks a token up
    # in the same tensor, and a row gather reads the file's own blocks -- there
    # is nothing for a quantized weight to be there.
    if policy == "all" and last == config["num_layers"] - 1:
        names.append("token_embd.weight")
    return frozenset(names)


def config_digest(config):
    """A stable fingerprint of a configuration, for comparing two peers.

    Canonical JSON -- sorted keys, no incidental spacing -- so the digest
    depends on the values and not on how they were written down.
    """
    import hashlib
    import json
    canonical = json.dumps(config, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def describe_stage(config, first_layer=None, last_layer=None, context=None, fixed=None):
    """What a stage is, in enough detail that a peer cannot be handed the wrong one.

    In one process a hidden state is obviously the right hidden state. Over a
    network it is a [1, 1024] array of floats, and so is one from a different
    checkpoint that happens to share a residual width -- which would compose
    without error into confident nonsense. So a stage says what it is, and a
    receiver checks before it computes.

    What the plugin can answer is here. What it cannot -- the checkpoint's own
    sha256, a session identity -- belongs to the host, which is the thing that
    opened the file and is running the session.
    """
    description = describe(config)
    first, last = layer_range(config, first_layer, last_layer)
    total = config["num_layers"]
    if first == 0 and last == total - 1:
        role = "whole"
    elif first == 0:
        role = "head"
    elif last == total - 1:
        role = "tail"
    else:
        role = "middle"
    return {
        "plugin": PLUGIN_ID,
        "plugin_version": PLUGIN_VERSION,
        "family": description["family"],
        "checkpoint_format": description["checkpoint_format"],
        "tokenizer_formats": description["tokenizer_formats"],
        "config_digest": config_digest(config),
        "first_layer": first,
        "last_layer": last,
        "num_layers": total,
        "role": role,
        # What crosses the seam, and what it would take to accept one.
        "hidden_size": config["hidden_size"],
        "hidden_dtype": "f32",
        "context": description["max_context"] if context is None else int(context),
        "graph_version": 2,
        "protocol_version": 1,
        # Which weights this stage multiplies as integers. Two peers running
        # the same layers of the same checkpoint still compute different numbers
        # if one of them is on the fixed-point path, so a stage says which it is
        # and a checker compares peers that answer the same question.
        "fixed": "none" if fixed is None else fixed,
    }


def build_decode_stage(config, context=None, first_layer=None, last_layer=None, fixed=None,
                       tokens=None):
    """One cached decode step over layers [first_layer, last_layer].

    A whole model is the default and is what `build_decode_graph` asks for. A
    range is what makes a model divisible: layers 0..7 on one device, 8..15 on
    another, and a hidden state between them.

    ## What crosses the seam

    The residual stream, and nothing else. Every normalisation a block needs
    happens inside that block, so a stage hands on `x` exactly as the next
    block expects to receive it -- one `[1, hidden_size]` vector, 4 KB for this
    model, against the 372 MB of weights that stay where they are. That ratio
    is the whole argument for splitting a model this way rather than moving it.

    ## What does not cross it

    The caches. `k12` and `v12` belong to whichever stage runs layer 12, live
    on that device, and are never read by anything else -- a stage that owns
    layers 8..15 carries sixteen caches and knows nothing of the other twelve.
    That is why the names carry absolute layer indices.

    ## The two ends

    A stage starting at layer 0 reads a token id and looks the embedding up; a
    later one receives a hidden state. A stage ending at the last layer applies
    the output norm and projects to logits; an earlier one emits the residual.
    A stage that is both, which is the default, does both -- and
    `token_embd.weight` is bound once for the lookup and once for the tied
    projection, as it always was.

    ## Chunks

    `tokens` above one builds the same stage over that many consecutive
    positions at once: a chunk of a prompt. It attends over and writes into
    the same caches, so a prompt can be run a chunk at a time and the decode
    graph carry on from where the last chunk left off -- the caches are what
    connect them, and they hold the same thing either way. The difference is
    where the time goes: a decode step reads every weight to process one
    token, and a chunk reads it once for all of its tokens. A chunk may be
    padded; the host says which of its rows are real, and the last stage
    projects only the last real one onto the vocabulary.
    """
    description = describe(config)
    context = description["max_context"] if context is None else int(context)
    if not 1 <= context <= description["max_context"]:
        raise ValueError("Invalid decode context")
    first, last = layer_range(config, first_layer, last_layer)
    tokens = 1 if tokens is None else tokens
    if isinstance(tokens, bool) or not isinstance(tokens, int) or not 1 <= tokens <= context:
        raise ValueError("A chunk is between one token and the context")

    hidden = config["hidden_size"]
    epsilon = config["rms_norm_epsilon"]

    g = Graph(fixed_weights(config, first, last, fixed))
    # The head of the model, or a hidden state from whoever ran the layers
    # before this one.
    if first == 0:
        x = g.step_rows("token_embd.weight", "token", hidden, tokens)
    else:
        x = g.step_hidden(hidden, tokens)

    step = _decode_step_inputs(g, config, context, tokens)
    for layer in range(first, last + 1):
        x = _decode_layer(g, x, layer, config, step)

    # The tail of the model, or the residual for whoever runs the rest.
    if last == config["num_layers"] - 1:
        if tokens > 1:
            # One row is sampled, so one row is projected: selecting before the
            # norm is the same thing, since the norm is per row.
            x = g.op("matmul", a=g.step_select(tokens), b=x)
        x = g.rms_norm(x, "output_norm.weight", hidden, epsilon)
        logits = g.linear(x, "token_embd.weight", hidden, config["vocab_size"])
        return g.finish_decode(logits, context, stage=(first, last),
                               manifest=describe_stage(config, first, last, context, fixed))
    return g.finish_stage(x, context, hidden, stage=(first, last),
                          manifest=describe_stage(config, first, last, context, fixed))


def _prefill_layer(g, x, layer, config, ctx):
    """One transformer block over a whole prompt.

    The same arithmetic as `_decode_layer` over many positions instead of one:
    the mask is [length, length] rather than [1, context], there are no caches
    to write, and the rotary tables are constants because a prefill knows every
    position when it is built.

    `x` in and `x` out is the residual stream, so a range of these composes the
    same way a range of decode layers does.
    """
    length = ctx["length"]
    hidden = config["hidden_size"]
    heads, kv_heads = config["num_heads"], config["num_kv_heads"]
    dim = config["head_dim"]
    repeats = heads // kv_heads
    epsilon = config["rms_norm_epsilon"]
    intermediate = config["intermediate_size"]
    q_width, kv_width = heads*dim, kv_heads*dim
    mask, cos, sin, scale = ctx["mask"], ctx["cos"], ctx["sin"], ctx["scale"]

    block = "blk." + str(layer) + "."
    n = g.rms_norm(x, block + "attn_norm.weight", hidden, epsilon)
    q = g.op("reshape", a=g.linear(n, block + "attn_q.weight", hidden, q_width),
             shape=[length, heads, dim])
    k = g.op("reshape", a=g.linear(n, block + "attn_k.weight", hidden, kv_width),
             shape=[length, kv_heads, dim])
    v = g.op("reshape", a=g.linear(n, block + "attn_v.weight", hidden, kv_width),
             shape=[length, kv_heads, dim])
    # Per-head RMSNorm before rotation. This is Qwen3's addition, and the
    # weights are head_dim wide rather than hidden wide.
    q = g.rms_norm(q, block + "attn_q_norm.weight", dim, epsilon)
    k = g.rms_norm(k, block + "attn_k_norm.weight", dim, epsilon)
    q = g.rope(q, length, heads, dim, cos, sin)
    k = g.rope(k, length, kv_heads, dim, cos, sin)
    k = g.repeat_heads(k, length, kv_heads, repeats, dim)
    v = g.repeat_heads(v, length, kv_heads, repeats, dim)

    qh = g.op("permute", a=q, dims=[1, 0, 2])            # [heads, length, dim]
    kh = g.op("permute", a=k, dims=[1, 2, 0])            # [heads, dim, length]
    vh = g.op("permute", a=v, dims=[1, 0, 2])            # [heads, length, dim]
    scores = g.op("mul", a=g.op("matmul", a=qh, b=kh), b=scale)
    scores = g.op("add", a=scores, b=mask)
    context = g.op("matmul", a=g.op("softmax", a=scores, axis=-1), b=vh)
    context = g.op("reshape", a=g.op("permute", a=context, dims=[1, 0, 2]),
                   shape=[length, q_width])
    x = g.op("add", a=x, b=g.linear(context, block + "attn_output.weight", q_width, hidden))

    n = g.rms_norm(x, block + "ffn_norm.weight", hidden, epsilon)
    gate = g.silu(g.linear(n, block + "ffn_gate.weight", hidden, intermediate))
    up = g.linear(n, block + "ffn_up.weight", hidden, intermediate)
    x = g.op("add", a=x, b=g.linear(g.op("mul", a=gate, b=up),
                                    block + "ffn_down.weight", intermediate, hidden))
    return x


def _prefill_inputs(g, config, length):
    """What every block of a prefill needs: the causal mask and the rotations.

    Constants rather than fed values, because a prefill graph is built for one
    prompt and knows every position in it.
    """
    dim = config["head_dim"]
    cos_data, sin_data = rope_tables(length, dim, float(config["rope_base"]))
    return {
        "length": length,
        "mask": g.causal_mask(length),
        "cos": g.literal("rope_cos", [length, 1, dim], cos_data),
        "sin": g.literal("rope_sin", [length, 1, dim], sin_data),
        "scale": g.scalar(1.0 / (dim ** 0.5)),
    }


def build_prefill_stage(config, prompt, first_layer=None, last_layer=None, fixed=None):
    """A prompt through layers [first_layer, last_layer].

    A peer holding part of a model has to prefill as well as decode -- the
    prompt has to reach its layers before a cached step means anything. So this
    is `build_graph` over a range, and `build_graph` is this over all of it.

    The seam is wider here than in a decode step and still small: the residual
    stream for the whole prompt is [length, hidden_size], 20 KB for five tokens
    on this model, against weights that do not move at all.

    ## It does not warm the caches

    Worth being plain about, because the name suggests otherwise. This is a
    *batched forward* over a prompt. It produces the residual stream; it does
    not produce the key and value caches a decode session carries, and those
    start at zero however much prefilling has happened.

    The batched prefill that does warm them is the *decode* graph over a chunk
    of positions -- `build_decode_stage(..., tokens=16)` -- which attends over
    and writes the caches exactly as a step does, row by row, while reading
    each weight once for the whole chunk. A host runs a prompt through that a
    chunk at a time and hands the caches to the one-token graph to carry on;
    tests/qwen3-chunks.test.mjs holds it to the step-by-step path, bit for
    bit. So `build_prefill_stage` stays what it was: the eager path and the
    oracle, not the way a session should start.

    ## What a stage is told

    Only the first stage is given the prompt, because only the first stage
    looks a token up. Every later one takes a *length*: the shape of the
    residual stream it will be handed, which is all it can use. Passing the
    token ids to a peer that runs layers 20..27 would be sending it the
    prompt's contents to establish a dimension -- the model would still be
    right, and the seam would quietly be carrying more than it needs to.

    So `prompt` is a list of ids for a stage beginning at layer 0, and an
    integer length for one that does not. Giving a later stage a list is
    accepted and its length taken, since a caller holding the prompt anyway
    should not have to remember which stage it is talking to.
    """
    description = describe(config)
    first, last = layer_range(config, first_layer, last_layer)

    if isinstance(prompt, bool) or not isinstance(prompt, (list, int)):
        raise ValueError("A prompt is a list of token ids, or a length")
    if isinstance(prompt, int):
        if first == 0:
            raise ValueError("The first stage looks tokens up and needs their ids")
        length, tokens = prompt, None
    else:
        length, tokens = len(prompt), prompt
    if not 1 <= length <= description["max_context"]:
        raise ValueError("Invalid context length")
    if tokens is not None and any(
            type(token) is not int or not 0 <= token < config["vocab_size"]
            for token in tokens):
        raise ValueError("Invalid token id")
    hidden = config["hidden_size"]
    epsilon = config["rms_norm_epsilon"]

    g = Graph(fixed_weights(config, first, last, fixed))
    if first == 0:
        x = g.rows("token_embd.weight", tokens, hidden)
    else:
        x = g.feed("hidden", [length, hidden])

    ctx = _prefill_inputs(g, config, length)
    for layer in range(first, last + 1):
        x = _prefill_layer(g, x, layer, config, ctx)

    if last == config["num_layers"] - 1:
        x = g.rms_norm(x, "output_norm.weight", hidden, epsilon)
        # Only the last row is sampled, and this vocabulary is 151,936 wide:
        # taking the row before the projection is the difference between logits
        # of [1, 151936] and [tokens, 151936].
        last_row = g.op("matmul", a=g.one_hot_row(length, length - 1), b=x)
        # Tied: the output projection is the token embedding read the other way
        # round, so the checkpoint carries no second copy of it.
        logits = g.linear(last_row, "token_embd.weight", hidden, config["vocab_size"])
        return g.finish(logits, stage=(first, last),
                        manifest=describe_stage(config, first, last, length, fixed))
    return g.finish_hidden(x, stage=(first, last),
                           manifest=describe_stage(config, first, last, length, fixed))


def build_graph(config, tokens):
    """The whole prompt through the whole model, which is the correctness
    oracle every other path is checked against."""
    return build_prefill_stage(config, tokens)
