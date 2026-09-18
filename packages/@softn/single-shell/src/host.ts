import type { SingleConfig } from './config';

/**
 * What an app's `softn.backend.call(action, input, callback)` reaches when
 * the page it runs in supplies a backend.
 */
export type HostBackendCall = (action: string, input: Record<string, unknown>) => Promise<unknown>;

/**
 * The default export of a host module: given the configuration that named
 * it, the backend call to hand the app.
 */
export type HostFactory = (context: {
  config: SingleConfig;
}) => HostBackendCall | Promise<HostBackendCall>;

type HostModule = { default?: unknown };

/**
 * The backend a configuration names, or `undefined` when it names none.
 *
 * Some apps need something only their host should hold -- a key, a live
 * connection, the decision to spend somebody's electricity -- and reach it
 * through named actions rather than holding it themselves. A deployment
 * supplies that as a module beside the bundle and names it as `host`; this
 * loads it once, before the app mounts, so an app's first action has
 * somewhere to go.
 *
 * It fails closed. A host that is named but will not load, exports no
 * factory, or produces no function is an error, never an app quietly left
 * running without the backend it was deployed with -- an app that expects
 * its host and finds nothing tends to look broken in ways that point
 * everywhere except here.
 *
 * `importModule` is replaceable so this can be tested without a browser.
 */
export async function loadHost(
  config: SingleConfig,
  importModule: (url: string) => Promise<HostModule> = (url) => import(/* @vite-ignore */ url)
): Promise<HostBackendCall | undefined> {
  if (config.host === undefined) return undefined;
  const module = await importModule(config.host);
  const factory = module.default;
  if (typeof factory !== 'function')
    throw Error('A host module must export a default function that returns the backend call');
  const call: unknown = await (factory as HostFactory)({ config });
  if (typeof call !== 'function') throw Error('The host module did not provide a backend call');
  return call as HostBackendCall;
}
