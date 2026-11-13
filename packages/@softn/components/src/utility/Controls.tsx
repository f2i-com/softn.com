/**
 * Controls Component
 *
 * What the player is holding, as one record of state. Renders nothing visible.
 *
 * A game reads its input once a tick: is left held, has fire been pressed
 * since I last looked. Written by hand that is a latch on the window, a
 * keydown and a keyup listener, a blur handler, a guard against typing in a
 * field, and `softn.input.captureKeys` so the arrows do not scroll the page
 * under the game. This is those forty lines, once:
 *
 *     <Controls :bind={pad} keys={{ left: "ArrowLeft a", right: "ArrowRight d", fire: "Space" }} />
 *
 * and in logic, `if (pad.left) x -= 220 * dt`.
 *
 * The record holds each action by its name, true while it is held, and
 * `presses`, which counts how many times each has gone down, so a tick can
 * tell a new press from a key still held (`pad.presses.fire > fired`).
 *
 * The keys named are kept from the browser while the app has the keyboard:
 * the page does not scroll, Space does not press the button that was clicked
 * last. A key typed into a field is the field's, and the browser's own
 * chords (Ctrl+R, anything with the system key, a key pressed while Alt is
 * held) are the browser's. Everything is let go when the window loses focus,
 * when the app or the tab is hidden, and when the component goes; and every
 * key is let go when the system key goes down or comes up, since a key let
 * go while it is held is never heard of again.
 *
 * A connected gamepad holds the same actions: its left stick and its d-pad
 * hold `left`, `right`, `up` and `down`, and its buttons hold the other
 * actions in the order `keys` lists them. A `<DPad :bind={pad} />` writes the
 * same record, so touch, keys and a gamepad are one thing to the game: an
 * action is held while any of them holds it, and a press is counted once
 * however many of them go down together.
 */

import * as React from 'react';
import { useAppActive } from '@softn/core';

/** What a `<Controls>` (and a `<DPad>`) keeps in the variable it is bound to. */
export interface ControlsValue {
  /**
   * How many times each action has been pressed since the app started, by
   * the action's name. A press counts once however long it is held, so a
   * tick that remembers the count it last saw can tell a new press:
   * `if (pad.presses.fire > fired) { fired = pad.presses.fire; shoot() }`.
   */
  presses: Record<string, number>;
  /** Each action by its name: true while a key, a gamepad or a bound DPad holds it. */
  [action: string]: boolean | Record<string, number>;
}

export interface ControlsProps {
  /**
   * The actions and the keys that hold each, by the action's name:
   * `{ left: "ArrowLeft a", right: "ArrowRight d", fire: "Space" }`. A key is
   * named as `KeyboardEvent.key` or `KeyboardEvent.code` gives it
   * (`"ArrowLeft"`, `"a"`, `"Space"`, `"Enter"`, `"ShiftLeft"`), several
   * separated by spaces or as a list; a letter is the same key with Shift
   * held. A letter or a digit is the key that types it; on a keyboard that
   * types other letters there (Russian, Greek) it is the key where that
   * letter usually is, so `w a s d` are the same four keys. Only these keys
   * are kept from the browser.
   */
  keys?: Record<string, string | string[]>;
  /**
   * The record of what is held. Write `:bind={pad}` over a variable that
   * starts as `{ presses: {} }`: the component fills it in and keeps it.
   * Bound to the same variable as a `<DPad>` or another `<Controls>`, an
   * action is held while any of them holds it.
   */
  value?: ControlsValue | null;
  /** Called with the new record when an action is pressed or let go; `:bind` writes it to the variable. */
  onChange?: (value: ControlsValue) => void;
  /**
   * Called once when a key or the gamepad puts an action down, with its
   * name; not again while it is held, by these or by a `<DPad>` bound to the
   * same variable.
   */
  onPress?: (action: string) => void;
  /** Called once when a key or the gamepad lets an action go and nothing else holds it, with its name. */
  onRelease?: (action: string) => void;
  /**
   * A connected gamepad's part (default true): its left stick and d-pad hold
   * the actions named `left`, `right`, `up` and `down`, and buttons 0, 1, 2…
   * (A, B, X, Y on the usual layout) hold the other actions in the order
   * `keys` lists them. A record names the buttons instead, by action:
   * `{ fire: 0, jump: [1, 2] }`. `false` reads no gamepad. What the gamepad
   * held is let go when it is turned off, unplugged, or its buttons are
   * named anew.
   */
  gamepad?: boolean | Record<string, number | number[]>;
  /**
   * How far the stick is pushed, from 0 to 1, before it holds a direction
   * (default 0.4). It lets go when the stick falls back under four fifths of
   * that, so a stick resting at the edge is one press and not many.
   */
  deadzone?: number;
  /**
   * Whether the controls are listening (default true). While false nothing
   * is held and no key is kept from the browser: for a menu over the game,
   * where the arrows should move through the page again.
   */
  enabled?: boolean;
}

