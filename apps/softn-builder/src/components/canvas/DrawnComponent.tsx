/**
 * A component of the app, drawn on the canvas as itself.
 *
 * The canvas drew ten components by hand and every other as a card with its
 * name on it. One the registry marks as `drawn` (componentRegistry.ts,
 * DRAWN_FOR_REAL) is mounted here from the same library the app runs on,
 * inside one wrapper that keeps it a picture:
 *
 *  - It is `inert`, with no pointer events anywhere in it (builder.css): it
 *    takes no click, no focus and no key, so selecting, dragging and
 *    dropping are the canvas element's around it, as for a hand-drawn one.
 *  - It is given only what utils/drawnProps.ts allows: nothing is evaluated
 *    and no handler is passed.
 *  - A component that throws, or draws nothing at all, is replaced by the
 *    stand-in the canvas drew before, and takes nothing else down with it.
 *  - It is drawn in the app's own colours, not the editor's: the app's light
 *    theme today, whatever the project's (utils/drawnTheme.ts says why).
 *
 * The theme has the two layers it has in a running app, kept away from the
 * editor's own document:
 *
 *  - The tokens, which the runtime's ThemeProvider writes on `:root` with a
 *    page's worth of global rules. Here they are one rule for each side,
 *    reached by the attribute a wrapper carries (DrawnThemeStyle), and the
 *    few global rules a component leans on are in builder.css under the
 *    same attribute.
 *  - The page's own colours and type, which `<App>` sets on its container
 *    and in a stylesheet written against its own classes. One real `<App>`
 *    for each side is mounted out of sight for that stylesheet, and every
 *    wrapper is given a page that is what those containers are: their
 *    classes and their inline style, read from them and not copied here.
 *    An `<App>` around each component was the first way, and was a
 *    stylesheet for each: three hundred elements took four frames to change
 *    one of them.
 *
 * The wrapper itself starts from `all: initial` (builder.css), so nothing of
 * the editor's type or colour is inherited into the component.
 */

