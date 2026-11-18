import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const prefix = 'virtual:softn-starter/';
const packageRoot = fileURLToPath(new URL('../../packages/@softn/editor-shared/', import.meta.url));

/** Export the guest's standalone library as text. It never executes in the editor's realm. */
export function starterVendorsPlugin() {
  return {
    name: 'softn-starter-vendors',
    resolveId(id) {
      if (id === prefix + 'react' || id === prefix + 'vue' || id === prefix + 'vue-sfc') return '\0' + id;
    },
    async load(id) {
      if (!id.startsWith('\0' + prefix)) return;
      const framework = id.slice(prefix.length + 1);
      const { output } = await build({
        root: packageRoot,
        configFile: false,
        publicDir: false,
        logLevel: 'silent',
        define: {
          'process.env.NODE_ENV': '"production"',
          __VUE_OPTIONS_API__: 'true',
          __VUE_PROD_DEVTOOLS__: 'false',
          __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
        },
        build: {
          write: false,
          target: 'es2022',
          minify: true,
          license: { fileName: 'LICENSE.txt' },
          rolldownOptions: {
            input: fileURLToPath(new URL(`../../packages/@softn/editor-shared/starter-vendors/${framework}.mjs`, import.meta.url)),
            preserveEntrySignatures: 'strict',
            output: { format: 'es', entryFileNames: 'vendor.js' },
          },
        },
      });
      const vendor = output.find((file) => file.type === 'chunk' && file.isEntry);
      const license = output.find((file) => file.fileName === 'LICENSE.txt');
      if (output.length !== 2 || !vendor || !license?.source) throw new Error(`Incomplete ${framework} starter library`);
      // Keep the dependency versions, copyrights and full licenses with the copy in every export.
      const notice = String(license.source).replaceAll('*/', '* /');
      return `export default ${JSON.stringify('/*!\n' + notice + '\n*/\n' + vendor.code)};`;
    },
  };
}
