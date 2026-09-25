/**
 * The zxing reader's .wasm as a URL. `?url` is the bundler's asset import
 * (Vite's, which every host of these components builds with): the file is
 * emitted with the host's build and the import is its public URL. tsup keeps
 * the import external so that decision is the host's; see QRReader.tsx.
 */
declare module 'zxing-wasm/reader/zxing_reader.wasm?url' {
  const url: string;
  export default url;
}
