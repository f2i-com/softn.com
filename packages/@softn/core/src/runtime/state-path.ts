/**
 * State path parsing, shared by every `setState` implementation.
 *
 * `:bind` describes its target as a path string — `user.name`, `todos[0].title`.
 * Splitting that on `.` alone leaves `todos[0]` as a single segment, which then
 * gets written as an object key of that literal name: the array is untouched,
 * the field appears not to accept edits, and a phantom key accumulates in state.
 * Every setState had its own copy of the same split, so this lives here instead.
 */

/**
 * Split a state path into its segments.
 *
 * Bracket segments become their own part with quotes stripped, so
 * `todos[0].title` is `['todos', '0', 'title']` and `map["a b"]` is
 * `['map', 'a b']`. A numeric segment is left as a string; callers decide
 * whether the container at that point is an array.
 *
 * A key in double quotes is read to its closing quote, with a backslash
 * taking the character after it as written: `answers["it]em"]` is the key
 * `it]em`, and `m["say \"hi\""]` the key `say "hi"`. The renderer writes
 * every text key this way (`pathStep` in renderer/evaluate.ts). Read to the
 * first `]`, a key holding one was split there and the write went to a key
 * the app never had. An empty key in quotes, `m[""]`, is the key `''`.
 */
export function parseStatePath(path: string): string[] {
  const parts: string[] = [];
  let current = '';

  const flush = () => {
    if (current !== '') {
      parts.push(current);
      current = '';
    }
  };

  for (let i = 0; i < path.length; i++) {
    const ch = path[i];

    if (ch === '.') {
      flush();
      continue;
    }

    if (ch === '[') {
      flush();
      const escaped = quotedKey(path, i + 1);
      if (escaped) {
        parts.push(escaped.key);
        i = escaped.end; // the ']'
        continue;
      }
      let key = '';
      let j = i + 1;
      while (j < path.length && path[j] !== ']') {
        key += path[j];
        j++;
      }
      i = j; // land on the ']' so the loop's own increment moves past it
      key = key.trim();
      const quoted =
        (key.startsWith('"') && key.endsWith('"')) ||
        (key.startsWith("'") && key.endsWith("'"));
      if (quoted && key.length >= 2) {
        key = key.slice(1, -1);
      }
      if (key !== '') parts.push(key);
      continue;
    }

    current += ch;
  }

  flush();
  return parts;
}

/**
 * The key written in double quotes from `from` (just past a `[`), and where
 * its `]` is; or null when what is there is not such a key, closed and
 * followed by `]`, and is read the older way.
 */
function quotedKey(path: string, from: number): { key: string; end: number } | null {
  let i = from;
  while (path[i] === ' ') i++;
  if (path[i] !== '"') return null;
  let key = '';
  for (i++; i < path.length && path[i] !== '"'; i++) {
    if (path[i] === '\\' && i + 1 < path.length) i++;
    key += path[i];
  }
  if (path[i] !== '"') return null;
  i++;
  while (path[i] === ' ') i++;
  return path[i] === ']' ? { key, end: i } : null;
}
