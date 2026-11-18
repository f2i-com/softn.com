type Manifest = Record<string, unknown>;

export function isRecord(value: unknown): value is Manifest {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseManifest(source: string): Manifest {
  const value: unknown = JSON.parse(source);
  if (!isRecord(value)) throw new Error('manifest.json must contain an object.');
  return value;
}

const safeEntry = /^server\/(?:[\w.-]+\/)*[\w.-]+\.logic$/;

/** Prepare the host's API v1 contract without changing any existing project file. */
export function addFormLogicBackend(manifest: Manifest, paths: Iterable<string>): {
  manifest: Manifest; files: Record<string, string>; entry: string;
} {
  const pathsInUse = new Set([...paths].map(path => path.toLowerCase()));
  if ('server' in manifest) {
    const server = manifest.server;
    if (!isRecord(server) || !isRecord(server.requires) || server.requires.apiVersion !== 1 ||
        !isRecord(server.database) || server.database.kind !== 'private-sqlite' ||
        typeof server.entry !== 'string' || !safeEntry.test(server.entry) || server.entry.includes('..')) {
      throw new Error('This backend uses a different host format. Edit its existing manifest and server files directly.');
    }
    if (!pathsInUse.has(server.entry.toLowerCase())) throw new Error(`Restore ${server.entry} before editing this backend.`);
    return { manifest, files: {}, entry: server.entry };
  }
  let entry = 'server/main.logic';
  for (let suffix = 1; pathsInUse.has(entry.toLowerCase()); suffix++) entry = `server/api-${suffix}.logic`;
  if (manifest.config !== undefined && !isRecord(manifest.config)) throw new Error('Check the config object in manifest.json.');
  const config = manifest.config ?? {};
  if (config.server !== undefined && !isRecord(config.server)) throw new Error('Check config.server in manifest.json.');
  const serverConfig = config.server ?? {};
  return {
    manifest: { ...manifest, config: { ...config, server: { allowedOrigins: [], ...serverConfig } },
      server: { entry, requires: { apiVersion: 1, capabilities: ['sql'] },
        database: { kind: 'private-sqlite', migrations: [] },
        routes: [{ method: 'GET', path: '/api/status', handler: 'getStatus', transaction: 'read', authorization: 'anonymous' }] } },
    files: { [entry]: 'function getStatus(req) {\n  return { status: 200, body: { ok: true } };\n}\n' }, entry,
  };
}

export const apiMethods = ['GET', 'POST', 'PUT', 'DELETE'] as const;

const reservedNames = new Set(('arguments await break case catch class const continue debugger default delete do else enum eval export extends ' +
  'false finally for function if implements import in instanceof interface let new null package private protected public return static ' +
  'super switch this throw true try typeof var void while with yield').split(' '));

export function appendBackendRoute(routes: unknown[], source: string, method: string, path: string, handler: string) {
  if (!apiMethods.some(m => m === method)) throw new Error('Choose a supported HTTP method.');
  if (!/^\/api\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/.test(path)) throw new Error('Enter an API path such as /api/notes.');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(handler) || reservedNames.has(handler)) throw new Error('Enter a JavaScript function name for the handler, such as listNotes.');
  if (routes.some(r => isRecord(r) && r.path === path && String(r.method).toUpperCase() === method)) throw new Error(`${method} ${path} already exists.`);
  if (new RegExp(`\\bfunction\\s+${handler}\\s*\\(`).test(source) || routes.some(r => isRecord(r) && r.handler === handler)) {
    throw new Error('Choose a new handler name. That function already exists.');
  }
  const route = { method, path, handler, transaction: method === 'GET' ? 'read' : 'write', authorization: 'application' };
  return { routes: [...routes, route], source: source.trimEnd() + `\n\nfunction ${handler}(req) {\n  return { status: 501, body: { error: "Handler not implemented" } };\n}\n` };
}
