export interface RuntimeInfo {
  ok: boolean;
  appId: string;
  appName: string;
  mode: 'zipp-wasm' | 'standalone-php';
  phpVersion: string;
  database: string;
}

export async function apiFetch<T>(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  const resp = await fetch(path, { method, headers, body });
  const text = await resp.text();
  let data: unknown = null;
  if (text.trim().length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON from ${path} (HTTP ${resp.status}): ${text.slice(0, 140)}`);
    }
  }
  if (!resp.ok) {
    const errObj = data && typeof data === 'object' ? (data as { error?: string }) : null;
    throw new Error(errObj?.error || `Request failed (${resp.status})`);
  }
  return data as T;
}
