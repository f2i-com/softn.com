/**
 * The Texas Hold'em client at an online table.
 *
 * Two client runtimes (the bundle's logic in a Node VM, as in
 * test-texasholdem-gameplay.cjs) talk to one authority runtime
 * (server/authority.logic, as in test-texasholdem-authority.cjs) through a
 * fake `softn.net.fetch` that dispatches to the handlers in-process. What
 * is pinned: the lobby's create and join reach the table; each client's
 * globals carry its own two cards and card backs for everyone else's;
 * nothing is written to the local database; the action buttons send
 * actions and the server's refusals become toasts; the results modal opens
 * at the showdown; a reload resumes the seat; leaving revokes it.
 *
 * Usage: node scripts/test-texasholdem-authority-client.cjs
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');

const bundle = path.resolve(__dirname, '../bundles/TexasHoldem');
const read = (rel) => fs.readFileSync(path.join(bundle, rel), 'utf8');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A tiny record store: the shape of `db` on both the client and the server. */
function makeDb() {
  const tables = {};
  let n = 1;
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const ensure = (c) => (tables[c] = tables[c] || []);
  return {
    query: (c) => ensure(c).map((r) => ({ id: r.id, data: clone(r.data) })),
    get: (c, id) => {
      const r = ensure(c).find((x) => x.id === id);
      return r ? { id: r.id, data: clone(r.data) } : null;
    },
    create: (c, d) => {
      const r = { id: 'rec_' + n++, data: clone(d || {}) };
      ensure(c).push(r);
      return { id: r.id, data: clone(r.data) };
    },
    update: (id, patch) => {
      for (const c of Object.keys(tables)) {
        const r = tables[c].find((x) => x.id === id);
        if (r) {
          Object.assign(r.data, clone(patch || {}));
          return { id: r.id, data: clone(r.data) };
        }
      }
      return null;
    },
    updateIf: (id, patch, field, expected) => {
      for (const c of Object.keys(tables)) {
        const r = tables[c].find((x) => x.id === id);
        if (r) {
          if (JSON.stringify(r.data[field] === undefined ? null : r.data[field]) !== JSON.stringify(expected === undefined ? null : expected)) {
            return { updated: false, reason: 'conflict' };
          }
          Object.assign(r.data, clone(patch || {}));
          return { updated: true, record: { id: r.id, data: clone(r.data) } };
        }
      }
      return { updated: false, reason: 'missing' };
    },
    delete: (id) => {
      for (const c of Object.keys(tables)) {
        const i = tables[c].findIndex((x) => x.id === id);
        if (i >= 0) return tables[c].splice(i, 1) && true;
      }
      return false;
    },
    hardDelete: (c, id) => {
      const i = ensure(c).findIndex((x) => x.id === id);
      if (i >= 0) tables[c].splice(i, 1);
    },
    startSync() {},
    stopSync() {},
    getSavedSyncRoom: () => '',
    getSyncStatus: () => ({ connected: false, peers: 0 }),
    _tables: tables,
  };
}

function loadAuthority(seed) {
  const source = ['logic/cards.logic', 'server/rules.logic', 'server/authority.logic'].map(read).join('\n');
  const db = makeDb();
  const clock = { now: 5_000_000 };
  const mathObj = {};
  for (const k of Object.getOwnPropertyNames(Math)) mathObj[k] = Math[k];
  mathObj.random = mulberry32(seed);
  const context = { console, JSON, Math: mathObj, Date: { now: () => clock.now }, db, Object };
  context.globalThis = context;
  const ctx = vm.createContext(context);
  vm.runInContext(source, ctx, { filename: 'authority.js' });
  ctx.db = db;
  ctx.clock = clock;
  return ctx;
}

const ROUTES = {
  'POST /api/rooms': 'roomCreate',
  'POST /api/rooms/join': 'roomJoin',
  'POST /api/rooms/view': 'roomView',
  'POST /api/rooms/act': 'roomAct',
  'POST /api/rooms/leave': 'roomLeave',
};

/** `softn.net.fetch` as the runtime provides it, answered by the authority in-process. */
function fetchTo(authority, log) {
  return function (url, options, callback) {
    const method = (options && options.method) || 'GET';
    const pathname = url.replace(/^https?:\/\/[^/]+/, '');
    const handler = ROUTES[`${method} ${pathname}`];
    log.push(`${method} ${pathname}`);
    if (!handler) {
      callback({ ok: false, status: 404, body: JSON.stringify({ ok: false, error: { code: 'NO_ROUTE' } }) });
      return;
    }
    const request = JSON.parse(JSON.stringify({ method, path: pathname, body: options && options.body ? options.body : null, query: {}, headers: {} }));
    const r = authority[handler](request);
    const reply = JSON.parse(JSON.stringify({ status: r.status, body: r.body }));
    callback({ ok: reply.status < 400, status: reply.status, body: JSON.stringify(reply.body) });
  };
}

