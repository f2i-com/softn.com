const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');

function makeDb() {
  const tables = {
    poker_table: [],
    poker_players: [],
    poker_actions: [],
  };
  let idCounter = 1;

  function ensure(name) {
    if (!tables[name]) tables[name] = [];
    return tables[name];
  }

  function shallowClone(obj) {
    const out = {};
    const keys = Object.keys(obj || {});
    let i = 0;
    while (i < keys.length) {
      const k = keys[i];
      out[k] = obj[k];
      i = i + 1;
    }
    return out;
  }

  function cloneRecord(rec) {
    return { id: rec.id, data: shallowClone(rec.data || {}) };
  }

  return {
    query(name) {
      const src = ensure(name);
      const out = [];
      let i = 0;
      while (i < src.length) {
        out.push(cloneRecord(src[i]));
        i = i + 1;
      }
      return out;
    },
    create(name, data) {
      const id = 'rec_' + idCounter;
      idCounter = idCounter + 1;
      const rec = { id, data: shallowClone(data || {}) };
      ensure(name).push(rec);
      return cloneRecord(rec);
    },
    update(id, patch) {
      const names = Object.keys(tables);
      let ni = 0;
      while (ni < names.length) {
        const arr = tables[names[ni]];
        let i = 0;
        while (i < arr.length) {
          if (arr[i].id === id) {
            const p = patch || {};
            const keys = Object.keys(p);
            let ki = 0;
            while (ki < keys.length) {
              const k = keys[ki];
              arr[i].data[k] = p[k];
              ki = ki + 1;
            }
            return cloneRecord(arr[i]);
          }
          i = i + 1;
        }
        ni = ni + 1;
      }
      return null;
    },
    delete(id) {
      const names = Object.keys(tables);
      let ni = 0;
      while (ni < names.length) {
        const arr = tables[names[ni]];
        let i = 0;
        while (i < arr.length) {
          if (arr[i].id === id) {
            arr.splice(i, 1);
            return true;
          }
          i = i + 1;
        }
        ni = ni + 1;
      }
      return false;
    },
    startSync() {},
    stopSync() {},
    getSavedSyncRoom() { return ''; },
    getSyncStatus() { return { connected: true, peers: 1 }; },
    _tables: tables,
  };
}

function loadTexasRuntime() {
  const base = path.resolve(__dirname, '../bundles/TexasHoldem/logic');
  const files = [
    'main.logic',
    'cards.logic',
    'engine.logic',
    'game.logic',
    'actions.logic',
    'bot.logic',
    'ui-helpers.logic',
  ];

  let source = '';
  let i = 0;
  while (i < files.length) {
    const filePath = path.join(base, files[i]);
    let txt = fs.readFileSync(filePath, 'utf8');
    txt = txt.replace(/^\s*import\s+['"][^'"]+['"]\s*;?\s*$/gm, '');
    source = source + '\n' + txt + '\n';
    i = i + 1;
  }

  const db = makeDb();
  const localStorageMap = {};
  const context = {
    console,
    db,
    Date,
    Math,
    navigator: {
      clipboard: {
        writeText: function () {},
      },
    },
    localStorage: {
      getItem(k) { return localStorageMap[k] || ''; },
      setItem(k, v) { localStorageMap[k] = '' + v; },
    },
    window: {
      innerWidth: 1200,
      innerHeight: 800,
      addEventListener: function () {},
      removeEventListener: function () {},
      preloadSoundFromAsset: function () { return { ok: true, diag: 'test' }; },
      playSoundFromAsset: function () { return { ok: true, diag: 'test' }; },
    },
  };
  context.globalThis = context;

  const vmContext = vm.createContext(context);
  vm.runInContext(source, vmContext, { filename: 'texasholdem-runtime.js' });
  vmContext.db = db;
  vmContext.exec = function exec(code) {
    return vm.runInContext(code, vmContext);
  };
  return vmContext;
}

function seatSort(a, b) {
  return a.data.seat - b.data.seat;
}

