/**
 * The Texas Hold'em table authority, driven the way its clients drive it.
 *
 * The server logic (server/authority.logic over server/rules.logic and
 * logic/cards.logic) is loaded into a Node VM with a fake `db`, a seeded
 * Math.random and a clock the test controls, and its route handlers are
 * called with request objects shaped as softn-server shapes them. Four or
 * more simulated clients then join, act, retry, reconnect and leave.
 *
 * What is pinned, from the audit's acceptance test for the finding: a
 * non-host client's view never contains another seat's hole cards or the
 * deck; a duplicated action has one effect and a reused id is refused; a
 * stale or out-of-turn action is refused with the current revision; an
 * absent player's turn is taken for them; leaving revokes the seat; an empty
 * table closes. And the poker invariants over many seeded hands: chips are
 * conserved, no card is dealt twice, every hand ends, and the same seed
 * deals the same game.
 *
 * Usage: node scripts/test-texasholdem-authority.cjs
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');

function makeDb() {
  const tables = {};
  let idCounter = 1;
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const ensure = (name) => {
    if (!tables[name]) tables[name] = [];
    return tables[name];
  };
  return {
    query(name) {
      return ensure(name).map((r) => ({ id: r.id, data: clone(r.data) }));
    },
    get(name, id) {
      const r = ensure(name).find((x) => x.id === id);
      return r ? { id: r.id, data: clone(r.data) } : null;
    },
    create(name, data) {
      const rec = { id: 'rec_' + idCounter++, data: clone(data || {}) };
      ensure(name).push(rec);
      return { id: rec.id, data: clone(rec.data) };
    },
    update(id, patch) {
      for (const name of Object.keys(tables)) {
        const r = tables[name].find((x) => x.id === id);
        if (r) {
          Object.assign(r.data, clone(patch || {}));
          return { id: r.id, data: clone(r.data) };
        }
      }
      return null;
    },
    /** The conditional write softn-server offers: commit only if `field` still equals `expected`. */
    updateIf(id, patch, field, expected) {
      for (const name of Object.keys(tables)) {
        const r = tables[name].find((x) => x.id === id);
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
    delete(id) {
      for (const name of Object.keys(tables)) {
        const i = tables[name].findIndex((x) => x.id === id);
        if (i >= 0) {
          tables[name].splice(i, 1);
          return true;
        }
      }
      return false;
    },
    hardDelete(name, id) {
      const i = ensure(name).findIndex((x) => x.id === id);
      if (i >= 0) tables[name].splice(i, 1);
    },
    _tables: tables,
  };
}

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

function loadAuthority(seed) {
  const bundle = path.resolve(__dirname, '../bundles/TexasHoldem');
  const files = ['logic/cards.logic', 'server/rules.logic', 'server/authority.logic'];
  let source = '';
  for (const f of files) source += '\n' + fs.readFileSync(path.join(bundle, f), 'utf8') + '\n';
  const db = makeDb();
  const clock = { now: 1_000_000 };
  const mathObj = {};
  for (const k of Object.getOwnPropertyNames(Math)) mathObj[k] = Math[k];
  mathObj.random = mulberry32(seed);
  const context = { console, JSON, Math: mathObj, Date: { now: () => clock.now }, db, Object, Array, String, Number };
  context.globalThis = context;
  const ctx = vm.createContext(context);
  vm.runInContext(source, ctx, { filename: 'texasholdem-authority.js' });
  ctx.db = db;
  ctx.clock = clock;
  return ctx;
}

/** The handlers as HTTP would call them: one request object in, {status, body} out. */
function api(ctx) {
  // Everything crosses as JSON, the way it crosses HTTP: the handler gets a
  // request built in the host realm, and its answer is re-read in the host
  // realm, so the assertions compare like with like.
  const call = (handler, body) => {
    const r = ctx[handler](JSON.parse(JSON.stringify({ method: 'POST', path: '/api/rooms', body, query: {}, headers: {} })));
    return JSON.parse(JSON.stringify({ status: r.status, body: r.body }));
  };
  let seq = 0;
  return {
    create: (name, maxPlayers) => call('roomCreate', maxPlayers ? { name, maxPlayers } : { name }),
    join: (code, name, role) => call('roomJoin', role ? { code, name, role } : { code, name }),
    view: (code, ticket) => call('roomView', ticket ? { code, ticket } : { code }),
    act: (code, ticket, expectedRevision, action, id) => call('roomAct', { code, ticket, id: id || 'a' + ++seq, expectedRevision, action }),
    raw: (handler, body) => call(handler, body),
    leave: (code, ticket) => call('roomLeave', { code, ticket }),
    /** The whole room as the authority holds it — what a client must never receive. */
    state: (code) => ctx.db.query('rooms').find((r) => r.data.code === code).data,
  };
}

