/**
 * What a project's permission.json declares, and what to say of a call that
 * Studio did not grant.
 *
 * Neither the preview nor the agent's check grants a capability: there is no
 * consent bar to grant it, and a design preview is not the place to reach
 * out from. So a call to storage, the network or a device fails in both,
 * whatever permission.json declares.
 */

/** The capabilities a permission.json turns on, by name; nothing for a file that is missing or not JSON. */
export function declaredCapabilities(content: string | Uint8Array | undefined): string[] {
  if (typeof content !== 'string') return [];
  try {
    const parsed = JSON.parse(content) as { permissions?: Record<string, { enabled?: unknown } | undefined> } | null;
    const permissions = parsed && typeof parsed === 'object' ? parsed.permissions : undefined;
    if (!permissions || typeof permissions !== 'object') return [];
    return Object.keys(permissions)
      .filter((name) => permissions[name]?.enabled === true)
      .sort();
  } catch {
    return [];
  }
}

/** The runtime's words for a call made with nothing granted and no declaration handed to it. */
const NO_DECLARATION = /\b([a-z][\w-]*) access not permitted: this bundle ships no permission\.json/i;

/**
 * Lines the runtime printed during a check, with what it says of a call that
 * was not granted put right for this project.
 *
 * The check hands the runtime no declaration, so the runtime's line for a
 * refused call is "this bundle ships no permission.json. Declare the
 * capabilities it needs". That is the right advice for a project that has
 * not declared the capability, and it is passed on as it stands. For one
 * that has, it told the model at every check to declare a file the project
 * already has, in words that say the file is missing: Studio writes a
 * permission.json into every app, so any app that reads its storage as it
 * starts was told this. Said once for each capability, as what is true: the
 * call did not run because a check grants nothing, and there is nothing to
 * fix. Every other line is left exactly as it was.
 */
export function explainUngrantedCalls(lines: string[], permissionJson: string | Uint8Array | undefined): string[] {
  const declared = new Set(declaredCapabilities(permissionJson));
  if (declared.size === 0) return lines;
  const said = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const capability = NO_DECLARATION.exec(line)?.[1].toLowerCase();
    if (!capability || !declared.has(capability)) {
      out.push(line);
      continue;
    }
    if (said.has(capability)) continue;
    said.add(capability);
    out.push(
      `[SoftN] A call to ${capability} did not run in this check, because a check grants no capabilities. permission.json already declares ${capability}, so there is nothing to fix: the call runs when the app is opened in a runtime and the person allows it.`
    );
  }
  return out;
}