function testRoundRobinDeal() {
  const ctx = loadTexasRuntime();
  ctx._init();
  ctx.setPlayerName('Host');
  ctx.createRoom();
  ctx.takeSeat(0);
  ctx.refreshFromDB();
  ctx.addBot();
  ctx.refreshFromDB();

  // Deterministic deck order for assertions.
  ctx.exec('shuffleDeck = function(d) { return d }');

  ctx.startHand();

  const players = ctx.db.query('poker_players').slice().sort(seatSort);
  const table = ctx.db.query('poker_table')[0];

  assert.equal(players[0].data.holeCards.length, 2, 'Seat 0 should have 2 cards');
  assert.equal(players[1].data.holeCards.length, 2, 'Seat 1 should have 2 cards');
  assert.equal(JSON.stringify(players[0].data.holeCards), '[0,2]', 'Seat 0 should be dealt round-robin cards');
  assert.equal(JSON.stringify(players[1].data.holeCards), '[1,3]', 'Seat 1 should be dealt round-robin cards');
  assert.equal(table.data.deckPosition, 4, 'Deck position should advance by exactly 4 hole cards');
}

function testOddChipAwardingLeftOfDealer() {
  const ctx = loadTexasRuntime();

  const awards = { p1: 0, p2: 0 };
  const winners = [
    { player: { id: 'p1', data: { seat: 1 } } },
    { player: { id: 'p2', data: { seat: 4 } } },
  ];

  // Dealer at seat 3 => left-of-dealer order is 4,5,0,1,2,3.
  ctx.Table_awardSplit(awards, winners, 5, 3);

  assert.equal(awards.p2, 3, 'Seat 4 should receive odd chip first (left of dealer)');
  assert.equal(awards.p1, 2, 'Seat 1 should receive base share only');
}

function testBotShortAllInDoesNotRaiseCurrentBet() {
  const ctx = loadTexasRuntime();

  const tbl = ctx.db.create('poker_table', {
    gamePhase: 'preflop',
    handNumber: 1,
    dealerSeat: 0,
    currentTurnSeat: 1,
    currentBet: 100,
    pot: 200,
    deck: [],
    deckPosition: 0,
    communityCards: [],
    smallBlind: 10,
    bigBlind: 20,
    lastFullRaise: 20,
    lastBigBlindSeat: 0,
  });

  const villain = ctx.db.create('poker_players', {
    peerId: 'peer-a',
    name: 'Villain',
    seat: 0,
    chips: 900,
    holeCards: [10, 11],
    bet: 100,
    handContribution: 100,
    status: 'active',
    hasActed: true,
  });

  const bot = ctx.db.create('poker_players', {
    peerId: 'bot-1',
    name: 'Bot',
    seat: 1,
    chips: 50,
    holeCards: [0, 1],
    bet: 20,
    handContribution: 20,
    status: 'active',
    hasActed: false,
  });

  ctx.exec(`
    tableId = "${tbl.id}"
    players = db.query("poker_players")
    currentBet = 100
    pot = 200
    bigBlind = 20
    gamePhase = "preflop"
    isHost = true
  `);

  // Isolate bot action behavior from turn progression for this unit test.
  ctx.exec('advanceTurn = function () {}');

  ctx.botDoRaise(bot, 1, 20);

  const botAfter = ctx.db.query('poker_players').find((p) => p.id === bot.id);
  const tableAfter = ctx.db.query('poker_table').find((t) => t.id === tbl.id);

  assert.equal(botAfter.data.status, 'allin', 'Short bot should become all-in');
  assert.equal(botAfter.data.chips, 0, 'Bot chips should be 0 after all-in call');
  assert.equal(botAfter.data.bet, 70, 'Bot bet should increase only by all-in amount (call, not raise)');
  assert.equal(botAfter.data.handContribution, 70, 'Contribution should include the all-in call');
  assert.equal(tableAfter.data.currentBet, 100, 'Current bet must remain unchanged on short all-in call');
  assert.equal(tableAfter.data.pot, 250, 'Pot should increase by bot all-in amount');

  // Prevent unused variable linting in strict environments.
  assert.ok(villain && villain.id);
}

