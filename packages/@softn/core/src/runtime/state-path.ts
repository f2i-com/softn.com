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
