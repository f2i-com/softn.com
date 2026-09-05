/**
 * The options a script may pass to `db.startSync`, with the host's identity
 * applied last.
 *
 * Both entrypoints used to merge the guest's options over `{ room }` and then
 * set `appId` only if the merged object did not already carry one. So a bundle
 * could name another app's identifier — or a different room from the one it
 * asked for in the first argument — and the sync layer would take its word for
 * it, replicating into that app's database. Options may request behaviour:
 * a display name, signalling servers, whether to persist. They may not say
 * who they are.
 *
 * A host that has no app identity does not get one from the guest either; the
 * key is removed rather than left to whatever the options contained.
 */
export function bindSyncOptions(
  room: string,
  options: Readonly<Record<string, unknown>> | undefined,
  hostAppId: string | undefined
): Record<string, unknown> {
  const bound: Record<string, unknown> = { ...(options ?? {}), room };
  if (hostAppId !== undefined && hostAppId !== '') bound.appId = hostAppId;
  else delete bound.appId;
  return bound;
}
