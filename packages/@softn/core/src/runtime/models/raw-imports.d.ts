/** A file's text, as Vite's `?raw` and the model worker's build (scripts/build-model-worker.mjs) both read it. */
declare module '*?raw' {
  const text: string;
  export default text;
}
