/**
 * How a native app's `softn.net.fetch` reaches its own backend.
 *
 * A native app has no direct egress: its declared API origin is routed by the
 * trusted parent to the app's own backend through the `nativeRequest` action.
 * The host answers the `net.fetch` host call itself, through the runtime's
 * `netFetchHandler` option, so the guest's source is untouched and the route
 * is the same whatever language its logic is in.
 *
 * Until v0.0.28 a JavaScript app took another route to the same answer: a
 * `<logic>` fragment prepended to its entry file reassigned `softn.net.fetch`
 * inside the guest. The entry's logic runs after the app's helper files, so a
 * helper that fetched as it loaded, or kept `softn.net.fetch` to call later,
 * had the browser's own fetch, which a native app is never permitted. Nothing
 * runs before a host-side handler. `nativeFetch.test.mjs` keeps that fragment,
 * and holds this handler to what it did.
 */

/**
 * What `softn.net.fetch` answers with: the shape the `<logic>` bridge's
 * `done(...)` passed to the guest.
 */
export interface NativeFetchResponse {
  ok: boolean;
  status: number;
  body: string;
  headers: Record<string, string>;
}

/** The backend action a native app's network request is routed through. */
export const NATIVE_REQUEST_ACTION = 'nativeRequest';

/** The backend's answer to `nativeRequest`, as much of it as this reads. */
interface NativeRequestReply {
  error?: unknown;
  result?: { status?: unknown; body?: unknown };
}

/**
 * The host-side `net.fetch` handler for a native app.
 *
 * The host taking this over takes the capability with it — there is no
 * `permission.json` check and no host allowlist here, exactly as there is none
 * on a `backend.call`. What bounds the request is the parent: it accepts only
 * named actions for the selected app, and `nativeRequest` reaches that app's
 * own backend and nothing else.
 *
 * A method is sent upper-cased, as a browser's `fetch` sends it: an app
 * written for SoftN Web that asked for `post` was refused by a host that takes
 * `POST`.
 */
export function createNativeNetFetch(
  backendCall: (action: string, input: Record<string, unknown>) => Promise<unknown>
): (url: string, options: Record<string, unknown>) => Promise<NativeFetchResponse> {
  return async (url, options) => {
    const given = options || {};
    const reply = (await backendCall(NATIVE_REQUEST_ACTION, {
      url,
      options: typeof given.method === 'string' ? { ...given, method: given.method.toUpperCase() } : given,
    })) as NativeRequestReply | null | undefined;
    if (reply?.error) {
      return { ok: false, status: 503, body: JSON.stringify({ error: reply.error }), headers: {} };
    }
    const result = reply?.result ?? {};
    const status = Number(result.status);
    return {
      ok: status >= 200 && status < 300,
      // A backend that answered with no body at all gives the guest an empty
      // string here; the bridge left the key undefined, which is the same
      // falsy nothing once it has crossed into the guest.
      status,
      body: JSON.stringify(result.body) ?? '',
      headers: {},
    };
  };
}