function loadClient(name, authority, storage, log) {
  const files = ['main.logic', 'cards.logic', 'engine.logic', 'game.logic', 'actions.logic', 'bot.logic', 'ui-helpers.logic', 'authority-client.logic'];
  let source = '';
  for (const f of files) source += '\n' + read('logic/' + f).replace(/^\s*import\s+['"][^'"]+['"]\s*;?\s*$/gm, '') + '\n';
  const db = makeDb();
  const context = {
    console,
    JSON,
    Object,
    db,
    Date,
    Math,
    parseInt,
    navigator: { clipboard: { writeText() {} } },
    localStorage: {
      getItem: (k) => (Object.hasOwn(storage, k) ? storage[k] : ''),
      setItem: (k, v) => {
        storage[k] = '' + v;
      },
    },
    window: { innerWidth: 1200, innerHeight: 800, addEventListener() {}, removeEventListener() {}, preloadSoundFromAsset: () => ({ ok: true }), playSoundFromAsset: () => ({ ok: true }) },
    softn: { net: { fetch: fetchTo(authority, log) } },
  };
  context.globalThis = context;
  const ctx = vm.createContext(context);
  vm.runInContext(source, ctx, { filename: `client-${name}.js` });
  ctx.db = db;
  ctx._init();
  ctx.setPlayerName(name);
  return ctx;
}

/** A few poll ticks: the client asks the server every third tick. */
function tick(client, n = 3) {
  for (let i = 0; i < n; i++) client.pollGameState();
}

// The bundle's `let` globals live in the script's own scope, not on the
// context object, so they are read and written by evaluating in it.
function get(client, name) {
  const v = vm.runInContext(name, client);
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}
function set(client, name, value) {
  vm.runInContext(`${name} = ${JSON.stringify(value)}`, client);
}