function testResolveShowdownMainAndSidePots() {
  const ctx = loadTexasRuntime();

  const tbl = ctx.db.create('poker_table', {
    gamePhase: 'river',
    handNumber: 9,
    dealerSeat: 0,
    currentTurnSeat: -1,
    currentBet: 0,
    pot: 500,
    deck: [],
    deckPosition: 0,
    // Board: 2s, 7d, 9c, Jh, 4d
    communityCards: [0, 31, 46, 22, 28],
    smallBlind: 10,
    bigBlind: 20,
    lastFullRaise: 20,
    lastBigBlindSeat: 4,
    showdownStartedAtMs: 0,
  });

  // P1 has best hand (pair of Aces), but only contributed 100.
  const p1 = ctx.db.create('poker_players', {
    peerId: 'peer-1',
    name: 'P1',
    seat: 0,
    chips: 0,
    holeCards: [12, 25], // As Ah
    bet: 0,
    handContribution: 100,
    status: 'allin',
    hasActed: true,
    showCardsAtShowdown: false,
  });
  // P2 and P3 contributed deeper (side pot between them for 200).
  const p2 = ctx.db.create('poker_players', {
    peerId: 'peer-2',
    name: 'P2',
    seat: 1,
    chips: 0,
    holeCards: [11, 10], // Ks Qs
    bet: 0,
    handContribution: 200,
    status: 'allin',
    hasActed: true,
    showCardsAtShowdown: false,
  });
  const p3 = ctx.db.create('poker_players', {
    peerId: 'peer-3',
    name: 'P3',
    seat: 2,
    chips: 0,
    holeCards: [3, 19], // 5s 8h
    bet: 0,
    handContribution: 200,
    status: 'allin',
    hasActed: true,
    showCardsAtShowdown: false,
  });

  ctx.exec(`
    tableId = "${tbl.id}"
    gamePhase = "river"
    players = db.query("poker_players")
    resultWinnerName = ""
    resultHandName = ""
    resultPotAmount = 0
    resultDetails = ""
    toastMessage = ""
  `);

  ctx.resolveShowdown();

  const p1After = ctx.db.query('poker_players').find((p) => p.id === p1.id);
  const p2After = ctx.db.query('poker_players').find((p) => p.id === p2.id);
  const p3After = ctx.db.query('poker_players').find((p) => p.id === p3.id);
  const tableAfter = ctx.db.query('poker_table').find((t) => t.id === tbl.id);

  assert.equal(p1After.data.chips, 300, 'P1 should win the main pot (300)');
  assert.equal(p2After.data.chips, 200, 'P2 should win the side pot (200)');
  assert.equal(p3After.data.chips, 0, 'P3 should lose showdown');
  assert.equal(tableAfter.data.gamePhase, 'showdown', 'Table should move to showdown');
  assert.equal(
    p1After.data.showCardsAtShowdown && p2After.data.showCardsAtShowdown && p3After.data.showCardsAtShowdown,
    true,
    'All contenders should be revealed at showdown',
  );
}

function testBlindProgressionUsesLastBigBlind() {
  const ctx = loadTexasRuntime();

  const tbl = ctx.db.create('poker_table', {
    gamePhase: 'preflop',
    handNumber: 4,
    dealerSeat: 0,
    currentTurnSeat: -1,
    currentBet: 0,
    pot: 0,
    deck: [],
    deckPosition: 0,
    communityCards: [],
    smallBlind: 10,
    bigBlind: 20,
    lastFullRaise: 20,
    lastBigBlindSeat: 2,
  });

  const a = ctx.db.create('poker_players', {
    peerId: 'peer-a',
    name: 'A',
    seat: 0,
    chips: 1000,
    holeCards: [],
    bet: 0,
    handContribution: 0,
    status: 'active',
    hasActed: false,
  });
  const b = ctx.db.create('poker_players', {
    peerId: 'peer-b',
    name: 'B',
    seat: 2,
    chips: 1000,
    holeCards: [],
    bet: 0,
    handContribution: 0,
    status: 'active',
    hasActed: false,
  });
  const c = ctx.db.create('poker_players', {
    peerId: 'peer-c',
    name: 'C',
    seat: 4,
    chips: 1000,
    holeCards: [],
    bet: 0,
    handContribution: 0,
    status: 'active',
    hasActed: false,
  });

  ctx.exec(`
    tableId = "${tbl.id}"
    players = db.query("poker_players")
    bigBlind = 20
    smallBlind = 10
  `);

  ctx.postBlinds(0, []);

  const aAfter = ctx.db.query('poker_players').find((p) => p.id === a.id);
  const bAfter = ctx.db.query('poker_players').find((p) => p.id === b.id);
  const cAfter = ctx.db.query('poker_players').find((p) => p.id === c.id);
  const tAfter = ctx.db.query('poker_table').find((t) => t.id === tbl.id);

  assert.equal(bAfter.data.bet, 10, 'Previous active seat before BB should post SB');
  assert.equal(cAfter.data.bet, 20, 'Next active after last BB should post BB');
  assert.equal(aAfter.data.bet, 0, 'Dealer seat should not post blind in this 3-handed case');
  assert.equal(tAfter.data.lastBigBlindSeat, 4, 'lastBigBlindSeat should advance to new BB seat');
  assert.equal(tAfter.data.pot, 30, 'Pot should equal posted blinds');
}