/**
 * What the components bound to one record know between them, kept beside
 * the record and never in it: the record stays `{ left: true, …, presses }`.
 *
 * A `<Controls>` and a `<DPad>` bound to one variable, or two `<Controls>`,
 * each write that variable. Writing only what it had seen itself, each undid
 * the other: with a finger still on the pad's Left, letting go of the Left
 * key wrote `left: false`; and a key that holds an action in each of two
 * `<Controls>` made two records out of the one both had been handed, the
 * second written over the first. So they share who holds each action, and
 * the record as it was last written. An action is held while anything holds
 * it, a press is counted when it goes from held by nothing to held, and each
 * writes on top of what the last one wrote.
 *
 * They find each other by the record. `:bind` hands a component the value
 * of its variable, so the components bound to one variable are handed the
 * same object, and what one of them writes is the object all of them are
 * handed next. A record none of them has met (logic put a new one in the
 * variable: a new game) starts again from what it says: the first component
 * handed it begins, the others handed it join, and each brings along what it
 * is holding.
 */
interface Sharing {
  /** The record as last written by one of them or handed to one of them, whichever is later. */
  latest: unknown;
  /** The actions that are held, each with the components holding it. */
  holders: Map<string, Set<object>>;
}

/** The sharing of every record a bound component has been handed or has written. */
const sharings = new WeakMap<object, Sharing>();

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;

/** `who` holds `action`. True when nothing held it before. */
function takeHold(sharing: Sharing, action: string, who: object): boolean {
  const by = sharing.holders.get(action);
  if (by) {
    by.add(who);
    return false;
  }
  sharing.holders.set(action, new Set([who]));
  return true;
}

/** `who` holds `action` no longer. True when nothing holds it now. */
function letGo(sharing: Sharing, action: string, who: object): boolean {
  const by = sharing.holders.get(action);
  if (by) {
    by.delete(who);
    if (by.size > 0) return false;
    sharing.holders.delete(action);
  }
  return true;
}

/** What a change in what one component holds did to the record. */
export interface HeldChange {
  /** The record to write to the variable, or null when it is as it was. */
  record: ControlsValue | null;
  /** The actions that went down: held now, and by nothing before. */
  pressed: string[];
  /** The actions that were let go: nothing holds them now. */
  released: string[];
}

/** Before paint in a browser, where the record handed over is settled before any key can be heard; a plain effect on a server. */
const useBeforePaint = typeof window !== 'undefined' ? React.useLayoutEffect : React.useEffect;

const NOT_HANDED = Symbol('no record handed over yet');
const NO_ACTIONS: readonly string[] = [];

/**
 * A component's part in the record it is bound to: `<Controls>` and `<DPad>`
 * both keep theirs through this, which is how the two are one record (see
 * `Sharing`).
 *
 * `value` is the record the component was handed. The function returned is
 * called with the actions the component holds now, all of them, whenever
 * that changes. It answers with the record to write (null when the record
 * is as it was: the action is still held by something else, or already was)
 * and with the actions that went down and were let go because of it.
 * `fill` names actions to put in the record where it lacks them, false and
 * counted 0 unless something holds them; with `always`, they are filled in
 * though nothing changed.
 */
