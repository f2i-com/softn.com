// The home page's state. `currentPage` is what the NavItems with `page="…"`
// set, and what the page's `#if` blocks show.
export let currentPage = 'overview'
export let clicks = 0
export let draft = ''
export let notes = [{ id: 1, text: 'Written as HTML, run by SoftN.' }]

export function addNote() {
  if (draft.trim() === '') return
  notes = [...notes, { id: notes.length + 1, text: draft.trim() }]
  draft = ''
}