function testBotsFinishHandWithoutTurnStall() {
  const ctx = loadTexasRuntime();

  const tbl = ctx.db.create('poker_table', {
    gamePhase: 'waiting',
    handNumber: 0,
    dealerSeat: 0,
    currentTurnSeat: -1,
    currentBet: 0,
    pot: 0,
    deck: [],
    deckPosition: 0,
    communityCards: [],
    smallBlind: 10,
    bigBlind: 20,
    lastFullRaise: 20,
    lastBigBlindSeat: -1,
  });

  ctx.db.create('poker_players', {
    peerId: 'bot-0',
    name: 'Bot 1',
    seat: 0,
    chips: 1000,
    holeCards: [],
    bet: 0,
    handContribution: 0,
    status: 'waiting',
    hasActed: false,
  });
  ctx.db.create('poker_players', {
    peerId: 'bot-1',
    name: 'Bot 2',
    seat: 1,
    chips: 1000,
    holeCards: [],
    bet: 0,
    handContribution: 0,
    status: 'waiting',
    hasActed: false,
  });

  ctx.exec(`
    tableId = "${tbl.id}"
    players = db.query("poker_players")
    gamePhase = "waiting"
    bigBlind = 20
    smallBlind = 10
    isHost = true
  `);

  ctx.startHand();

  let settled = false;
  let steps = 0;
  while (steps < 240) {
    ctx.refreshFromDB();
    const t = ctx.db.query('poker_table')[0];
    if (!t) {
      break;
    }
    const phase = t.data.gamePhase || 'waiting';
    if (phase === 'showdown' || phase === 'waiting') {
      settled = true;
      break;
    }
    const turnSeat = t.data.currentTurnSeat;
    if (turnSeat >= 0) {
      ctx.exec(`
        players = db.query("poker_players")
        currentTurnSeat = ${turnSeat}
        currentBet = ${t.data.currentBet || 0}
        pot = ${t.data.pot || 0}
        gamePhase = "${phase}"
      `);
      const acted = ctx.botAct(turnSeat);
      if (!acted) {
        ctx.advanceTurn();
      }
    } else {
      ctx.advanceTurn();
    }
    steps = steps + 1;
  }

  const finalTable = ctx.db.query('poker_table')[0];
  const finalPlayers = ctx.db.query('poker_players');
  let contrib = 0;
  let i = 0;
  while (i < finalPlayers.length) {
    contrib = contrib + (finalPlayers[i].data.handContribution || 0);
    i = i + 1;
  }

  assert.equal(settled, true, 'Two-bot hand should settle without stalling');
  assert.equal(
    finalTable.data.gamePhase === 'showdown' || finalTable.data.gamePhase === 'waiting',
    true,
    'Table should reach showdown/waiting',
  );
  assert.equal(finalTable.data.pot, contrib, 'Pot should match total contributions at hand settlement');
}

