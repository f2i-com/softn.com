import { compileScript, compileStyle, compileTemplate, parse } from '@vue/compiler-sfc';

/** A deterministic scope per project-relative filename, including nested files with the same basename. */
function scopeId(path: string): string {
  let hash = 2166136261;
  for (let i = 0; i < path.length; i++) hash = Math.imul(hash ^ path.charCodeAt(i), 16777619);
  return 'data-v-' + (hash >>> 0).toString(16);
}

function checkErrors(errors: readonly (Error | string)[]) {
  if (errors.length) throw new Error(errors.map((e) => typeof e === 'string' ? e : e.message).join('\n'));
}

export function compile(source: string, path: string): string {
  const { descriptor, errors } = parse(source, { filename: path, sourceMap: false });
  checkErrors(errors);
  const { script, scriptSetup, template, styles } = descriptor;
  for (const block of [script, scriptSetup, template, ...styles]) {
    if (!block) continue;
    if (block.src) throw new Error(`Use an inline <${block.type}> block or import a local module in your script.`);
    const expected = block.type === 'script' ? 'js' : block.type === 'style' ? 'css' : 'html';
    if (block.lang && block.lang !== expected) throw new Error(`The preview supports <${block.type}> with lang="${expected}".`);
  }
  if (styles.some(style => style.module)) throw new Error('Use a plain or scoped CSS block for this preview.');

  const id = scopeId(path);
  const scoped = styles.some(style => style.scoped);
  let component = '__softnComponent';
  while (source.includes(component)) component += '_';
  const templateOptions = {
    transformAssetUrls: { base: '/' + path.slice(0, Math.max(0, path.lastIndexOf('/') + 1)) },
    compilerOptions: { runtimeModuleName: 'vue' },
  };
  const parts: string[] = [];
  if (script || scriptSetup) {
    parts.push(compileScript(descriptor, {
      id, genDefaultAs: component, inlineTemplate: Boolean(scriptSetup), isProd: true, sourceMap: false, templateOptions,
    }).content);
  } else {
    parts.push(`const ${component} = {};`);
  }
  if (template && !scriptSetup) {
    const result = compileTemplate({
      ...templateOptions, compilerOptions: { ...templateOptions.compilerOptions, inline: true },
      id, scoped, isProd: true, filename: path, source: template.content,
    });
    checkErrors(result.errors);
    parts.unshift(result.preamble ?? '');
    parts.push(`${component}.render = ${result.code};`);
  }
  if (scoped) parts.push(`${component}.__scopeId = ${JSON.stringify(id)};`);
  for (const style of styles) {
    const result = compileStyle({ id, filename: path, source: style.content, scoped: style.scoped, isProd: true });
    checkErrors(result.errors);
    // Mount in the guest document. SoftN's DOM bridge applies its normal CSS and URL policies.
    parts.push(`{ const style = document.createElement('style'); style.textContent = ${JSON.stringify(result.code)}; document.head.appendChild(style); }`);
  }
  parts.push(`export default ${component};`);
  return parts.join('\n');
}

export async function frameworkSource(): Promise<string> {
  return (await import('virtual:softn-starter/vue-sfc')).default;
}
