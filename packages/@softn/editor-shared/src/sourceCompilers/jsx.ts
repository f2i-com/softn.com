import { transform } from 'sucrase';

/** A separate React binding supports both source with an explicit React import
 * and modern JSX that imports just hooks. It lives in the guest module. */
export function compile(source: string, path: string): string {
  let binding = '__softnReact';
  while (source.includes(binding)) binding += '_';
  const { code } = transform(source, {
    filePath: path,
    transforms: ['jsx'],
    disableESTransforms: true,
    production: true,
    jsxPragma: binding + '.createElement',
    jsxFragmentPragma: binding + '.Fragment',
  });
  // Skip the extra dependency when the module contained plain JavaScript.
  if (!code.includes(binding + '.')) return code;
  const runtime = `import * as ${binding}Module from 'react';\nconst ${binding} = ${binding}Module.React ?? ${binding}Module.default ?? ${binding}Module;`;
  return runtime + '\n' + code;
}

export async function frameworkSource(): Promise<string> {
  return (await import('virtual:softn-starter/react')).default;
}