function testHeadsUpBlindAndTurnOrder() {
  const ctx = loadTexasRuntime();

  const tbl = ctx.db.create('poker_table', {
    gamePhase: 'waiting',
    handNumber: 0,
    dealerSeat: 0,
    currentTurnSeat: -1,
    currentBet: 0,
    pot: 0,
    deck: [],
    deckPosition: 0,
    communityCards: [],
    smallBlind: 10,
    bigBlind: 20,
    lastFullRaise: 20,
    lastBigBlindSeat: -1,
  });

  const dealer = ctx.db.create('poker_players', {
    peerId: 'peer-d',
    name: 'Dealer',
    seat: 0,
    chips: 1000,
    holeCards: [],
    bet: 0,
    handContribution: 0,
    status: 'active',
    hasActed: false,
  });
  const other = ctx.db.create('poker_players', {
    peerId: 'peer-o',
    name: 'Other',
    seat: 3,
    chips: 1000,
    holeCards: [],
    bet: 0,
    handContribution: 0,
    status: 'active',
    hasActed: false,
  });

  ctx.exec(`
    tableId = "${tbl.id}"
    players = db.query("poker_players")
    bigBlind = 20
    smallBlind = 10
  `);

  ctx.postBlinds(0, []);

  const dAfter = ctx.db.query('poker_players').find((p) => p.id === dealer.id);
  const oAfter = ctx.db.query('poker_players').find((p) => p.id === other.id);
  const tAfter = ctx.db.query('poker_table').find((t) => t.id === tbl.id);

  assert.equal(dAfter.data.bet, 10, 'Heads-up dealer should post small blind');
  assert.equal(oAfter.data.bet, 20, 'Heads-up non-dealer should post big blind');
  assert.equal(tAfter.data.currentTurnSeat, 0, 'Preflop action should start at dealer in heads-up');
}

function testDoCheckBlockedWhenCallRequired() {
  const ctx = loadTexasRuntime();

  const tbl = ctx.db.create('poker_table', {
    gamePhase: 'preflop',
    handNumber: 2,
    dealerSeat: 0,
    currentTurnSeat: 0,
    currentBet: 40,
    pot: 60,
    deck: [],
    deckPosition: 0,
    communityCards: [],
    smallBlind: 10,
    bigBlind: 20,
    lastFullRaise: 20,
    lastBigBlindSeat: 1,
  });
  const me = ctx.db.create('poker_players', {
    peerId: 'peer-me',
    name: 'Me',
    seat: 0,
    chips: 980,
    holeCards: [0, 1],
    bet: 20,
    handContribution: 20,
    status: 'active',
    hasActed: false,
  });

  ctx.exec(`
    tableId = "${tbl.id}"
    players = db.query("poker_players")
    gamePhase = "preflop"
    currentTurnSeat = 0
    mySeat = 0
    peerId = "peer-me"
    playerName = "Me"
    actionBusyUntilMs = 0
    toastMessage = ""
  `);

  ctx.doCheck();

  const meAfter = ctx.db.query('poker_players').find((p) => p.id === me.id);
  const msg = ctx.exec('toastMessage');

  assert.equal(meAfter.data.hasActed, false, 'Player should not be marked acted when check is illegal');
  assert.equal(msg, 'Cannot check, must call or raise', 'Illegal check should show warning message');
}