function main() {
  const authority = loadAuthority(31);
  const log = [];
  const annStorage = {};
  const bobStorage = {};
  const ann = loadClient('Ann', authority, annStorage, log);
  const bob = loadClient('Bob', authority, bobStorage, log);

  // Create and join, from the lobby.
  ann.createOnlineTable();
  assert.equal(get(ann, 'authorityMode'), true);
  assert.equal(get(ann, 'currentPage'), 'table');
  assert.match(get(ann, 'authorityCode'), /^t-/);
  assert.equal(get(ann, 'syncRoom'), get(ann, 'authorityCode'), 'the top bar shows the table code');
  assert.equal(get(ann, 'mySeat'), 0);
  set(bob, 'authorityJoinCode', ' ' + get(ann, 'authorityCode') + ' ');
  bob.joinOnlineTable();
  assert.equal(get(bob, 'authorityMode'), true);
  assert.equal(get(bob, 'mySeat'), 1);
  tick(ann);
  assert.equal(get(ann, 'players').length, 2, 'Ann sees Bob arrive');
  assert.equal(get(ann, 'isHost'), true, 'anyone seated may deal');
  assert.equal(get(ann, 'syncPeers'), 1);
  console.log('PASS: create and join from the lobby');

  // Deal: each client holds its own cards, and backs for the other's.
  ann.startHand();
  tick(ann);
  tick(bob);
  assert.equal(get(ann, 'gamePhase'), 'preflop');
  assert.equal(get(bob, 'gamePhase'), 'preflop');
  assert.equal(get(ann, 'myHoleCards').length, 2);
  assert.equal(get(bob, 'myHoleCards').length, 2);
  assert.notDeepEqual(get(ann, 'myHoleCards'), get(bob, 'myHoleCards'));
  const annSeesBob = get(ann, 'players').find((p) => p.data.seat === 1);
  const bobSeesAnn = get(bob, 'players').find((p) => p.data.seat === 0);
  assert.deepEqual(annSeesBob.data.holeCards, [-1, -1], "Bob's cards reach Ann as card backs");
  assert.deepEqual(bobSeesAnn.data.holeCards, [-1, -1], "Ann's cards reach Bob as card backs");
  assert.equal(ann.seatCard1(1), -1, 'and the table draws a back');
  assert.equal(ann.seatCard1(0), get(ann, 'myHoleCards')[0], 'and her own card');
  const truth = authority.db.query('rooms')[0].data.state;
  assert.deepEqual(get(bob, 'myHoleCards'), truth.seats[1].holeCards);
  for (const client of [ann, bob]) {
    assert.equal((client.db._tables.poker_players || []).length, 0, 'no player record is written locally');
    assert.equal((client.db._tables.poker_table || []).length, 0, 'no table record is written locally');
  }
  assert.equal(JSON.stringify(get(ann, 'players')).includes(JSON.stringify(truth.seats[1].holeCards)), false, "Bob's cards are nowhere in Ann's state");
  console.log('PASS: each client holds its own cards and card backs for the others');

  // Actions go to the server; refusals come back as toasts.
  const turnOf = () => (get(ann, 'currentTurnSeat') === 0 ? ann : bob);
  const notTurn = () => (get(ann, 'currentTurnSeat') === 0 ? bob : ann);
  const waiting = notTurn();
  set(waiting, 'actionBusyUntilMs', 0);
  waiting.doCall();
  assert.equal(get(waiting, 'toastMessage'), 'Not your turn');
  const acting = turnOf();
  set(acting, 'actionBusyUntilMs', 0);
  const revisionBefore = get(acting, 'authorityRevision');
  acting.doCheck();
  assert.equal(get(acting, 'toastMessage'), 'Cannot check, must call or raise', 'facing the big blind');
  set(acting, 'actionBusyUntilMs', 0);
  acting.doCall();
  assert.equal(get(acting, 'authorityRevision'), revisionBefore + 1, 'the call was accepted and the view moved');
  tick(ann);
  tick(bob);
  assert.equal(get(ann, 'currentTurnSeat'), get(bob, 'currentTurnSeat'), 'both see the same turn');
  console.log('PASS: actions are judged by the server');

  // Play the hand out with calls and checks; the results modal opens at the showdown.
  let guard = 0;
  while (get(ann, 'gamePhase') !== 'showdown' && guard++ < 40) {
    const c = turnOf();
    set(c, 'actionBusyUntilMs', 0);
    if (c.canCheck()) c.doCheck();
    else c.doCall();
    tick(ann);
    tick(bob);
  }
  assert.equal(get(ann, 'gamePhase'), 'showdown');
  assert.equal(get(bob, 'gamePhase'), 'showdown');
  assert.equal(get(ann, 'showResultsModal'), true);
  assert.ok(get(ann, 'resultWinnerName'), 'a winner is named');
  assert.ok(get(ann, 'resultSummary').includes('$'), 'the summary line reads');
  const shown = get(ann, 'players').filter((p) => p.data.showCardsAtShowdown);
  assert.equal(shown.length, 2, 'both hands were shown');
  assert.equal(get(bob, 'players').find((p) => p.data.seat === 0).data.holeCards[0], get(ann, 'myHoleCards')[0], "Ann's shown cards reach Bob at the showdown");
  console.log('PASS: the hand ends in a showdown both clients see');

  // Next hand, from the results modal. (The click lock from the last action
  // has lapsed by the time a person presses it; here the clock has not moved.)
  set(ann, 'actionBusyUntilMs', 0);
  ann.nextHand();
  tick(ann);
  tick(bob);
  assert.equal(get(ann, 'handNumber'), 2);
  assert.equal(get(ann, 'showResultsModal'), false);
  assert.equal(get(bob, 'myHoleCards').length, 2);
  console.log('PASS: the next hand is dealt on request');

  // A reload resumes the seat.
  const ann2 = loadClient('Ann', authority, annStorage, log);
  assert.equal(get(ann2, 'authorityMode'), true, 'the ticket was kept');
  assert.equal(get(ann2, 'currentPage'), 'table');
  assert.equal(get(ann2, 'mySeat'), 0);
  assert.deepEqual(get(ann2, 'myHoleCards'), get(ann, 'myHoleCards'));
  console.log('PASS: a reload resumes the seat');

  // Leaving revokes the seat and returns to the lobby.
  bob.leaveLobby();
  assert.equal(get(bob, 'authorityMode'), false);
  assert.equal(get(bob, 'currentPage'), 'lobby');
  assert.equal(bobStorage['poker-authority'], '');
  tick(ann);
  assert.equal(get(ann, 'players').find((p) => p.data.seat === 1).data.status, 'folded', 'Bob folded out of the hand');
  const bobAgain = loadClient('Bob', authority, bobStorage, log);
  assert.equal(get(bobAgain, 'authorityMode'), false, 'a revoked ticket is not resumed');
  assert.equal(get(bobAgain, 'currentPage'), 'lobby');
  console.log('PASS: leaving revokes the seat');

  // The peer table is untouched by any of this.
  const solo = loadClient('Solo', loadAuthority(1), {}, []);
  solo.createRoom();
  assert.equal(get(solo, 'authorityMode'), false);
  assert.equal(get(solo, 'currentPage'), 'table');
  assert.equal(solo.db._tables.poker_table.length, 1, 'the peer table still writes its records');
  console.log('PASS: the peer table is as it was');

  assert.ok(log.every((l) => l.startsWith('POST /api/rooms')), 'every request went to the authority');
  console.log('TexasHoldem authority client tests passed');
}

main();
