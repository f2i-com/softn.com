/**
 * How a native app's `softn.net.fetch` reaches its own backend, and the one
 * decision about which of the two routes it takes.
 *
 * A native app has no direct egress: its declared API origin is routed by the
 * trusted parent to the app's own backend through the `nativeRequest` action.
 * The two routes differ only in WHERE that substitution happens.
 *
 * - `logic-bridge`: a `<logic>` fragment is prepended to the app's entry file
 *   that reassigns `softn.net.fetch` inside the guest. This is what every
 *   native app has always run, it is JavaScript, and it is written in the
 *   guest's own language.
 * - `host-handler`: the host answers the `net.fetch` host call itself, through
 *   the runtime's `netFetchHandler` option. Nothing is prepended and the
 *   guest's source is untouched.
 *
 * The second route exists because the first one cannot be written in every
 * language a bundle's logic may be in. Both produce the same answer, so which
 * one an app took is not something its author can observe.
 */

/**
 * What `softn.net.fetch` answers with, by either route: the shape the
 * `<logic>` bridge's `done(...)` has always passed to the guest.
 */
export interface NativeFetchResponse {
  ok: boolean;
  status: number;
  body: string;
  headers: Record<string, string>;
}

/** The backend action a native app's network request is routed through. */
export const NATIVE_REQUEST_ACTION = 'nativeRequest';

/**
 * The `<logic>` fragment prepended to a JavaScript native app's entry file.
 *
 * Kept here, beside the handler that has to answer identically, so the two
 * cannot be changed apart. It is the exact text native apps have always been
 * given; `nativeFetch.test.mjs` holds the handler to what it does.
 */
export const NATIVE_FETCH_BRIDGE = `<logic>
softn.net.fetch = function(url, options, done) {
  softn.backend.call("nativeRequest", {url:url,options:options || {}}, function(response) {
    if (response.error) { done({ok:false,status:503,body:JSON.stringify({error:response.error}),headers:{}}); return; }
    const result = response.result;
    done({ok:result.status >= 200 && result.status < 300,status:result.status,body:JSON.stringify(result.body),headers:{}});
  });
};
</logic>
`;

/**
 * Which route a native app's network calls take, from the languages its logic
 * is written in.
 *
 * JavaScript keeps the bridge — the route every native app has run, unchanged,
 * and the one whose behaviour the guest can still override itself. Python
 * takes the handler, because the bridge is a JavaScript assignment into a
 * JavaScript guest's `softn` object and there is no such object to assign to.
 */
export function nativeFetchRoute(languages: readonly string[]): 'logic-bridge' | 'host-handler' {
  return languages.includes('python') ? 'host-handler' : 'logic-bridge';
}

/** The backend's answer to `nativeRequest`, as much of it as this reads. */
interface NativeRequestReply {
  error?: unknown;
  result?: { status?: unknown; body?: unknown };
}

/**
 * The host-side `net.fetch` handler for a native app: the bridge's behaviour,
 * written on this side of the VM.
 *
 * The host taking this over takes the capability with it — there is no
 * `permission.json` check and no host allowlist here, exactly as there is none
 * on the `backend.call` the bridge makes. What bounds the request is the
 * parent: it accepts only named actions for the selected app, and
 * `nativeRequest` reaches that app's own backend and nothing else.
 */
export function createNativeNetFetch(
  backendCall: (action: string, input: Record<string, unknown>) => Promise<unknown>
): (url: string, options: Record<string, unknown>) => Promise<NativeFetchResponse> {
  return async (url, options) => {
    const reply = (await backendCall(NATIVE_REQUEST_ACTION, {
      url,
      options: options || {},
    })) as NativeRequestReply | null | undefined;
    if (reply?.error) {
      return { ok: false, status: 503, body: JSON.stringify({ error: reply.error }), headers: {} };
    }
    const result = reply?.result ?? {};
    const status = Number(result.status);
    return {
      ok: status >= 200 && status < 300,
      // A backend that answered with no body at all gives the guest an empty
      // string here; the bridge leaves the key undefined, which is the same
      // falsy nothing once it has crossed into the guest.
      status,
      body: JSON.stringify(result.body) ?? '',
      headers: {},
    };
  };
}