function testShortAllInRaiseDoesNotReopenAction() {
  const ctx = loadTexasRuntime();

  const tbl = ctx.db.create('poker_table', {
    gamePhase: 'preflop',
    handNumber: 7,
    dealerSeat: 0,
    currentTurnSeat: 1,
    currentBet: 100,
    pot: 250,
    deck: [],
    deckPosition: 0,
    communityCards: [],
    smallBlind: 10,
    bigBlind: 20,
    lastFullRaise: 40,
    lastBigBlindSeat: 3,
  });

  const p0 = ctx.db.create('poker_players', {
    peerId: 'peer-0',
    name: 'P0',
    seat: 0,
    chips: 900,
    holeCards: [0, 1],
    bet: 100,
    handContribution: 100,
    status: 'active',
    hasActed: true,
  });
  const p1 = ctx.db.create('poker_players', {
    peerId: 'peer-1',
    name: 'P1',
    seat: 1,
    chips: 30,
    holeCards: [2, 3],
    bet: 80,
    handContribution: 80,
    status: 'active',
    hasActed: false,
  });
  const p2 = ctx.db.create('poker_players', {
    peerId: 'peer-2',
    name: 'P2',
    seat: 2,
    chips: 700,
    holeCards: [4, 5],
    bet: 100,
    handContribution: 100,
    status: 'active',
    hasActed: true,
  });

  ctx.exec(`
    tableId = "${tbl.id}"
    players = db.query("poker_players")
    gamePhase = "preflop"
    currentTurnSeat = 1
    mySeat = 1
    peerId = "peer-1"
    playerName = "P1"
    bigBlind = 20
    raiseAmount = "40"
    actionBusyUntilMs = 0
  `);

  // Keep focus on raise semantics.
  ctx.exec('advanceTurn = function () {}');
  ctx.doRaise();

  const p0After = ctx.db.query('poker_players').find((p) => p.id === p0.id);
  const p1After = ctx.db.query('poker_players').find((p) => p.id === p1.id);
  const p2After = ctx.db.query('poker_players').find((p) => p.id === p2.id);
  const tAfter = ctx.db.query('poker_table').find((t) => t.id === tbl.id);
  assert.equal(p1After.data.status, 'allin', 'Short player should be all-in');
  assert.equal(tAfter.data.currentBet, 110, 'Current bet can increase by short all-in amount');
  assert.equal(tAfter.data.lastFullRaise, 40, 'lastFullRaise should remain unchanged on non-full raise');
  assert.equal(p0After.data.hasActed, true, 'Other acted players should stay acted (no reopen)');
  assert.equal(p2After.data.hasActed, true, 'Other acted players should stay acted (no reopen)');
}

function testAceLowStraightEvaluation() {
  const ctx = loadTexasRuntime();
  // A,5,4,3,2 mixed suits
  const res = ctx.evaluateHand5([12, 3, 15, 27, 39]);
  assert.equal(res.rank, 5, 'A-2-3-4-5 should evaluate as a straight');
  assert.equal(res.kickers[0], 5, 'Ace-low straight high card should be 5');
}

function testEvaluateBestHandKickerTiebreak() {
  const ctx = loadTexasRuntime();
  // Board: As Kd 7h 6c 2d
  const board = [12, 24, 18, 43, 26];
  // P1: Qs 3s  -> top pair A with K,Q,7,6 kickers
  const p1 = ctx.HandEvaluator_strengthFromHoleAndBoard([10, 1], board);
  // P2: Js 4s  -> top pair A with K,J,7,6 kickers
  const p2 = ctx.HandEvaluator_strengthFromHoleAndBoard([9, 2], board);
  const cmp = ctx.HandStrength_compare(p1, p2);
  assert.equal(cmp > 0, true, 'Higher kicker hand should compare as stronger');
}

function testOddChipOrderingAcrossThreeWinners() {
  const ctx = loadTexasRuntime();
  const awards = { a: 0, b: 0, c: 0 };
  const winners = [
    { player: { id: 'a', data: { seat: 0 } } },
    { player: { id: 'b', data: { seat: 2 } } },
    { player: { id: 'c', data: { seat: 5 } } },
  ];
  // Dealer at seat 1 -> left order is 2,3,4,5,0,1, so remainder chips go to b then c.
  ctx.Table_awardSplit(awards, winners, 8, 1);
  assert.equal(awards.b, 3, 'First odd chip should go to winner closest left of dealer');
  assert.equal(awards.c, 3, 'Second odd chip should go to next winner left of dealer');
  assert.equal(awards.a, 2, 'Remaining winner gets base share');
}

function testAwardSplitConservesPotAcrossRemainders() {
  const ctx = loadTexasRuntime();
  let dealer = 0;
  while (dealer < 6) {
    let pot = 1;
    while (pot <= 17) {
      const awards = { p0: 0, p1: 0, p2: 0, p3: 0 };
      const winners = [
        { player: { id: 'p0', data: { seat: 0 } } },
        { player: { id: 'p1', data: { seat: 1 } } },
        { player: { id: 'p2', data: { seat: 3 } } },
        { player: { id: 'p3', data: { seat: 5 } } },
      ];
      ctx.Table_awardSplit(awards, winners, pot, dealer);
      const total = awards.p0 + awards.p1 + awards.p2 + awards.p3;
      assert.equal(total, pot, 'Split awards must always sum to full pot');
      pot = pot + 1;
    }
    dealer = dealer + 1;
  }
}