function table(ctx, names, maxPlayers) {
  const a = api(ctx);
  const created = a.create(names[0], maxPlayers);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const code = created.body.code;
  const players = [{ name: names[0], ticket: created.body.ticket, seat: created.body.you.seat }];
  for (let i = 1; i < names.length; i++) {
    const j = a.join(code, names[i]);
    assert.equal(j.status, 200, JSON.stringify(j.body));
    players.push({ name: names[i], ticket: j.body.ticket, seat: j.body.you.seat });
  }
  return { a, code, players };
}

/** Play the current hand out with everyone calling or checking, until the showdown. */
function callDown(a, code, players, maxSteps = 60) {
  let steps = 0;
  while (steps++ < maxSteps) {
    const v = a.view(code).body;
    if (v.public.phase === 'showdown' || v.public.phase === 'waiting') return v;
    const seat = v.public.currentTurnSeat;
    const p = players.find((x) => x.seat === seat);
    assert.ok(p, 'the turn is on a seated player');
    const r = a.act(code, p.ticket, v.revision, { type: 'call' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  throw new Error('the hand did not end');
}

// ── Tests ─────────────────────────────────────────────────────────────

function testJoinLeaveAndCapacity() {
  const ctx = loadAuthority(1);
  const { a, code, players } = table(ctx, ['Ann', 'Bob', 'Cy', 'Di'], 4);
  const view = a.view(code, players[0].ticket).body;
  assert.equal(view.public.seats.filter(Boolean).length, 4);
  assert.equal(view.members.filter((m) => m.role === 'player').length, 4);
  const fifth = a.join(code, 'Ed');
  assert.equal(fifth.status, 409);
  assert.equal(fifth.body.error.code, 'ROOM_FULL');
  const watcher = a.join(code, 'TV', 'spectator');
  assert.equal(watcher.status, 200, 'a spectator still fits');
  assert.equal(watcher.body.you.role, 'spectator');
  assert.equal(watcher.body.you.seat, -1);

  const gone = a.leave(code, players[3].ticket);
  assert.equal(gone.status, 200);
  assert.equal(a.view(code).body.public.seats.filter(Boolean).length, 3);
  assert.equal(a.join(code, 'Ed').status, 200, 'the freed seat can be taken');
  assert.equal(a.join('nope-1', 'Zed').status, 404);
}

function testProjectionsHideCardsAndDeck() {
  const ctx = loadAuthority(2);
  const { a, code, players } = table(ctx, ['Ann', 'Bob', 'Cy', 'Di']);
  const tv = a.join(code, 'TV', 'spectator').body;
  const started = a.act(code, players[0].ticket, a.view(code).body.revision, { type: 'start' });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const truth = a.state(code).state;
  assert.equal(truth.deck.length, 52);

  for (const me of players) {
    const v = a.view(code, me.ticket).body;
    assert.equal(v.public.phase, 'preflop');
    assert.equal(v.you.holeCards.length, 2, `${me.name} sees two cards`);
    assert.deepEqual(v.you.holeCards, truth.seats[me.seat].holeCards, `${me.name} sees their own cards`);
    const text = JSON.stringify(v);
    assert.equal(text.includes('"deck"'), false, 'no deck in any view');
    assert.equal(text.includes('deckPosition'), false);
    for (const other of players) {
      if (other === me) continue;
      assert.deepEqual(v.public.seats[other.seat].holeCards, [], `${me.name} does not see ${other.name}'s cards`);
      assert.equal(v.public.seats[other.seat].cardsDealt, 2, 'but knows they were dealt');
    }
  }
  const watching = a.view(code, tv.ticket).body;
  assert.deepEqual(watching.you.holeCards, []);
  assert.equal(watching.public.seats.filter((s) => s && s.holeCards.length > 0).length, 0, 'the display sees no hole cards');
  const anonymous = a.view(code).body;
  assert.equal(anonymous.you, null);
  assert.equal(JSON.stringify(anonymous).includes('"deck"'), false);

  // At the showdown, only the cards of the hands that were shown appear; a
  // folded hand stays hidden.
  const first = a.view(code).body;
  const folder = players.find((p) => p.seat === first.public.currentTurnSeat);
  assert.equal(a.act(code, folder.ticket, first.revision, { type: 'fold' }).status, 200);
  const end = callDown(a, code, players);
  assert.equal(end.public.phase, 'showdown');
  assert.deepEqual(end.public.seats[folder.seat].holeCards, [], 'a folded hand is never shown');
  const shown = end.public.seats.filter((s) => s && s.holeCards.length === 2);
  assert.ok(shown.length >= 2, 'the contenders show');
  for (const s of shown) assert.deepEqual(s.holeCards, a.state(code).state.seats[s.seat].holeCards);
  assert.equal(JSON.stringify(end).includes('"deck"'), false);
}

function testDuplicateAndReusedActionIds() {
  const ctx = loadAuthority(3);
  const { a, code, players } = table(ctx, ['Ann', 'Bob']);
  assert.equal(a.act(code, players[0].ticket, a.view(code).body.revision, { type: 'start' }, 'deal').status, 200);
  const v = a.view(code).body;
  const seat = v.public.currentTurnSeat;
  const p = players.find((x) => x.seat === seat);
  const potBefore = v.public.pot;
  const first = a.act(code, p.ticket, v.revision, { type: 'call' }, 'call-1');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const again = a.act(code, p.ticket, v.revision, { type: 'call' }, 'call-1');
  assert.equal(again.status, 200, 'a retry is answered');
  assert.deepEqual(again.body.ack, first.body.ack, 'with the same ack');
  assert.equal(again.body.replayed, true);
  assert.equal(a.view(code).body.revision, first.body.ack.revision, 'and has no second effect');
  assert.equal(a.state(code).state.pot, potBefore + (v.public.currentBet - v.public.seats[seat].bet), 'the call was counted once');

  const reused = a.act(code, p.ticket, v.revision + 1, { type: 'fold' }, 'call-1');
  assert.equal(reused.status, 409);
  assert.equal(reused.body.error.code, 'ID_REUSED');
}

function testStaleRevision() {
  const ctx = loadAuthority(4);
  const { a, code, players } = table(ctx, ['Ann', 'Bob', 'Cy']);
  assert.equal(a.act(code, players[0].ticket, a.view(code).body.revision, { type: 'start' }).status, 200);
  const v = a.view(code).body;
  const p = players.find((x) => x.seat === v.public.currentTurnSeat);
  const old = a.act(code, p.ticket, v.revision - 1, { type: 'call' });
  assert.equal(old.status, 409);
  assert.equal(old.body.error.code, 'STALE_VIEW');
  assert.equal(old.body.revision, v.revision, 'the refusal says which revision to retry on');
  assert.ok(old.body.view, 'and carries a fresh view');
  const future = a.act(code, p.ticket, v.revision + 5, { type: 'call' });
  assert.equal(future.body.error.code, 'STALE_VIEW');
  assert.equal(a.view(code).body.revision, v.revision, 'nothing moved');
  // Two players decide on the same view: one commits, the other must refresh.
  const fine = a.act(code, p.ticket, v.revision, { type: 'call' });
  assert.equal(fine.status, 200);
  const other = players.find((x) => x.seat === a.view(code).body.public.currentTurnSeat);
  const lateOnOldView = a.act(code, other.ticket, v.revision, { type: 'call' });
  assert.equal(lateOnOldView.body.error.code, 'STALE_VIEW');
}

function testOutOfTurnSpectatorsAndMalformedMessages() {
  const ctx = loadAuthority(5);
  const { a, code, players } = table(ctx, ['Ann', 'Bob', 'Cy']);
  const tv = a.join(code, 'TV', 'spectator').body;
  assert.equal(a.act(code, players[0].ticket, a.view(code).body.revision, { type: 'start' }).status, 200);
  const v = a.view(code).body;
  const notTheirTurn = players.find((x) => x.seat !== v.public.currentTurnSeat);
  const out = a.act(code, notTheirTurn.ticket, v.revision, { type: 'call' });
  assert.equal(out.status, 403);
  assert.equal(out.body.error.code, 'NOT_YOUR_TURN');
  assert.equal(a.act(code, tv.ticket, v.revision, { type: 'call' }).body.error.code, 'NOT_A_PLAYER');
  assert.equal(a.act(code, 'not-a-ticket-at-all', v.revision, { type: 'call' }).body.error.code, 'NOT_MEMBER');
  const p = players.find((x) => x.seat === v.public.currentTurnSeat);
  for (const bad of [
    { code, ticket: p.ticket },
    { code, ticket: p.ticket, id: 'x', expectedRevision: v.revision },
    { code, ticket: p.ticket, id: 'x', expectedRevision: 'now', action: { type: 'call' } },
    { code, ticket: p.ticket, id: '', expectedRevision: v.revision, action: { type: 'call' } },
    { code, ticket: p.ticket, id: 'x', expectedRevision: v.revision, action: { type: 'call', amount: 'lots' } },
    { code, ticket: p.ticket, id: 'x', expectedRevision: v.revision, action: { type: 'call', extra: 1 } },
    { code, ticket: p.ticket, id: 'x', expectedRevision: v.revision, action: 'call' },
    null,
  ]) {
    const r = a.raw('roomAct', bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.body.error.code, 'INVALID_MESSAGE');
  }
  assert.equal(a.act(code, p.ticket, v.revision, { type: 'teleport' }).body.error.code, 'INVALID_MESSAGE');
  assert.equal(a.view(code).body.revision, v.revision, 'none of it moved the table');
  const check = a.act(code, p.ticket, v.revision, { type: 'check' });
  assert.equal(check.status, 400);
  assert.equal(check.body.error.code, 'MUST_CALL', 'a check facing a bet is refused by the rules');
}

function testReconnectKeepsSeatAndLeaveRevokesIt() {
  const ctx = loadAuthority(6);
  const { a, code, players } = table(ctx, ['Ann', 'Bob', 'Cy']);
  assert.equal(a.act(code, players[0].ticket, a.view(code).body.revision, { type: 'start' }).status, 200);
  const before = a.view(code, players[1].ticket).body;
  // Bob's browser goes away for a while; the table notices, the seat waits.
  ctx.clock.now += 20_000;
  assert.equal(a.view(code, players[0].ticket).body.members.find((m) => m.seat === players[1].seat).connected, false);
  const back = a.view(code, players[1].ticket).body;
  assert.equal(back.you.seat, before.you.seat);
  assert.deepEqual(back.you.holeCards, before.you.holeCards, 'the same cards are waiting');
  assert.equal(a.view(code, players[0].ticket).body.members.find((m) => m.seat === players[1].seat).connected, true);

  assert.equal(a.leave(code, players[1].ticket).status, 200);
  assert.equal(a.view(code, players[1].ticket).body.you, null, 'the ticket no longer identifies a seat');
  assert.equal(a.act(code, players[1].ticket, a.view(code).body.revision, { type: 'call' }).body.error.code, 'NOT_MEMBER');
  const state = a.state(code).state;
  assert.equal(state.seats[players[1].seat].status, 'folded', 'leaving mid-hand folds the hand');
  callDown(a, code, players.filter((p) => p !== players[1]));
  const next = a.act(code, players[0].ticket, a.view(code).body.revision, { type: 'start' });
  assert.equal(next.status, 200, JSON.stringify(next.body));
  assert.equal(a.state(code).state.seats[players[1].seat], null, 'and the seat empties for the next hand');
}

function testAbsentPlayersTurnIsTaken() {
  const ctx = loadAuthority(7);
  const { a, code, players } = table(ctx, ['Ann', 'Bob', 'Cy']);
  assert.equal(a.act(code, players[0].ticket, a.view(code).body.revision, { type: 'start' }).status, 200);
  const v = a.view(code).body;
  const absent = v.public.currentTurnSeat;
  assert.ok(v.public.turnDeadlineMs > ctx.clock.now);
  ctx.clock.now = v.public.turnDeadlineMs + 1;
  const later = a.view(code, players[0].ticket).body;
  assert.equal(later.revision, v.revision + 1, 'the overdue turn was taken');
  assert.notEqual(later.public.currentTurnSeat, absent);
  assert.equal(later.public.seats[absent].status, 'folded', 'facing the blind, the absent player folded');
  const lateAct = a.act(code, players.find((p) => p.seat === absent).ticket, v.revision, { type: 'call' });
  assert.equal(lateAct.body.error.code, 'STALE_VIEW', 'their late action is refused, not replayed');
}

function testEmptyTableCloses() {
  const ctx = loadAuthority(8);
  const { a, code, players } = table(ctx, ['Ann', 'Bob']);
  const tv = a.join(code, 'TV', 'spectator').body;
  assert.equal(a.leave(code, players[0].ticket).status, 200);
  assert.equal(a.view(code).body.closed, false, 'one player left keeps the table');
  assert.equal(a.leave(code, players[1].ticket).body.closed, true, 'the last player leaving closes it');
  assert.equal(a.join(code, 'Ed').body.error.code, 'ROOM_CLOSED');
  assert.equal(a.act(code, tv.ticket, 0, { type: 'start' }).body.error.code, 'AUTHORITY_UNAVAILABLE');
  // A display disconnecting never affected the authority: its ticket is still a spectator's.
  assert.equal(a.view(code, tv.ticket).body.you.role, 'spectator');
}

function testSidePotsCapWhatAShortStackCanWin() {
  const ctx = loadAuthority(9);
  const { a, code, players } = table(ctx, ['Short', 'Mid', 'Deep']);
  const rec = ctx.db._tables.rooms[0];
  rec.data.state.seats[0].chips = 100;
  rec.data.state.seats[1].chips = 300;
  rec.data.state.seats[2].chips = 1000;
  const bankroll = 1400;
  assert.equal(a.act(code, players[0].ticket, a.view(code).body.revision, { type: 'start' }).status, 200);
  let guard = 0;
  while (guard++ < 30) {
    const v = a.view(code).body;
    if (v.public.phase === 'showdown') break;
    const p = players.find((x) => x.seat === v.public.currentTurnSeat);
    const r = a.act(code, p.ticket, v.revision, { type: 'allin' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const end = a.state(code).state;
  assert.equal(end.phase, 'showdown');
  assert.equal(ctx.Rules_bankroll(end), bankroll, 'chips are conserved');
  assert.ok(end.seats[0].chips <= 300, 'the short stack wins at most its contribution from each of three');
  assert.ok(end.seats[1].chips <= 100 * 1 + 300 * 3 - 100, 'the mid stack cannot win the deep stack\'s excess');
  assert.ok(end.result.summary.length > 0);
}

function playRandomHands(seed, hands, names) {
  const ctx = loadAuthority(seed);
  const { a, code, players } = table(ctx, names);
  const rng = mulberry32(seed * 7 + 1);
  const summaries = [];
  let refusedOutOfTurn = 0;
  for (let h = 0; h < hands; h++) {
    // Everyone busted rebuys between hands, so the table keeps going.
    for (const p of players) {
      const me = a.view(code, p.ticket).body.you;
      if (me.chips <= 0) assert.equal(a.act(code, p.ticket, a.view(code).body.revision, { type: 'rebuy' }).status, 200);
    }
    const before = ctx.Rules_bankroll(a.state(code).state);
    const start = a.act(code, players[h % players.length].ticket, a.view(code).body.revision, { type: 'start' });
    assert.equal(start.status, 200, JSON.stringify(start.body));
    let steps = 0;
    while (steps++ < 200) {
      const v = a.view(code).body;
      if (v.public.phase === 'showdown') break;
      assert.ok(ctx.Rules_isLive(v.public.phase), 'a started hand is live until the showdown');
      const seat = v.public.currentTurnSeat;
      assert.ok(seat >= 0, 'a live hand has a turn');
      // Now and then someone acts out of turn; the table refuses them.
      if (rng() < 0.15) {
        const wrong = players.find((p) => p.seat !== seat);
        const r = a.act(code, wrong.ticket, v.revision, { type: 'call' });
        assert.equal(r.body.error.code, 'NOT_YOUR_TURN');
        refusedOutOfTurn++;
      }
      const p = players.find((x) => x.seat === seat);
      const mine = a.view(code, p.ticket).body.you;
      assert.equal(mine.canAct, true);
      const roll = rng();
      let action;
      if (roll < 0.15) action = { type: 'fold' };
      else if (roll < 0.6) action = { type: v.public.currentBet > mine.bet ? 'call' : 'check' };
      else if (roll < 0.93) action = { type: 'raise', amount: Math.floor(rng() * 80) };
      else action = { type: 'allin' };
      const r = a.act(code, p.ticket, v.revision, action);
      assert.equal(r.status, 200, `${JSON.stringify(action)} at ${JSON.stringify(v.public)} -> ${JSON.stringify(r.body)}`);
      // Every card on the table is distinct, at every step.
      const s = a.state(code).state;
      const dealt = [];
      for (const seatState of s.seats) if (seatState) dealt.push(...seatState.holeCards);
      dealt.push(...s.communityCards);
      assert.equal(new Set(dealt).size, dealt.length, 'no card is dealt twice');
      assert.equal(ctx.Rules_bankroll(s), before, 'chips are conserved mid-hand');
    }
    const end = a.state(code).state;
    assert.equal(end.phase, 'showdown', `hand ${h + 1} ended`);
    assert.equal(ctx.Rules_bankroll(end), before, 'chips are conserved at the showdown');
    summaries.push(end.result.summary);
  }
  return { summaries, refusedOutOfTurn };
}

function testInvariantsOverManyRandomHands() {
  const run = playRandomHands(11, 120, ['Ann', 'Bob', 'Cy', 'Di']);
  assert.equal(run.summaries.length, 120);
  assert.ok(run.refusedOutOfTurn > 10, 'out-of-turn actions were tried and refused');
  assert.ok(run.summaries.some((s) => s.includes('wins')), 'someone won something');
  assert.ok(run.summaries.some((s) => s.includes('everyone else folded')), 'some hands ended by folds');
  assert.ok(run.summaries.some((s) => !s.includes('everyone else folded') && s.includes('$')), 'some hands went to a showdown');
  const headsUp = playRandomHands(12, 40, ['Ann', 'Bob']);
  assert.equal(headsUp.summaries.length, 40);
  const full = playRandomHands(13, 30, ['A', 'B', 'C', 'D', 'E', 'F']);
  assert.equal(full.summaries.length, 30);
}

function testSameSeedDealsTheSameGame() {
  const one = playRandomHands(21, 25, ['Ann', 'Bob', 'Cy']);
  const two = playRandomHands(21, 25, ['Ann', 'Bob', 'Cy']);
  assert.deepEqual(one.summaries, two.summaries, 'the authority is deterministic given its randomness');
  const other = playRandomHands(22, 25, ['Ann', 'Bob', 'Cy']);
  assert.notDeepEqual(one.summaries, other.summaries);
}

function main() {
  const tests = [
    ['join, leave, capacity and spectators', testJoinLeaveAndCapacity],
    ['projections hide other hands and the deck', testProjectionsHideCardsAndDeck],
    ['a duplicate action has one effect; a reused id is refused', testDuplicateAndReusedActionIds],
    ['a stale or future revision is refused with the current one', testStaleRevision],
    ['out-of-turn, spectator, unknown and malformed actions do nothing', testOutOfTurnSpectatorsAndMalformedMessages],
    ['reconnect keeps the seat; leaving revokes it', testReconnectKeepsSeatAndLeaveRevokesIt],
    ["an absent player's turn is taken for them", testAbsentPlayersTurnIsTaken],
    ['the last player leaving closes the table', testEmptyTableCloses],
    ['side pots cap what a short stack can win', testSidePotsCapWhatAShortStackCanWin],
    ['chips conserved, no duplicate cards, every hand ends, over many random hands', testInvariantsOverManyRandomHands],
    ['the same seed deals the same game', testSameSeedDealsTheSameGame],
  ];
  let passed = 0;
  for (const [name, fn] of tests) {
    try {
      fn();
      passed++;
      console.log('PASS:', name);
    } catch (err) {
      console.error('FAIL:', name);
      console.error(err && err.stack ? err.stack : err);
      process.exit(1);
    }
  }
  console.log('TexasHoldem authority tests passed:', passed + '/' + tests.length);
}

main();
