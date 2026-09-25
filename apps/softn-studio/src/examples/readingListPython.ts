import type { ExampleProject } from './index';

/**
 * The reading list again, with its logic in Python.
 *
 * The same shell, pages and collection as READING_LIST, so the two can be
 * compared file by file: what changes is only what a Python app changes.
 * Its logic is two `.py` files referenced with `<logic src>` — never inline,
 * since Python's indentation is the program — and each is a module named
 * after its file, so `main.py` reaches the helper with `from shelf import
 * plural`. The helper is listed first in the manifest's logic group, which is
 * the order the runtime loads helpers in. It is also the fixture Studio's
 * tests use for everything a Python project touches: import, preview,
 * validation and export.
 */
export const READING_LIST_PYTHON: ExampleProject = {
  id: 'reading-list-python',
  name: 'Reading list in Python (example)',
  description: 'The reading list with its logic written in Python. Open it, change the goal, run it, export it.',
  files: [
    {
      path: 'manifest.json',
      content: JSON.stringify(
        {
          name: 'Reading list (Python)',
          version: '1.0.0',
          description: 'A small example app whose logic is Python: a list of books to read, with a reading goal.',
          main: 'ui/main.ui',
          target: 'web',
          files: {
            ui: ['ui/main.ui', 'ui/pages/home.ui', 'ui/pages/about.ui'],
            logic: ['logic/shelf.py', 'logic/main.py'],
            xdb: ['xdb/books.xdb'],
            assets: [],
          },
          config: { theme: { mode: 'light' } },
          pages: [
            { id: 'home-page', name: 'Home', path: 'ui/pages/home.ui', route: '/' },
            { id: 'about-page', name: 'About', path: 'ui/pages/about.ui', route: '/about' },
          ],
        },
        null,
        2,
      ),
    },
    {
      // Nothing declared: the app gets no capability until this says otherwise.
      path: 'permission.json',
      content: JSON.stringify({ permissions: {} }, null, 2),
    },
    {
      path: 'ui/main.ui',
      content: `<import HomePage from="./pages/home.ui" />
<import AboutPage from="./pages/about.ui" />

<data>
  <collection name="books" as="books" />
</data>

<logic src="../logic/main.py" />

<App theme="light" title={appName}>
  <Container size="lg">
    <Stack direction="vertical" gap="lg" padding="xl">
      <Stack direction="horizontal" gap="md" align="center" wrap>
        <Heading level={1} class="brand">{appName}</Heading>
        <Spacer />
        #each (item in pages)
          <Button variant={page === item.id ? "primary" : "ghost"} size="sm" @click={() => go(item.id)}>{item.label}</Button>
        #end
      </Stack>
      <Text variant="muted">{appDescription}</Text>
      #if (page === "home")
        <HomePage />
      #end
      #if (page === "about")
        <AboutPage />
      #end
    </Stack>
  </Container>
</App>

<style>
  .brand { color: #2563eb; }
</style>
`,
    },
    {
      path: 'ui/pages/home.ui',
      content: `<Stack direction="vertical" gap="md">
  <Heading level={2}>Home</Heading>
  <Text variant="muted">Books to read, from the books collection. The goal below lives in logic/main.py.</Text>
  <Card title="Reading goal">
    <Stack direction="horizontal" gap="md" align="center" wrap>
      <Text>{goal_label()}</Text>
      <Button variant="secondary" size="sm" @click={() => raise_goal()}>One more</Button>
    </Stack>
  </Card>
  <Card title="Books">
    #each (item in books)
      <Stack direction="horizontal" gap="md" align="center" wrap>
          <Text>{item.data.title}</Text>
          <Text>{item.data.author}</Text>
          <Text>{item.data.status}</Text>
      </Stack>
    #empty
      <EmptyState title="Nothing here yet" description="Records in this collection will appear here." />
    #end
  </Card>
</Stack>
`,
    },
    {
      path: 'ui/pages/about.ui',
      content: `<Stack direction="vertical" gap="md">
  <Heading level={2}>About</Heading>
  <Text variant="muted">This example is the reading list with its logic written in Python. The markup is the same; the logic is two .py files, each a module named after its file.</Text>
  <Card title="What to try">
    <List>
      <ListItem>Change the starting goal in logic/main.py and watch the preview.</ListItem>
      <ListItem>Press Run to open the app in the SoftN runtime.</ListItem>
      <ListItem>Press Export bundle to download it as a .softn file.</ListItem>
    </List>
  </Card>
</Stack>
`,
    },
    {
      path: 'logic/shelf.py',
      content: `# A helper module. Its name is its file name: main.py imports it as \`shelf\`.


def plural(count, word):
    if count == 1:
        return "1 " + word
    return str(count) + " " + word + "s"
`,
    },
    {
      path: 'logic/main.py',
      content: `# The app shell: which page is showing, and the names the shell displays.
# Every top-level name is state the template reads, and every def is a
# function it can call.
from shelf import plural

appName = "Reading list"
appDescription = "A small example app, with its logic in Python: a list of books to read."
pages = [{"id": "home", "label": "Home"}, {"id": "about", "label": "About"}]
page = "home"
goal = 12


def go(page_id):
    # Assigning a module-level name needs \`global\`; without it Python
    # would make a local and the page would never change.
    global page
    page = page_id


def raise_goal():
    global goal
    goal = goal + 1


def goal_label():
    return "Goal: " + plural(goal, "book") + " this year"
`,
    },
    {
      path: 'xdb/books.xdb',
      content: JSON.stringify(
        {
          collection: 'books',
          records: [
            { id: '1', title: 'The Left Hand of Darkness', author: 'Ursula K. Le Guin', status: 'reading' },
            { id: '2', title: 'Piranesi', author: 'Susanna Clarke', status: 'next' },
          ],
        },
        null,
        2,
      ),
    },
  ],
};