function testCardVisibilityRules() {
  const ctx = loadTexasRuntime();

  const me = { id: 'me', data: { peerId: 'peer-me', seat: 0, holeCards: [0, 1], status: 'active', showCardsAtShowdown: false } };
  const opp = { id: 'opp', data: { peerId: 'peer-opp', seat: 2, holeCards: [10, 11], status: 'active', showCardsAtShowdown: false } };
  const folded = { id: 'fld', data: { peerId: 'peer-f', seat: 3, holeCards: [20, 21], status: 'folded', showCardsAtShowdown: false } };

  ctx.exec(`
    peerId = "peer-me"
    mySeat = 0
    gamePhase = "preflop"
  `);

  const myView = ctx.playerDisplayCards(me);
  const oppViewLive = ctx.playerDisplayCards(opp);
  const foldedLive = ctx.playerDisplayCards(folded);

  assert.equal(JSON.stringify(myView), '[0,1]', 'Player should always see own hole cards');
  assert.equal(JSON.stringify(oppViewLive), '[-1,-1]', 'Opponent cards should be hidden during live play');
  assert.equal(JSON.stringify(foldedLive), '[]', 'Folded player cards should not show during live play');

  ctx.exec('gamePhase = "showdown"');
  const oppShowdownHidden = ctx.playerDisplayCards(opp);
  assert.equal(JSON.stringify(oppShowdownHidden), '[10,11]', 'Active showdown contenders should reveal cards at showdown');

  opp.data.showCardsAtShowdown = true;
  const oppShowdownShown = ctx.playerDisplayCards(opp);
  assert.equal(JSON.stringify(oppShowdownShown), '[10,11]', 'Explicit showdown reveal flag should reveal cards');
}

function testTableRepositoryPrefersLatestHandThenPhase() {
  const ctx = loadTexasRuntime();
  const tables = [
    { id: 't1', data: { handNumber: 4, gamePhase: 'flop', pot: 80, communityCards: [1, 2, 3], currentTurnSeat: 0 } },
    { id: 't2', data: { handNumber: 5, gamePhase: 'preflop', pot: 30, communityCards: [], currentTurnSeat: 2 } },
    { id: 't3', data: { handNumber: 5, gamePhase: 'turn', pot: 90, communityCards: [1, 2, 3, 4], currentTurnSeat: 1 } },
  ];

  const selected = ctx.TableRepository_selectCurrentTableRecord(tables, '');
  assert.equal(selected.id, 't3', 'Table repository should prefer latest hand and most advanced phase');

  // Sticky preference should win when records are otherwise equivalent.
  const eqA = { id: 'a', data: { handNumber: 7, gamePhase: 'flop', pot: 50, communityCards: [1, 2, 3], currentTurnSeat: 0 } };
  const eqB = { id: 'b', data: { handNumber: 7, gamePhase: 'flop', pot: 50, communityCards: [1, 2, 3], currentTurnSeat: 0 } };
  const sticky = ctx.TableRepository_selectCurrentTableRecord([eqA, eqB], 'b');
  assert.equal(sticky.id, 'b', 'Preferred tableId should remain sticky when score is otherwise equal');
}