export function useHeldRecord(value: unknown): (now: ReadonlySet<string>, fill?: readonly string[], always?: boolean) => HeldChange {
  const selfRef = React.useRef<{ sharing: Sharing; holding: Set<string>; given: unknown } | null>(null);
  if (selfRef.current === null) selfRef.current = { sharing: { latest: value, holders: new Map() }, holding: new Set(), given: NOT_HANDED };
  const self = selfRef.current;

  // Which record this is, and so whom it is shared with, each time another
  // is handed over. Nothing is written here and nothing is drawn again.
  useBeforePaint(() => {
    if (self.given === value) return;
    self.given = value;
    let sharing = isObject(value) ? sharings.get(value) : undefined;
    if (!sharing) {
      // A record nobody has met. A variable not set yet is nothing to be
      // found by: the component is on its own until it has written one.
      sharing = { latest: value, holders: new Map() };
      if (isObject(value)) sharings.set(value, sharing);
    }
    if (sharing !== self.sharing) {
      for (const action of self.holding) {
        letGo(self.sharing, action, self);
        takeHold(sharing, action, self);
      }
      self.sharing = sharing;
    }
    sharing.latest = value;
  }, [value, self]);

  return React.useCallback(
    (now: ReadonlySet<string>, fill: readonly string[] = NO_ACTIONS, always = false): HeldChange => {
      const { sharing, holding } = self;
      const pressed: string[] = [];
      const released: string[] = [];
      for (const action of [...holding]) {
        if (now.has(action)) continue;
        holding.delete(action);
        if (letGo(sharing, action, self)) released.push(action);
      }
      for (const action of now) {
        if (holding.has(action)) continue;
        holding.add(action);
        if (takeHold(sharing, action, self)) pressed.push(action);
      }
      if (!always && pressed.length === 0 && released.length === 0) return { record: null, pressed, released };

      const base = isObject(sharing.latest) ? (sharing.latest as Record<string, unknown>) : null;
      const counted = base !== null && isObject(base.presses) ? (base.presses as Record<string, number>) : null;
      const presses: Record<string, number> = { ...(counted ?? {}) };
      const next = { ...(base ?? {}), presses } as ControlsValue;
      let changed = counted === null;
      // Only what changed is written, and what is missing filled in: what
      // logic itself put in the record stays as it put it.
      for (const action of fill) {
        if (typeof next[action] !== 'boolean') {
          next[action] = sharing.holders.has(action);
          changed = true;
        }
        if (typeof presses[action] !== 'number') {
          presses[action] = 0;
          changed = true;
        }
      }
      for (const action of released) {
        if (next[action] === false) continue;
        next[action] = false;
        changed = true;
      }
      for (const action of pressed) {
        next[action] = true;
        presses[action] = (typeof presses[action] === 'number' ? presses[action] : 0) + 1;
        changed = true;
      }
      if (!changed) return { record: null, pressed, released };
      sharing.latest = next;
      sharings.set(next, sharing);
      return { record: next, pressed, released };
    },
    [self]
  );
}

/** The directions a stick and a d-pad hold, with the d-pad's button on the usual layout. */
const DIRECTIONS: Record<string, { axis: 0 | 1; sign: -1 | 1; button: number }> = {
  left: { axis: 0, sign: -1, button: 14 },
  right: { axis: 0, sign: 1, button: 15 },
  up: { axis: 1, sign: -1, button: 12 },
  down: { axis: 1, sign: 1, button: 13 },
};

/**
 * How far back, as a share of the deadzone, a stick that holds a direction
 * must fall before it lets go. With one edge, a stick resting on it (0.39,
 * 0.41, 0.39…) was a press at every other frame, each a write of the record
 * and a drawing of the page.
 */
const STICK_LET_GO = 0.8;

/** Names people write for a key that the browser calls something else. */
const KEY_ALIASES: Record<string, string> = {
  space: ' ',
  spacebar: ' ',
  esc: 'escape',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
};

/** A key named, or typed, as one letter of the Latin alphabet or one digit. */
const LATIN = /^[a-z0-9]$/;
/** One letter of any alphabet: with LATIN ruled out, a letter of another alphabet than the Latin one. */
const A_LETTER = /^\p{L}$/u;

/** What the tables below hold for a key: the actions it holds. */
type ActionsByKey = Map<string, string[]>;

function addAction(table: ActionsByKey, key: string, action: string): void {
  const held = table.get(key);
  if (!held) table.set(key, [action]);
  else if (!held.includes(action)) held.push(action);
}

/**
 * Each key name, lower-cased, to the actions it holds; and, for a name that
 * is one letter or digit, the place that letter has on the usual keyboard
 * (`w` is `keyw`, `1` is `digit1`) to the same actions.
 */
