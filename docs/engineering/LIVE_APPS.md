# Live apps: updating and editing an app while it runs

For hosts: anything that draws an app with `<SoftNRenderer>` (the web runtime,
Studio's preview, Builder's live preview, FormLogic's frame). An app's author
needs none of this; what an author sees is in the guides ("State, events and
app lifecycle", "SoftN Runtime").

## A permission allowed while the app runs

`permissionConfig` is read by every `softn.*` check when the check is made, so
a host that hands the renderer a new config does not need a new start.

- **More allowed:** the running app goes on. Its `_onPermissionChange()`, where
  it defines one, is called.
- **A call made while the person is being asked** is kept, with nothing of it
  done, and made once on Allow. This is opt-in for a host:
  `withheldPermissions(declared, { asking: true })`, from
  `@softn/runtime-shell`, marks the config as one a person is being asked
  about (32 kept calls at most). "Not now", and a later
  withdrawal, refuse at once.
- **A restart remains**, with the variables carried over, when: the app was
  refused something earlier and defines no `_onPermissionChange()`; a
  permission is taken away; its logic imports from another site; `accel` is
  allowed to logic in a worker; peer sync was asked for before Allow.
- `onConsentStatus({ waiting, restartOnAllow })` tells the host what the app is
  waiting on and whether allowing will start it again, so the bar can say so
  before the person answers.

`_init()` therefore runs once for an open app. It used to run again on Allow.

## A newer version of the app

```tsx
import { createLiveApp, composeBundleSource } from '@softn/core';

const live = createLiveApp({ gatherMs: 200 });
<SoftNRenderer app={live} onUpdate={(result) => …} />;

// Each time the files change (a Map of path to text, and the main page's path):
const result = await live.update(composeBundleSource(textFiles, mainFilePath, manifestLogicPaths));
```

`update` answers what became of the change:

| `outcome` | What happened |
|---|---|
| `unchanged` | Nothing to do. |
| `updated` | Drawn again where the app stood: variables, timers and the open page are as they were. Markup, styles and pages take this path. |
| `restarted` | Started again. `reason` says why in words for a person; `carried` says whether its variables were carried into the new start. A change to the logic takes this path, and `_init()` runs again. |
| `kept` | The newest version does not parse or would not start. The last version that worked is still on screen and `problem` says what is wrong. |

- Variables are carried when the logic is JavaScript and they are plain data. A
  class instance, a `Map`, `Set`, `Date` or typed array, a variable whose shape
  changed, and Python logic start clean.
- Stored data (XDB, files, storage) is never touched by an update.
- `live.restart()` is a clean run of the version it has.
- A host that only re-renders `<SoftNRenderer source={…}>` gets the same
  treatment and hears the answer through `onUpdate`.
- While `kept`, the renderer shows its own line over the app. A host that says
  the problem itself, beside the source, passes `editMarks` (below) and the
  renderer leaves the saying to it.

## Tracing a drawn element to its source

`@softn/core/edit` is a separate entry, for a host with an edit mode. Nothing
else imports it, so a runtime carries it only once a person asks to edit.

```ts
import { createEditMarks, drawnFrom, drawnAt, composeBundleOrigins, originOf, placesOf } from '@softn/core/edit';

const marks = createEditMarks();
<SoftNRenderer app={live} editMarks={marks} />;

// The composed page as composeBundleSource makes it, and which file each stretch of it was written in.
const composed = composeBundleOrigins(textFiles, mainFilePath, manifestLogicPaths);
await live.update(composed);

const hit = drawnFrom(marks, pressedElement);                          // { node, elements, component } or null
const where = hit && originOf(composed.origins, hit.node.loc.start);   // { file, offset } or null
```

- `drawnFrom(marks, element)`: the node of the page that drew an element (or
  the component around it). `drawnAt(marks, root, start)`: every drawing of the
  node at a place, one for each pass of a loop.
- `originOf(origins, offset)` maps a place in the composed page back to a file
  and a place in it, and answers null for what the composer wrote itself.
  `placesOf(origins, file, fileOffset)` goes the other way, and answers several
  places for a page that is imported more than once.
- Each stretch is checked against the file it names before it is given: a
  place this answers is a place the text is.

**What an app can see of this: nothing.** The marks are a `WeakMap` in the
host's memory. No attribute, property or prop is written on the page, an app's
components are handed nothing extra, and the page's HTML is the same with marks
on and off (`test/edit-marks.test.tsx` holds this). Opening an edit mode is the
host's own decision: no message, event or address from an app should reach it.

## The host's own controls

An app's `window.addEventListener('pointerdown', …)` hears the pointer anywhere
on the page while the app is on screen: a drag that leaves the app needs it.
It does not hear what is aimed at the host's own controls, when the host says
which they are:

```html
<div class="my-toolbar" data-softn-host>…</div>
```

A pointer event whose target is inside an element marked `data-softn-host` (or
inside the permission bar) is not handed to any app, unless the press now held
down began in that app: a drag still hears the pointer over the toolbar and
hears it let go there. Mark the bar over an app, an editor beside it, and any
sheet laid over the app to take a press for the host; the runtime's `FrameBar`
and its editor are marked. A sheet that takes a press should also stop it at
its own element (`stopPropagation` on the whole pointer family), so it holds
whatever is listening. Keys typed outside an app are never the app's, marked or
not (`runtime/key-capture.ts`).

The keyboard is the host's too, while the person is using something of the
host's. An app can ask for the focus whenever it likes: an `<input autofocus>`
drawn on a timer, a page script's `focus()`, a dialog opened from its logic.
While the focus is in a field of the host's, or on any control inside marked
chrome, those asks are not carried out: the renderer draws no `autofocus`, a
page's `focus()` is not made, and a Modal, Drawer or Confirm of the app's
opens without taking the focus, and leaves Tab and Escape pressed in the
host's field to the host. Nothing is done about a focus move once it is made,
so nothing of the host's is blurred, and a move made for the person (Tab, a
press in the app, a screen reader or voice control putting the focus on a
field) is theirs; once they are in the app, the app has its `autofocus` and
its `focus()` as ever. A host needs to do nothing for a plain field of its
own beside the app; marking its chrome covers its buttons as well. The rule
reads three marks and nothing else: `data-softn-app` on the element an app is
drawn in (the renderer writes it), `data-softn-host` and the permission bar's
`data-softn-consent` (`hostHoldsKeyboard` in core's `runtime/key-capture.ts`;
`utils/hostKeyboard.ts` in the components).

## Where it is used

- `apps/softn-web`: `src/lib/liveUpdate.ts` (`updateOpenApp`) and the editor
  under `src/edit/`, fetched when a person presses Edit on the bar.
- `apps/softn-studio` and `apps/softn-builder`: their previews follow the
  project's files through `live.update`.
- `apps/formlogic-host`: `src/update.ts`, for a parent's `formlogic:update`.
