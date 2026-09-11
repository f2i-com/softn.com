import type { ExampleProject } from './index';

/**
 * The example a first visit can open: a small, complete .softn-shaped
 * project with one collection and two pages. Every file is written out
 * here rather than generated, so what a novice opens is exactly what is
 * reviewed, and it does not change when the scaffold does. Its shapes are
 * the scaffold's — the same shell, the same `<data>` binding, the same
 * flat record form in the .xdb — because those are the shapes the runtime
 * is known to open.
 */
export const READING_LIST: ExampleProject = {
  id: 'reading-list',
  name: 'Reading list (example)',
  description: 'A small app that keeps a list of books to read. Open it, change a label, run it, export it.',
  files: [
    {
      path: 'manifest.json',
      content: JSON.stringify(
        {
          name: 'Reading list',
          version: '1.0.0',
          description: 'A small example app: a list of books to read, with a page about the app.',
          main: 'ui/main.ui',
          target: 'web',
          files: {
            ui: ['ui/main.ui', 'ui/pages/home.ui', 'ui/pages/about.ui'],
            logic: ['logic/main.logic'],
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

<logic src="../logic/main.logic" />

<App theme="light" title={appName}>
  <Container maxWidth="960px">
    <Stack direction="vertical" gap="lg" padding="xl">
      <Stack direction="horizontal" gap="md" align="center" wrap>
        <Heading level={1} class="brand">{appName}</Heading>
        <Spacer />
        #each (item in pages)
          <Button variant={page === item.id ? "primary" : "ghost"} size="sm" @click={() => go(item.id)}>{item.label}</Button>
        #end
      </Stack>
      <Text color="muted">{appDescription}</Text>
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
  <Text color="muted">Books to read, from the books collection. Change this text, then Run the app to see it.</Text>
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
  <Text color="muted">This is the example project that ships with Studio. It is a complete .softn bundle: a manifest, a permission declaration, two pages, one logic file and one collection.</Text>
  <Card title="What to try">
    <List>
      <ListItem>Change a label on the Home page and watch the preview.</ListItem>
      <ListItem>Press Run to open the app in the SoftN runtime.</ListItem>
      <ListItem>Press Export bundle to download it as a .softn file.</ListItem>
    </List>
  </Card>
</Stack>
`,
    },
    {
      path: 'logic/main.logic',
      content: `// The app shell: which page is showing, and the names the shell displays.
let appName = "Reading list"
let appDescription = "A small example app: a list of books to read."
let pages = [{"id":"home","label":"Home"},{"id":"about","label":"About"}]
let page = "home"

function go(id) {
  page = id
}

function _init() {
  console.log(appName + " initialized")
}
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