function keyTable(keys: ControlsProps['keys']): { actions: string[]; byKey: ActionsByKey; byPlace: ActionsByKey } {
  const actions: string[] = [];
  const byKey: ActionsByKey = new Map();
  const byPlace: ActionsByKey = new Map();
  if (!keys || typeof keys !== 'object') return { actions, byKey, byPlace };
  for (const [action, written] of Object.entries(keys)) {
    // `presses` is the record's own field; an action cannot be called that.
    if (action === 'presses') continue;
    actions.push(action);
    const names = Array.isArray(written) ? written.map(String) : typeof written === 'string' ? written.split(/[\s,]+/) : [];
    for (const raw of names) {
      if (raw === '') continue;
      const lower = raw.toLowerCase();
      for (const name of new Set([lower, KEY_ALIASES[lower] ?? lower])) addAction(byKey, name, action);
      if (LATIN.test(lower)) addAction(byPlace, (lower >= 'a' ? 'key' : 'digit') + lower, action);
    }
  }
  return { actions, byKey, byPlace };
}

/** Whether the event's target takes typed text, which belongs to it. */
function isEditable(target: EventTarget | null): boolean {
  const element = target as (Element & { isContentEditable?: boolean }) | null;
  if (!element || typeof element.tagName !== 'string') return false;
  const tag = element.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || element.isContentEditable === true;
}

/**
 * Whether the controls are where the person can see them: the nearest box
 * they are drawn in is on screen. (The mark the renderer puts round an app
 * draws no box of its own, so it cannot be asked.)
 */
function onScreen(anchor: Element): boolean {
  let node = anchor.parentElement;
  while (node && getComputedStyle(node).display === 'contents') node = node.parentElement;
  if (!node) return false;
  return typeof node.checkVisibility === 'function' ? node.checkVisibility() : node.isConnected;
}

/** Whether the key is the system key itself: Cmd on a Mac, the Windows key. */
function isSystemKey(event: KeyboardEvent): boolean {
  return event.key === 'Meta' || event.key === 'OS' || /^(Meta|OS)(Left|Right)$/.test(event.code ?? '');
}

/**
 * Whether a key is this app's to take: not typed into a field, not one of
 * the browser's chords, and aimed at the app. That is a key on one of the
 * app's own elements, or, while the app is on screen, on something that
 * holds the app: the page itself with nothing focused, or the box a host
 * keeps the app in (SoftN Web rests the focus on an app's tab). A key on a
 * control of the host's beside the app, or in another app, is not. The app
 * is told by the mark the renderer puts round it; a component drawn outside
 * any app takes every key that is not typed into a field.
 */
function keyIsForApp(event: KeyboardEvent, anchor: Element | null): boolean {
  if (event.metaKey || (event.ctrlKey && event.key.length === 1)) return false;
  // A key pressed while Alt is held is the browser's or the system's as
  // well: Alt+Left is Back, and cancelled it was a page that could not be
  // left that way. Alt itself is a key like any other. An action already
  // held when Alt goes down stays held: Alt sits beside Space and is
  // brushed in play, and the held key still says when it comes up.
  if (event.altKey && event.key !== 'Alt' && event.key !== 'AltGraph') return false;
  if (isEditable(event.target)) return false;
  const box = anchor?.closest('[data-softn-app]') ?? null;
  if (!anchor || !box) return true;
  const target = event.target as Node | null;
  // The window or the document themselves.
  if (!target || typeof target.nodeType !== 'number' || target.nodeType !== 1) return true;
  if (box.contains(target)) return true;
  return target.contains(box) && onScreen(anchor);
}

/** The buttons of each action that is not a direction, by the `gamepad` prop or in the order written. */
function gamepadButtons(actions: readonly string[], gamepad: ControlsProps['gamepad']): Map<string, number[]> {
  const buttons = new Map<string, number[]>();
  if (gamepad !== null && typeof gamepad === 'object') {
    for (const action of actions) {
      const named = gamepad[action];
      const list = (Array.isArray(named) ? named : [named]).filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0);
      if (list.length > 0) buttons.set(action, list);
    }
    return buttons;
  }
  let next = 0;
  for (const action of actions) {
    if (DIRECTIONS[action]) continue;
    buttons.set(action, [next++]);
  }
  return buttons;
}

function connectedGamepads(): Gamepad[] {
  try {
    return Array.from(navigator.getGamepads() ?? []).filter((pad): pad is Gamepad => !!pad && pad.connected !== false);
  } catch {
    // A page that is not allowed gamepads has none.
    return [];
  }
}

const documentHidden = (): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden';

