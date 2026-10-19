/**
 * A conversation as the token ids a chat model was trained to read.
 *
 * Built from the tokenizer's own pieces, never by rendering the checkpoint's
 * Jinja template: the template is code from the file, and the one thing it
 * does for these families is lay out ChatML, which is a few lines here. The
 * role markers are looked up as special tokens by name and inserted as ids;
 * everything a person or an app wrote is encoded as plain text, so a message
 * that contains `<|im_end|>` reads as those characters and cannot close its
 * own turn and open another.
 */

export interface ChatMessage {
  role: string;
  content: unknown;
}

/** The parts of a GGUF tokenizer a prompt is built from. */
export interface ChatTokenizer {
  encode(text: string): ArrayLike<number>;
  id_of(piece: string): number | undefined;
}

/**
 * Text as plain characters, never as a control token.
 *
 * A GGUF tokenizer matches its control and user-defined tokens anywhere in
 * the text it is given, as Hugging Face's do: `a<|im_end|>b` encodes to the
 * turn's real end between two letters. So a message that spells a marker
 * would close its own turn and open one in another role. Cutting the text one
 * character into every place a special token's text begins leaves no piece
 * that holds a whole one; each piece is encoded on its own, and the special's
 * characters come out as the ordinary tokens they also are.
 */
export function encodePlain(tokenizer: ChatTokenizer, text: string, specials: readonly string[]): number[] {
  const cuts = new Set<number>();
  for (const piece of specials) {
    if (piece.length < 2) continue;
    for (let at = text.indexOf(piece); at !== -1; at = text.indexOf(piece, at + 1)) cuts.add(at + 1);
  }
  if (!cuts.size) return Array.from(tokenizer.encode(text));
  const ids: number[] = [];
  let from = 0;
  for (const cut of [...cuts].sort((a, b) => a - b)) {
    ids.push(...Array.from(tokenizer.encode(text.slice(from, cut))));
    from = cut;
  }
  ids.push(...Array.from(tokenizer.encode(text.slice(from))));
  return ids;
}

export interface ChatPromptOptions {
  /** Let the model reason in a `<think>` block first. Off unless asked: a small model spends its whole budget there. */
  thinking?: boolean;
  /** The text of every control and user-defined token, which messages are kept from spelling (see {@link encodePlain}). */
  specials?: readonly string[];
}

/** The families whose checkpoints speak ChatML with Qwen's `<think>` convention. */
const CHATML_FAMILIES = new Set(['qwen3', 'qwen35']);

export function supportsChat(family: string): boolean {
  return CHATML_FAMILIES.has(family);
}

/** A message's text: a string, or the text parts of a content list. Anything else is refused by name. */
export function messageText(message: ChatMessage, index: number): string {
  const { content } = message;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      const kind = part && typeof part === 'object' ? (part as { type?: unknown }).type : undefined;
      if (kind === 'text' && typeof (part as { text?: unknown }).text === 'string') {
        parts.push((part as { text: string }).text);
      } else {
        throw new Error(`Message ${index + 1} has a ${String(kind ?? typeof part)} part; this model reads text only`);
      }
    }
    return parts.join('');
  }
  throw new Error(`Message ${index + 1} has no text content`);
}

/** What a reply says once its reasoning is taken out: every closed `<think>` block, and an unclosed one to the end. */
export function visibleText(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<think>[\s\S]*$/, '')
    .replace(/^[\s\S]*?<\/think>/, '')
    .trim();
}

function special(tokenizer: ChatTokenizer, piece: string): number {
  const id = tokenizer.id_of(piece);
  if (id === undefined) throw new Error(`This checkpoint's vocabulary has no ${piece} token, so it is not a chat model`);
  return id;
}

/**
 * ChatML, as Qwen3's own template writes it: an optional system turn first,
 * then each turn as `<|im_start|>role\n…<|im_end|>\n`, and the assistant's
 * turn opened for the reply. Earlier assistant turns lose their reasoning, as
 * the template drops it. With thinking off, the reply starts after an empty
 * `<think>` block, which is how the family is told not to reason.
 */
export function chatPrompt(family: string, messages: readonly ChatMessage[], tokenizer: ChatTokenizer, options: ChatPromptOptions = {}): number[] {
  if (!supportsChat(family)) throw new Error(`No chat format is known for the ${family} family`);
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('Give at least one message');
  const start = special(tokenizer, '<|im_start|>');
  const end = special(tokenizer, '<|im_end|>');
  const text = (value: string) => Array.from(tokenizer.encode(value));
  const specials = options.specials ?? [];
  const ids: number[] = [];
  messages.forEach((message, index) => {
    const role = message?.role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      throw new Error(`Message ${index + 1} has role ${JSON.stringify(role)}; use system, user or assistant`);
    }
    if (role === 'system' && index !== 0) throw new Error('A system message can only come first');
    let content = messageText(message, index);
    if (role === 'assistant') content = visibleText(content);
    ids.push(start, ...text(`${role}\n`), ...encodePlain(tokenizer, content, specials), end, ...text('\n'));
  });
  ids.push(start, ...text('assistant\n'));
  if (!options.thinking) {
    ids.push(special(tokenizer, '<think>'), ...text('\n\n'), special(tokenizer, '</think>'), ...text('\n\n'));
  }
  return ids;
}

/** The ids that end a reply: the turn's end and the document's, where the vocabulary has them. */
export function stopTokens(tokenizer: ChatTokenizer & { eos?: number }): Set<number> {
  const stops = new Set<number>();
  for (const piece of ['<|im_end|>', '<|endoftext|>']) {
    const id = tokenizer.id_of(piece);
    if (id !== undefined) stops.add(id);
  }
  if (typeof tokenizer.eos === 'number') stops.add(tokenizer.eos);
  return stops;
}
