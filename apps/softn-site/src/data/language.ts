export interface Sample {
  id: string;
  name: string;
  hint: string;
  file: string;
  source: string;
}

export const SAMPLES: Sample[] = [
  {
    id: 'structure',
    name: 'Structure',
    hint: 'tags and props',
    file: 'ui/main.ui',
    source: `<App theme="dark">
  <Stack direction="vertical" gap="md" padding="lg">
    <Heading level={1}>Today</Heading>

    // Props take a string, or an expression in braces.
    <Text color={isDark ? "white" : "black"}>{greeting}</Text>

    <Card padding="md">
      <Grid columns={3} gap="sm">
        <Badge variant="success">Done</Badge>
        <Badge variant="warning">Waiting</Badge>
        <Badge>Later</Badge>
      </Grid>
    </Card>
  </Stack>
</App>`,
  },
  {
    id: 'flow',
    name: 'Control flow',
    hint: '#if, #each',
    file: 'ui/pages/Tasks.ui',
    source: `#if (isLoggedIn)
  <Dashboard user={currentUser} />
#else
  <LoginForm @submit={signIn} />
#end

// Every loop can say what an empty result looks like,
// so the blank state is part of the markup, not an
// afterthought somewhere in the logic.
#each (task in tasks)
  <TaskCard task={task} @done={complete} />
#empty
  <EmptyState
    title="Nothing due today"
    description="Anything you add shows up here."
  />
#end`,
  },
  {
    id: 'binding',
    name: 'Binding',
    hint: ':bind, @click',
    file: 'ui/modals/AddClient.ui',
    source: `// @ sends an event out. : binds a value both ways.
<Form @submit={save}>
  <Input :bind={name} placeholder="Full name" />
  <Input :bind={email} type="email" placeholder="Email" />
  <Switch :bind={sendReminders} label="Send reminders" />
  <Slider :bind={visits} min={0} max={50} />

  <Button variant="primary" @click={save} disabled={!name}>
    Save client
  </Button>
</Form>`,
  },
  {
    id: 'logic',
    name: 'Logic',
    hint: '.logic and the database',
    file: 'logic/main.logic',
    source: `// Real JavaScript — classes, async/await, destructuring,
// closures, regex — running on zipp, a register VM written
// in Rust and compiled to WebAssembly. No eval, no host.
let clients = []

function _init() {
  clients = db.query("clients")
}

function addClient(name, email) {
  db.create("clients", { name: name, email: email })
  clients = db.query("clients")
}

// XDB keeps everything in memory, so reads and writes are
// synchronous. Sync is the only thing you have to await.
async function share(room) {
  await db.startSync(room)
}`,
  },
  {
    id: 'smart',
    name: 'Smart components',
    hint: 'a table from one line',
    file: 'ui/pages/Clients.ui',
    source: `// Point one at a collection and it reads the shape from
// the data: columns, types, validation, empty state.
<SmartGrid
  collection="clients"
  columns="name, email, phone, visits"
  searchable sortable pageable
  editable deletable
  @edit={editClient}
  @delete={removeClient}
/>

<SmartForm
  collection="clients"
  fields="name:text:required, email:email:required, phone:text"
  submitText="Add client"
  @saved={closeModal}
/>`,
  },
];