import React, { createContext, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { App, builtinComponents, darkTheme, lightTheme, themeToCssVariables } from '@softn/components';
import type { CanvasElement, ComponentMeta } from '../../types/builder';
import { drawnProps } from '../../utils/drawnProps';
import type { DrawnTheme, ThemeSide } from '../../utils/drawnTheme';

/** What an `<App>` of one side makes of its container: the page a component is drawn in. */
interface DrawnPage {
  className: string;
  style: React.CSSProperties;
}

interface DrawnSurroundings {
  theme: DrawnTheme;
  /** The pages of both sides, once they have been read; a wrapper on its own has none. */
  pages: Record<ThemeSide, DrawnPage> | null;
}

const DrawnContext = createContext<DrawnSurroundings>({ theme: { tokens: 'light', page: 'light' }, pages: null });

const components = builtinComponents as unknown as Record<string, React.ComponentType<Record<string, unknown>> | undefined>;

function tokensRule(side: ThemeSide): string {
  // themeToCssVariables refuses a name or a value that could close the rule.
  const declarations = Object.entries(themeToCssVariables(side === 'dark' ? darkTheme : lightTheme))
    .map(([name, value]) => `${name}:${value}`)
    .join(';');
  return `[data-softn-drawn="${side}"]{${declarations}}`;
}

let tokensCss: string | null = null;

/** The container an `<App>` drew, as a page a wrapper can be given. */
function pageOf(holder: Element | null): DrawnPage | null {
  const container = holder?.querySelector<HTMLElement>(':scope > div');
  if (!container) return null;
  // As written, one declaration at a time: asked for by name, a shorthand
  // whose value is a variable (`background: var(--color-bg)`) gives back
  // nothing for each of its parts.
  const style: Record<string, string> = {};
  for (const declaration of (container.getAttribute('style') ?? '').split(';')) {
    const colon = declaration.indexOf(':');
    if (colon === -1) continue;
    const name = declaration.slice(0, colon).trim();
    const value = declaration.slice(colon + 1).trim();
    if (name === '' || value === '') continue;
    style[name.startsWith('--') ? name : name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
  }
  // The app's page is one screen high and cuts off what is below; a page
  // around one component is as high as the component, with room for its
  // shadow or ring and for the page's colour to show behind it.
  return { className: container.className, style: { ...style, width: 'auto', height: 'auto', padding: 8, borderRadius: 6 } as React.CSSProperties };
}

/**
 * The app's theme for everything drawn inside: its tokens for both sides,
 * each under the attribute a wrapper carries; the stylesheets of a light and
 * a dark `<App>`; and which side this canvas is drawn in. Rendered once, by
 * the canvas.
 */
export function DrawnThemeProvider({ theme, children }: { theme: DrawnTheme; children?: React.ReactNode }): React.ReactElement {
  const light = useRef<HTMLDivElement>(null);
  const dark = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<Record<ThemeSide, DrawnPage> | null>(null);
  tokensCss ??= `${tokensRule('light')}\n${tokensRule('dark')}`;

  // Before anything is painted: what an App is does not change while it is mounted.
  useLayoutEffect(() => {
    const read = { light: pageOf(light.current), dark: pageOf(dark.current) };
    if (read.light && read.dark) setPages({ light: read.light, dark: read.dark });
  }, []);

  const surroundings = useMemo(() => ({ theme, pages }), [theme, pages]);
  return (
    <DrawnContext.Provider value={surroundings}>
      <style data-softn-drawn-tokens="">{tokensCss}</style>
      <div hidden aria-hidden="true" data-softn-drawn-pages="" style={{ display: 'none' }}>
        <div ref={light}>
          <App theme="light" />
        </div>
        <div ref={dark}>
          <App theme="dark" />
        </div>
      </div>
      {children}
    </DrawnContext.Provider>
  );
}

interface BoundaryProps {
  failed: () => void;
  children: React.ReactNode;
}

/** What the component threw is kept here: the stand-in is drawn, and the canvas goes on. */
class DrawnBoundary extends React.Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.warn('[Canvas] A component could not be drawn, and its stand-in is shown:', error);
    this.props.failed();
  }

  render(): React.ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/** `inert` as an attribute: this React does not know the property, and writes a string as given. */
const INERT = { inert: '' } as unknown as React.HTMLAttributes<HTMLDivElement>;

interface DrawnProps {
  element: CanvasElement;
  meta: ComponentMeta;
  /** What the canvas drew for this element before: shown when the component cannot be. */
  fallback: React.ReactNode;
}

/**
 * The component itself, as a picture of it. A change to what it is given
 * starts it again: one that threw for a value is tried with the next.
 */
export function DrawnComponent({ element, meta, fallback }: DrawnProps): React.ReactElement {
  const { theme, pages } = useContext(DrawnContext);
  const Component = components[element.componentType];
  const props = useMemo(() => drawnProps(element, meta), [element, meta]);
  // What it is given, as one text: the same again is the same attempt.
  const attempt = useMemo(() => {
    try {
      return JSON.stringify([element.componentType, props]);
    } catch {
      return element.id;
    }
  }, [element.componentType, element.id, props]);
  const content = useRef<HTMLDivElement>(null);
  // The attempt that could not be drawn: it threw, or there was nothing to see.
  const [standIn, setStandIn] = useState<string | null>(null);

  // A component with nothing to show (a Breadcrumb with no items) draws
  // nothing, and an element that cannot be seen cannot be found or picked
  // up: its stand-in is drawn in its place. Only where there is a layout to
  // measure.
  useLayoutEffect(() => {
    const node = content.current;
    if (!node || document.documentElement.clientWidth === 0) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    const box = range.getBoundingClientRect?.();
    // A Divider is a line one pixel high, and is something drawn.
    if (!box || box.height < 0.5 || box.width < 0.5) setStandIn(attempt);
  }, [attempt, theme, pages]);

  if (!Component || standIn === attempt) return <>{fallback}</>;
  const page = pages?.[theme.page];
  return (
    <div data-softn-drawn={theme.tokens} aria-hidden="true" {...INERT}>
      <div className={page?.className} style={page?.style} data-theme={theme.page}>
        <div ref={content} data-softn-drawn-content="" style={{ display: 'contents' }}>
          <DrawnBoundary key={attempt} failed={() => setStandIn(attempt)}>
            <Component {...props} />
          </DrawnBoundary>
        </div>
      </div>
    </div>
  );
}
