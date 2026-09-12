export interface BundleServerConfig {
  url?: string;
  token?: string;
  /** Older desktop bundles used this spelling. */
  auth_token?: string;
  collections?: string[];
}

export function resolveServerConfig(config?: BundleServerConfig) {
  let serverUrl: string | undefined;
  if (config?.url) {
    const url = new URL(config.url);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
      throw new Error('The app server must use an HTTP or WebSocket URL.');
    }
    if (url.protocol === 'http:') url.protocol = 'ws:';
    if (url.protocol === 'https:') url.protocol = 'wss:';
    url.pathname = url.pathname.replace(/\/+$/, '');
    if (!url.pathname.endsWith('/sync')) url.pathname += '/sync';
    serverUrl = url.toString();
  }
  return {
    serverUrl,
    serverToken: config?.token ?? config?.auth_token,
    serverCollections: config?.collections,
  };
}

export function isSoftnPath(value: string): boolean {
  return /\.softn$/i.test(value);
}
