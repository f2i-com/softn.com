/**
 * The front door says what the product is: app logic in JavaScript or Python.
 * Python is highlighted as Python (a `#` is a comment there, and `#each`
 * everywhere else).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { Footer } from '../src/components/Footer';
import { StartWays } from '../src/components/home/StartWays';
import { WhyDifferent } from '../src/components/home/WhyDifferent';
import { highlight, languageOf } from '../src/lib/highlight';
import { runsLabel } from '../src/lib/format';

const text = (element: React.ReactElement) => renderToStaticMarkup(element).replace(/<[^>]+>/g, '').replace(/&#x27;|&rsquo;/g, '’');

it('names both logic languages wherever the site describes the engine', () => {
  expect(text(<Footer />)).toMatch(/engine for JavaScript\s+and Python/);
  expect(text(<StartWays />)).toContain('choose JavaScript or Python');
  expect(text(<WhyDifferent />)).toContain('logic is JavaScript or Python');
});

it('highlights Python as Python and SoftN markup as markup', () => {
  const classes = (source: string, lang?: 'python' | 'softn') =>
    highlight(source, lang).map((el) => [el.props.className as string, el.props.children as string]);
  expect(classes('# a comment\nx = 1', 'python')[0]).toEqual(['tok-com', '# a comment']);
  expect(classes('def train():\n    global loss', 'python').filter(([c]) => c === 'tok-mark').map(([, t]) => t)).toEqual(['def', 'global']);
  // The default rules keep `#each` a directive rather than a comment.
  expect(classes('#each (t in tasks)')[0]).toEqual(['tok-mark', '#each']);
  expect(languageOf('logic/main.py')).toBe('python');
  expect(languageOf('logic/main.logic')).toBe('softn');
});

it('agrees the noun with the run count', () => {
  expect(runsLabel(1)).toBe('1 run');
  expect(runsLabel(0)).toBe('0 runs');
  expect(runsLabel(12)).toBe('12 runs');
});