export function Controls({ keys, value, onChange, onPress, onRelease, gamepad = true, deadzone = 0.4, enabled = true }: ControlsProps) {
  const anchorRef = React.useRef<HTMLSpanElement>(null);
  const appShown = useAppActive();
  const listening = enabled && appShown;

  // A page hands over a new `keys` record at every draw: what it says is
  // what the listeners are made for, not which object says it.
  const keysText = JSON.stringify(keys ?? null);
  const gamepadText = JSON.stringify(gamepad ?? null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by what `keys` says
  const table = React.useMemo(() => keyTable(keys), [keysText]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by what `gamepad` says
  const buttons = React.useMemo(() => gamepadButtons(table.actions, gamepad), [table, gamepadText]);

  const handlers = React.useRef({ onChange, onPress, onRelease });
  handlers.current = { onChange, onPress, onRelease };

  /** The keys holding each action, each by its place on the keyboard. */
  const keyHeld = React.useRef(new Map<string, Set<string>>());
  /** The actions a gamepad holds. */
  const padHeld = React.useRef(new Set<string>());
  /** This component's part in the record, beside whatever else is bound to it. */
  const hold = useHeldRecord(value);

  /**
   * Write the record from what is held now, and say what was pressed and let
   * go. An action something else bound to the record is holding is neither:
   * it was held before the key went down, and is held after it comes up.
   */
  const settle = React.useCallback(
    (always = false) => {
      const now = new Set<string>();
      for (const [action, by] of keyHeld.current) if (by.size > 0) now.add(action);
      for (const action of padHeld.current) now.add(action);
      const change = hold(now, table.actions, always);
      if (change.record) handlers.current.onChange?.(change.record);
      for (const action of change.pressed) handlers.current.onPress?.(action);
      for (const action of change.released) handlers.current.onRelease?.(action);
    },
    [table, hold]
  );

  const releaseAll = React.useCallback(() => {
    keyHeld.current.clear();
    padHeld.current = new Set();
    settle();
  }, [settle]);

  // The record is filled in when it is first met, and again if logic puts a
  // new one in its place (a new game): every action is there to read, and
  // every count is a number, before anything has been pressed.
  const filledFor = React.useRef<unknown>(Symbol('none'));
  React.useEffect(() => {
    if (!enabled || filledFor.current === value) return;
    filledFor.current = value;
    const whole =
      value !== null &&
      typeof value === 'object' &&
      value.presses !== null &&
      typeof value.presses === 'object' &&
      table.actions.every((action) => typeof value[action] === 'boolean' && typeof value.presses[action] === 'number');
    if (!whole) settle(true);
  }, [enabled, value, table, settle]);

  // The keyboard.
  React.useEffect(() => {
    if (!listening || typeof window === 'undefined') return;

    const actionsOf = (event: KeyboardEvent): readonly string[] => {
      const code = event.code ? event.code.toLowerCase() : '';
      const name = typeof event.key === 'string' ? event.key.toLowerCase() : '';
      const byCode = code ? table.byKey.get(code) : undefined;
      const byName = name ? table.byKey.get(name) : undefined;
      // A letter or a digit goes by what the key types. Where the keyboard
      // types a letter of another alphabet there (Cyrillic, Greek), or a
      // symbol on a digit key (a French keyboard, any keyboard with Shift),
      // there is no such key to find, and it goes by where that letter or
      // digit usually is. A French A, which types "a" from where Q usually
      // is, is still the key that says A. A letter's place that types a
      // mark (the comma where M usually is on a French keyboard, most of a
      // Dvorak one) is not that letter: its own key is somewhere else on
      // that keyboard, and two keys would hold the one action.
      const elsewhere = code.startsWith('digit') ? !LATIN.test(name) : A_LETTER.test(name) && !LATIN.test(name);
      const byPlace = code && elsewhere ? table.byPlace.get(code) : undefined;
      const found = [byCode, byName, byPlace].filter((list): list is string[] => list !== undefined);
      if (found.length === 0) return NO_ACTIONS;
      return found.length === 1 ? found[0] : [...new Set(found[0].concat(...found.slice(1)))];
    };
    // Where the key is on the keyboard: Shift changes what a key is called
    // between going down and coming up, and not where it is.
    const placeOf = (event: KeyboardEvent): string => event.code || String(event.key).toLowerCase();

    // A Mac sends no keyup for a key let go while Cmd is held: hold D, press
    // Cmd+S, let go of D, and D was held until it was pressed again. So when
    // the system key goes down or comes up, every key is let go. What a
    // gamepad or a pad on screen holds is not the keyboard's, and stays.
    const letGoOfKeys = () => {
      if (keyHeld.current.size === 0) return;
      keyHeld.current.clear();
      settle();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (isSystemKey(event)) letGoOfKeys();
      const actions = actionsOf(event);
      if (actions.length === 0 || !keyIsForApp(event, anchorRef.current)) return;
      // Kept from the browser, a held key's repeats included: each would
      // scroll the page a little further.
      event.preventDefault();
      if (event.repeat) return;
      const place = placeOf(event);
      for (const action of actions) {
        const by = keyHeld.current.get(action);
        if (by) by.add(place);
        else keyHeld.current.set(action, new Set([place]));
      }
      settle();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (isSystemKey(event)) letGoOfKeys();
      if (actionsOf(event).length > 0 && keyIsForApp(event, anchorRef.current)) event.preventDefault();
      // Let go wherever it comes up, in a field too, and with Alt held: the
      // key is no longer down.
      const place = placeOf(event);
      let any = false;
      for (const by of keyHeld.current.values()) any = by.delete(place) || any;
      if (any) settle();
    };

    const onHidden = () => {
      if (documentHidden()) releaseAll();
    };

    // First, before the page's own handlers: a key that is the game's is
    // cancelled before anything acts on it.
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    // A key held as the window loses focus has no keyup to come.
    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', releaseAll);
      document.removeEventListener('visibilitychange', onHidden);
      // No longer listening (hidden, turned off, gone): nothing is held.
      releaseAll();
    };
  }, [listening, table, settle, releaseAll]);

  // A gamepad, read once a frame while one is connected.
  const readsGamepad = gamepad !== false;
  React.useEffect(() => {
    if (!listening || !readsGamepad) return;
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return;
    if (typeof requestAnimationFrame !== 'function') return;
    const edge = typeof deadzone === 'number' && deadzone > 0 && deadzone < 1 ? deadzone : 0.4;
    let frame = 0;
    let stopped = false;
    /** The directions a stick holds, each as its gamepad and its action. */
    let sticks = new Set<string>();

    const read = () => {
      frame = 0;
      if (stopped) return;
      const pads = connectedGamepads();
      const now = new Set<string>();
      const pushed = new Set<string>();
      pads.forEach((pad, position) => {
        const down = (index: number) => {
          const button = pad.buttons[index];
          return !!button && (button.pressed || button.value > 0.5);
        };
        const which = typeof pad.index === 'number' ? pad.index : position;
        for (const action of table.actions) {
          const direction = DIRECTIONS[action];
          let held = false;
          if (direction) {
            // Two edges: the stick holds a direction once it is past the
            // deadzone, and until it has fallen clearly back under it.
            const along = (pad.axes[direction.axis] ?? 0) * direction.sign;
            const stick = `${which}:${action}`;
            if (along > edge || (sticks.has(stick) && along > edge * STICK_LET_GO)) {
              pushed.add(stick);
              held = true;
            } else {
              held = down(direction.button);
            }
          }
          if (held || (buttons.get(action) ?? []).some(down)) now.add(action);
        }
      });
      sticks = pushed;
      const before = padHeld.current;
      if (now.size !== before.size || [...now].some((action) => !before.has(action))) {
        padHeld.current = now;
        settle();
      }
      // With none connected there is nothing to read until one is.
      if (pads.length > 0) frame = requestAnimationFrame(read);
    };
    const start = () => {
      if (!stopped && frame === 0) frame = requestAnimationFrame(read);
    };

    window.addEventListener('gamepadconnected', start);
    window.addEventListener('gamepaddisconnected', start);
    start();
    return () => {
      stopped = true;
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener('gamepadconnected', start);
      window.removeEventListener('gamepaddisconnected', start);
      // No longer read (turned off, its buttons named anew, the controls
      // gone): what the gamepad held is let go. Nothing will read the button
      // coming up, and the action stayed held for good.
      if (padHeld.current.size > 0) {
        padHeld.current = new Set();
        settle();
      }
    };
  }, [listening, readsGamepad, table, buttons, deadzone, settle]);

  // Something to find the app's box from; never shown.
  return <span ref={anchorRef} hidden aria-hidden="true" data-softn-controls="" style={{ display: 'none' }} />;
}

export default Controls;
