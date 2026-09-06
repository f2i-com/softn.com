/**
 * What a Builder project declares it needs, and the permission.json that says so.
 *
 * A bundle without a permission.json declares nothing, and the runtime gives
 * it nothing: an app whose logic calls `softn.storage` or `softn.net.fetch`
 * fails closed at every call. Builder exported exactly that for every project,
 * so a Builder app could not use the network or its server storage however
 * its author wrote it. The declaration lives on the project now, is written
 * into every export, and is read back from every bundle opened.
 *
 * The names are the capability schema's; the storage policies are the
 * schema's too, and Builder knows the collections, so it can declare a
 * policy for each.
 */

import { CAPABILITIES, inspectDeclaration, type Capability, type StoragePolicy } from '@softn/core';

export interface PermissionDeclaration {
  /** Capabilities the app asks for, in schema order. */
  capabilities: Capability[];
  /** Hosts `net` may reach; empty means any host, after consent. */
  allowedHosts: string[];
  /** Plain-HTTP servers allowed for `net`, for a development server on localhost. */
  allowHttp: boolean;
  /** A storage policy per collection (`*` for the rest); absent collections are public. */
  storagePolicies: Record<string, StoragePolicy>;
}

export function emptyDeclaration(): PermissionDeclaration {
  return { capabilities: [], allowedHosts: [], allowHttp: false, storagePolicies: {} };
}

/** The permission.json for a declaration, or null when nothing is declared and no file is needed. */
export function buildPermissionJson(decl: PermissionDeclaration): string | null {
  const permissions: Record<string, Record<string, unknown>> = {};
  for (const name of CAPABILITIES) {
    if (!decl.capabilities.includes(name)) continue;
    const entry: Record<string, unknown> = { enabled: true };
    if (name === 'net') {
      const hosts = decl.allowedHosts.map((h) => h.trim()).filter(Boolean);
      if (hosts.length > 0) entry.allowed_hosts = hosts;
      if (decl.allowHttp) entry.allow_http = true;
    }
    if (name === 'storage') {
      const policies = Object.fromEntries(Object.entries(decl.storagePolicies).filter(([, p]) => p && p !== 'public'));
      if (Object.keys(policies).length > 0) entry.collections = policies;
    }
    permissions[name] = entry;
  }
  if (Object.keys(permissions).length === 0) return null;
  return JSON.stringify({ permissions }, null, 2);
}

/** A declaration read back from a bundle's permission.json; unknown or malformed parts are dropped. */
export function readPermissionJson(text: string): PermissionDeclaration {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyDeclaration();
  }
  const report = inspectDeclaration(parsed);
  const net = (parsed as { permissions?: { net?: { allowed_hosts?: unknown; allow_http?: unknown } } })?.permissions?.net;
  const allowedHosts = Array.isArray(net?.allowed_hosts) ? net.allowed_hosts.filter((h): h is string => typeof h === 'string') : [];
  return {
    capabilities: report.requested,
    allowedHosts,
    allowHttp: net?.allow_http === true,
    storagePolicies: report.storagePolicies,
  };
}

/** Whether a declaration asks for anything at all. */
export function declaresAnything(decl: PermissionDeclaration): boolean {
  return decl.capabilities.length > 0;
}