function testHostReconnectShowdownDoesNotInstantlyStartHand() {
  const ctx = loadTexasRuntime();

  const tbl = ctx.db.create('poker_table', {
    gamePhase: 'showdown',
    handNumber: 12,
    dealerSeat: 0,
    currentTurnSeat: -1,
    currentBet: 0,
    pot: 100,
    deck: [],
    deckPosition: 0,
    communityCards: [1, 2, 3, 4, 5],
    smallBlind: 10,
    bigBlind: 20,
    lastFullRaise: 20,
    lastBigBlindSeat: 1,
    showdownStartedAtMs: 1000, // very old timestamp vs "now"
  });

  ctx.db.create('poker_players', {
    peerId: 'peer-host',
    name: 'Host',
    seat: 0,
    chips: 1000,
    holeCards: [0, 1],
    bet: 0,
    handContribution: 0,
    status: 'active',
    hasActed: false,
  });
  ctx.db.create('poker_players', {
    peerId: 'bot-1',
    name: 'Bot 2',
    seat: 1,
    chips: 1000,
    holeCards: [2, 3],
    bet: 0,
    handContribution: 0,
    status: 'active',
    hasActed: false,
  });

  let fakeNow = 20000;
  ctx.exec(`
    Date.now = function () { return ${fakeNow}; }
    tableId = "${tbl.id}"
    peerId = "peer-host"
    mySeat = 0
    currentPage = "table"
    currentTurnSeat = -1
    gamePhase = "showdown"
    showResultsModal = false
    showdownAutoDelay = 0
    showdownAutoDeadlineMs = 0
    hostAutomationPauseUntilMs = 0
    wasHostLastTick = false
  `);

  let starts = 0;
  ctx.exec(`
    startHand = function () { starts = starts + 1; }
  `);
  ctx.starts = 0;

  // First poll: host transition should set automation pause and NOT start hand.
  ctx.pollGameState();
  const startsAfterFirst = ctx.exec('starts');
  assert.equal(startsAfterFirst, 0, 'Host transition should not immediately auto-start next hand');

  // After pause expires, stale showdown should restart countdown from now (not insta-start).
  fakeNow = 22000;
  ctx.exec(`Date.now = function () { return ${fakeNow}; }`);
  ctx.pollGameState();
  const startsAfterSecond = ctx.exec('starts');
  const delayAfterSecond = ctx.exec('showdownAutoDelay');
  assert.equal(startsAfterSecond, 0, 'Stale showdown should not instantly start on first eligible tick');
  assert.equal(delayAfterSecond >= 2, true, 'Countdown should be reset to ~3s after reconnect');

  // Once deadline passes, auto-start should occur.
  fakeNow = 25550;
  ctx.exec(`Date.now = function () { return ${fakeNow}; }`);
  ctx.pollGameState();
  const startsAfterThird = ctx.exec('starts');
  assert.equal(startsAfterThird, 1, 'Auto-start should happen only after refreshed countdown expires');
}

function main() {
  const tests = [
    ['round-robin deal order', testRoundRobinDeal],
    ['odd chip left-of-dealer split', testOddChipAwardingLeftOfDealer],
    ['bot short all-in call behavior', testBotShortAllInDoesNotRaiseCurrentBet],
    ['showdown main/side pot resolution', testResolveShowdownMainAndSidePots],
    ['blind progression via last big blind', testBlindProgressionUsesLastBigBlind],
    ['bot-vs-bot hand settles without stall', testBotsFinishHandWithoutTurnStall],
    ['heads-up blind and turn order', testHeadsUpBlindAndTurnOrder],
    ['check blocked when call required', testDoCheckBlockedWhenCallRequired],
    ['short all-in raise does not reopen action', testShortAllInRaiseDoesNotReopenAction],
    ['ace-low straight evaluation', testAceLowStraightEvaluation],
    ['kicker tie-break evaluation', testEvaluateBestHandKickerTiebreak],
    ['odd-chip ordering across three winners', testOddChipOrderingAcrossThreeWinners],
    ['award split conserves full pot', testAwardSplitConservesPotAcrossRemainders],
    ['card visibility rules', testCardVisibilityRules],
    ['table repository latest/sticky selection', testTableRepositoryPrefersLatestHandThenPhase],
    ['host reconnect does not instantly auto-start hand', testHostReconnectShowdownDoesNotInstantlyStartHand],
  ];

  let passed = 0;
  let i = 0;
  while (i < tests.length) {
    const name = tests[i][0];
    const fn = tests[i][1];
    try {
      fn();
      passed = passed + 1;
      console.log('PASS:', name);
    } catch (err) {
      console.error('FAIL:', name);
      console.error(err && err.stack ? err.stack : err);
      process.exit(1);
    }
    i = i + 1;
  }

  console.log('TexasHoldem gameplay tests passed:', passed + '/' + tests.length);
}

main();
