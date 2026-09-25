/**
 * Studio never names a model. Model names change faster than Studio ships:
 * a default or an example baked into the source goes stale, and a stale
 * default is worse than none — it sends requests to a model the person never
 * chose, or fails with a 404 nobody can explain. The list always comes from
 * the provider. This guard fails if a model-name-looking literal creeps back
 * into the app's source (tests are exempt: they need ids to stub with).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');

/**
 * Families of model names, as they would appear in a default, a placeholder
 * or an example. Word boundaries keep "Ollama" (a server, which the setup
 * does name) from matching "llama".
 */
const MODEL_NAME = /\b(?:claude-|gpt-|o[1-9]-(?:mini|pro|preview)\b|llama|mistral|mixtral|gemma|qwen|phi-?\d|deepseek|codellama|sonnet|opus|haiku)/i;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|css|html)$/.test(name) ? [path] : [];
  });
}

describe('no model names in Studio’s source', () => {
  it('has none in src/', () => {
    const hits: string[] = [];
    for (const file of sourceFiles(SRC)) {
      readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        const match = line.match(MODEL_NAME);
        if (match) hits.push(`${relative(SRC, file)}:${index + 1}: ${match[0]} — ${line.trim().slice(0, 120)}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('would catch the defaults that used to be there', () => {
    for (const stale of ["anthropic: 'claude-sonnet-4-6'", "openai: 'gpt-5.4'", "'e.g. llama3, mistral, gemma2...'", 'Default: qwen2.5']) {
      expect(stale).toMatch(MODEL_NAME);
    }
    for (const fine of ['Ollama', 'OLLAMA_ORIGINS', 'LM Studio', 'anthropic-version', 'Anthropic API key']) {
      expect(fine).not.toMatch(MODEL_NAME);
    }
  });
});
