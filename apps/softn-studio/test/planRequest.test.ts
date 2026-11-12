/**
 * What a line typed under "Revise the plan" asks of the plan's pages.
 *
 * "Remove the watering page" was kept as a note for the AI while the plan
 * went on listing the page, and "Add a page for plants and a page for
 * watering" became one page with the whole sentence as its name.
 */
import { describe, expect, it } from 'vitest';
import { planRequest } from '../src/lib/planRequest';

const PLAN = ['Home', 'Plants', 'Watering Schedule'];

describe('a line that adds pages', () => {
  it('adds the one page it names, as it always did', () => {
    expect(planRequest('Add a settings page', PLAN)).toEqual({ kind: 'add', names: ['Settings'], already: [] });
    expect(planRequest('add a page called Team stats.', PLAN)).toEqual({ kind: 'add', names: ['Team Stats'], already: [] });
    expect(planRequest('Please include an about screen', PLAN)).toEqual({ kind: 'add', names: ['About'], already: [] });
    expect(planRequest('add another page', PLAN)).toEqual({ kind: 'add', names: ['Page 4'], already: [] });
  });

  it('adds every page it names', () => {
    expect(planRequest('Add a page for plants care and a page for notes', PLAN)).toEqual({ kind: 'add', names: ['Plants Care', 'Notes'], already: [] });
    expect(planRequest('Add a settings page, a profile page and a help page', PLAN)).toEqual({ kind: 'add', names: ['Settings', 'Profile', 'Help'], already: [] });
    expect(planRequest('Add pages for Settings, Profile and Help', PLAN)).toEqual({ kind: 'add', names: ['Settings', 'Profile', 'Help'], already: [] });
    expect(planRequest('add settings and about pages', PLAN)).toEqual({ kind: 'add', names: ['Settings', 'About'], already: [] });
    expect(planRequest('Add a settings page and another page', ['Home'])).toEqual({ kind: 'add', names: ['Settings', 'Page 3'], already: [] });
  });

  it('keeps a name that has "and" in it as one page', () => {
    expect(planRequest('Add a terms and conditions page', PLAN)).toEqual({ kind: 'add', names: ['Terms And Conditions'], already: [] });
  });

  it('counts pages it does not name, skipping numbers the plan has', () => {
    expect(planRequest('Add two pages', ['Home'])).toEqual({ kind: 'add', names: ['Page 2', 'Page 3'], already: [] });
    expect(planRequest('add 2 more pages', ['Home', 'Page 2'])).toEqual({ kind: 'add', names: ['Page 3', 'Page 4'], already: [] });
  });

  it('says which of the pages it names the plan already has, and adds the rest', () => {
    expect(planRequest('Add a plants page and a notes page', PLAN)).toEqual({ kind: 'add', names: ['Notes'], already: ['Plants'] });
    expect(planRequest('Add a HOME page', PLAN)).toEqual({ kind: 'add', names: [], already: ['HOME'] });
    expect(planRequest('Add a notes page and a Notes page', PLAN)).toEqual({ kind: 'add', names: ['Notes'], already: ['Notes'] });
  });
});

describe('a line that removes pages', () => {
  it('removes the page it names, by the plan’s name for it', () => {
    expect(planRequest('Remove the plants page', PLAN)).toEqual({ kind: 'remove', names: ['Plants'] });
    expect(planRequest('delete the page called Plants.', PLAN)).toEqual({ kind: 'remove', names: ['Plants'] });
    expect(planRequest('Drop Plants', PLAN)).toEqual({ kind: 'remove', names: ['Plants'] });
    expect(planRequest('I don’t need the plants screen', PLAN)).toEqual({ kind: 'remove', names: ['Plants'] });
    expect(planRequest('No plants page', PLAN)).toEqual({ kind: 'remove', names: ['Plants'] });
  });

  it('finds the one page whose name holds the words, when the line says "page"', () => {
    expect(planRequest('Remove the watering page', PLAN)).toEqual({ kind: 'remove', names: ['Watering Schedule'] });
    // Without the word, only the page's whole name will do: "remove the watering" may be about anything.
    expect(planRequest('Remove the watering', PLAN)).toEqual({ kind: 'note' });
    // Two pages hold the word: neither is guessed at.
    expect(planRequest('Remove the list page', ['Home', 'Reading List', 'Wish List'])).toEqual({ kind: 'note' });
  });

  it('removes every page it names', () => {
    expect(planRequest('Remove the plants and watering pages', PLAN)).toEqual({ kind: 'remove', names: ['Plants', 'Watering Schedule'] });
    expect(planRequest('remove the plants page and the watering schedule page', PLAN)).toEqual({ kind: 'remove', names: ['Plants', 'Watering Schedule'] });
  });

  it('is a note when the plan has no such page: it is about something else', () => {
    expect(planRequest('Remove the delete button from the home page', PLAN)).toEqual({ kind: 'note' });
    expect(planRequest('Remove the settings page', PLAN)).toEqual({ kind: 'note' });
    expect(planRequest('No ads', PLAN)).toEqual({ kind: 'note' });
  });
});

describe('anything else', () => {
  it('is a note', () => {
    for (const text of ['The home page lists notes newest first', 'Make the home page blue', 'Use big buttons', 'People sign in with a link sent by email', 'ログインを追加', 'Add a dark theme', '   ']) {
      expect(planRequest(text, PLAN)).toEqual({ kind: 'note' });
    }
  });
});
