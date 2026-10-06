import test from 'node:test';
import assert from 'node:assert/strict';
import { createEncounter, legalCommands, step } from '../src/engine';
import { type Action, type Command, type State } from '../src/model';
import { searchWins, combatSignature, type SearchOptions, type WinningSequence } from '../scripts/winning-search';
import { allowsNoFinisher, finisherShare, verifyWin } from '../scripts/analyze-combat';

const options: SearchOptions = { mode: 'exhaustive', maxBeats: 3, maxTransitions: 100_000, beamWidth: 16 };
const emptyCounts = (): Record<Action, number> => ({ Step: 0, Strike: 0, Throw: 0, Vault: 0, Wait: 0 });

function tinyEncounter(hp = 1): State {
  const state = createEncounter();
  state.openingStepAvailable = false;
  state.enemies = [{
    id: 1, kind: 'brawler', x: 6, y: 4, hp, maxHp: 12, down: 0, recovery: 0,
    intent: { kind: 'punch', cells: [{ x: 5, y: 4 }], damage: 3 },
  }];
  return state;
}

// Independent breadth-first reference; retain all paths, telemetry, and states.
function bruteForce(initial: State, maxBeats: number): { wins: WinningSequence[]; transitions: number } {
  const wins: WinningSequence[] = [];
  let transitions = 0;
  let frontier = [{ state: initial, commands: [] as Command[] }];
  for (let depth = 0; depth <= maxBeats; depth++) {
    const next: typeof frontier = [];
    for (const entry of frontier) {
      if (entry.state.phase === 'won') {
        const actions = emptyCounts();
        for (const command of entry.commands) actions[command.type]++;
        wins.push({ commands: entry.commands, actionCount: entry.commands.length,
          beats: entry.state.beat - initial.beat, hp: entry.state.player.hp, actions });
      } else if (entry.state.phase === 'combat' && depth < maxBeats) {
        for (const command of legalCommands(entry.state)) {
          const result = step(entry.state, command);
          assert.equal(result.accepted, true);
          transitions++;
          next.push({ state: result.state, commands: [...entry.commands, command] });
        }
      }
    }
    frontier = next;
  }
  return { wins, transitions };
}

function verifyReplay(initial: State, win: WinningSequence): void {
  let state = initial;
  const counts = emptyCounts();
  for (const command of win.commands) {
    assert.equal(state.phase, 'combat', 'A winning sequence stops at its first terminal state');
    const next = step(state, command);
    assert.equal(next.accepted, true);
    counts[command.type]++;
    state = next.state;
  }
  assert.equal(state.phase, 'won');
  assert.equal(win.hp, state.player.hp);
  assert.equal(win.actionCount, win.commands.length);
  assert.equal(win.beats, state.beat - initial.beat);
  assert.deepEqual(win.actions, counts);
}

test('both searches count a free opening Step as an action without spending a combat beat', () => {
  const initial = tinyEncounter();
  initial.openingStepAvailable = true;
  const allowCommand = (state: State, command: Command): boolean => state.player.y === 4
    ? command.type === 'Step' && command.target.x === 5 && command.target.y === 5
    : command.type === 'Strike';
  for (const mode of ['exhaustive', 'sampled'] as const) {
    const wins: WinningSequence[] = [];
    searchWins(initial, { ...options, mode, maxBeats: 2, allowCommand, onWin: win => wins.push(win) });
    assert.equal(wins.length, 1, mode);
    verifyReplay(initial, wins[0]);
    assert.equal(wins[0].actionCount, 2);
    assert.equal(wins[0].beats, 1);
    assert.deepEqual(wins[0].actions, { Step: 1, Strike: 1, Throw: 0, Vault: 0, Wait: 0 });
    assert.equal(searchWins(initial, { ...options, mode, maxBeats: 1, allowCommand }).wins, 0,
      'The action horizon still charges one action for the free Step');
  }
});

test('sampled state identity distinguishes an unused opening Step from the same positions after it is spent', () => {
  const available = tinyEncounter();
  available.openingStepAvailable = true;
  const consumed = structuredClone(available);
  consumed.openingStepAvailable = false;
  assert.notEqual(combatSignature(available), combatSignature(consumed));
  const command: Command = { type: 'Step', target: { x: 5, y: 5 } };
  const free = step(available, command).state;
  const ordinary = step(consumed, command).state;
  assert.equal(free.beat, 0);
  assert.equal(ordinary.beat, 1);
  assert.ok(free.enemies[0].intent, 'The free move preserves the pending attack');
  assert.equal(ordinary.enemies[0].intent, null, 'An ordinary move lets the enemy cancel its stale attack');
});

test('exhaustive search matches every reference winning path, action count, and transition through the horizon', () => {
  const initial = tinyEncounter();
  initial.beat = 7;
  initial.stats.actions.Wait = 99;
  const before = structuredClone(initial);
  const reference = bruteForce(initial, options.maxBeats);
  assert.ok(reference.wins.length > 1);
  const wins: WinningSequence[] = [];
  const result = searchWins(initial, { ...options, onWin: win => wins.push(win) });
  assert.deepEqual(initial, before);
  assert.equal(result.completed, true);
  assert.equal(result.stopReason, 'exhausted');
  assert.equal(result.transitions, reference.transitions);
  assert.equal(result.wins, reference.wins.length);
  const serialized = (values: WinningSequence[]) => values.map(value => JSON.stringify(value)).sort();
  assert.deepEqual(serialized(wins), serialized(reference.wins));
  for (const win of wins) verifyReplay(initial, win);
  for (const action of Object.keys(emptyCounts()) as Action[]) {
    const counts = wins.map(win => win.actions[action]);
    assert.deepEqual(result.actionSummary[action], {
      min: Math.min(...counts), max: Math.max(...counts), total: counts.reduce((sum, count) => sum + count, 0),
      usedInWins: counts.filter(count => count > 0).length,
    });
  }
  // The exact budget is enough; using it up does not falsely signal truncation.
  assert.equal(searchWins(initial, { ...options, maxTransitions: reference.transitions }).completed, true);
});

test('exhaustive search retains detours that revisit an earlier combat state', () => {
  const initial = tinyEncounter();
  const loop: Command[] = [
    { type: 'Step', target: { x: 5, y: 5 } },
    { type: 'Step', target: { x: 5, y: 4 } },
  ];
  const returned = loop.reduce((state, command) => step(state, command).state, initial);
  assert.deepEqual(returned.player, initial.player);
  assert.deepEqual(returned.enemies, initial.enemies);
  const wins: WinningSequence[] = [];
  searchWins(initial, { ...options, onWin: win => wins.push(win) });
  const paths = new Set(wins.map(win => JSON.stringify(win.commands)));
  const finish: Command = { type: 'Strike', targetId: 1 };
  assert.ok(paths.has(JSON.stringify([finish])));
  assert.ok(paths.has(JSON.stringify([...loop, finish])), 'The revisited state is a separate winning sequence');
  assert.ok(wins.every(win => win.actionCount <= options.maxBeats));
});

test('horizon completion and transition truncation are distinct, including no-win results', () => {
  const initial = tinyEncounter(12);
  const capped = searchWins(initial, { ...options, maxBeats: 2 });
  assert.equal(capped.completed, true);
  assert.equal(capped.wins, 0);
  assert.equal(capped.stopReason, 'exhausted');
  assert.deepEqual(capped.actionSummary.Strike, { min: 0, max: 0, total: 0, usedInWins: 0 });
  const partial = searchWins(initial, { ...options, maxTransitions: 1 });
  assert.equal(partial.transitions, 1);
  assert.equal(partial.wins, 0);
  assert.equal(partial.completed, false);
  assert.equal(partial.stopReason, 'transition-limit');
  const partialWithWin = searchWins(tinyEncounter(), { ...options, maxTransitions: 1 });
  assert.equal(partialWithWin.wins, 1);
  assert.equal(partialWithWin.completed, false, 'Finding a win does not mean all wins have been enumerated');
});

test('sampled search continues beyond its first win and every reported win replays', () => {
  const initial = tinyEncounter(12);
  const before = structuredClone(initial);
  const wins: WinningSequence[] = [];
  const result = searchWins(initial, { ...options, mode: 'sampled', maxBeats: 6, onWin: win => wins.push(win) });
  assert.deepEqual(initial, before);
  assert.ok(result.wins > 1);
  assert.equal(result.wins, wins.length);
  assert.equal(result.completed, false);
  assert.equal(result.stopReason, 'beam-limit');
  assert.equal(new Set(wins.map(win => JSON.stringify(win.commands))).size, wins.length);
  for (const win of wins) verifyReplay(initial, win);
  const truncated = searchWins(initial, { ...options, mode: 'sampled', maxTransitions: 1 });
  assert.equal(truncated.transitions, 1);
  assert.equal(truncated.completed, false);
  assert.equal(truncated.stopReason, 'transition-limit');
});

test('zero horizon and already terminal states are handled without taking a turn', () => {
  const initial = tinyEncounter();
  const zero = searchWins(initial, { ...options, maxBeats: 0 });
  assert.equal(zero.transitions, 0);
  assert.equal(zero.wins, 0);
  assert.equal(zero.completed, true);
  initial.phase = 'won';
  const wins: WinningSequence[] = [];
  const won = searchWins(initial, { ...options, maxBeats: 0, onWin: win => wins.push(win) });
  assert.equal(won.wins, 1);
  assert.equal(won.transitions, 0);
  assert.deepEqual(wins, [{ commands: [], actionCount: 0, beats: 0, hp: initial.player.hp, actions: emptyCounts() }]);
  initial.phase = 'dead';
  const dead = searchWins(initial, options);
  assert.equal(dead.wins, 0);
  assert.equal(dead.transitions, 0);
});

test('callback records are isolated from ongoing paths and summary counts', () => {
  const initial = tinyEncounter();
  const expected = searchWins(initial, options);
  const actual = searchWins(initial, { ...options, onWin: win => {
    win.commands.splice(0);
    win.actions.Strike = -999;
  } });
  assert.deepEqual(actual, expected);
});

test('search rejects unsafe or invalid budgets and unknown modes', () => {
  const initial = tinyEncounter();
  for (const key of ['maxBeats', 'maxTransitions', 'beamWidth'] as const) {
    for (const value of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => searchWins(initial, { ...options, [key]: value }), RangeError);
    }
  }
  assert.throws(() => searchWins(initial, { ...options, maxTransitions: 0 }), RangeError);
  assert.throws(() => searchWins(initial, { ...options, beamWidth: 0 }), RangeError);
  assert.throws(() => searchWins(initial, { ...options, mode: 'unknown' as SearchOptions['mode'] }), RangeError);
  assert.throws(() => searchWins(initial, { ...options, objective: 'unknown' as SearchOptions['objective'] }), RangeError);
});

const noFinisher = allowsNoFinisher;

test('a no-finisher policy keeps first and second strikes and rejects only third strikes on the same target', () => {
  const initial = tinyEncounter(12);
  const strike: Command = { type: 'Strike', targetId: 1 };
  assert.equal(noFinisher(initial, strike), true);
  const first = step(initial, strike).state;
  assert.equal(noFinisher(first, strike), true);
  const second = step(first, strike).state;
  assert.equal(noFinisher(second, strike), false);
  assert.equal(noFinisher(second, { type: 'Wait' }), true);
  assert.equal(noFinisher(second, { type: 'Strike', targetId: 2 }), true, 'Switching targets starts a new combo');
  for (const mode of ['exhaustive', 'sampled'] as const) {
    const result = searchWins(initial, {
      ...options, mode, maxTransitions: 2,
      allowCommand: (state, command) => command.type === 'Strike' && noFinisher(state, command),
    });
    assert.equal(result.transitions, 2, mode);
    assert.equal(result.wins, 0, mode);
    assert.equal(result.completed, mode === 'exhaustive');
    assert.equal(result.stopReason, mode === 'exhaustive' ? 'exhausted' : 'beam-limit');
  }
});

test('both modes can expose a win made of chip strikes while respecting a no-finisher policy', () => {
  const initial = tinyEncounter(3);
  // Keep the reduced fixture safely stationary while a combo is deliberately broken.
  initial.enemies[0].intent = null;
  initial.enemies[0].recovery = 8;
  for (const mode of ['exhaustive', 'sampled'] as const) {
    const wins: WinningSequence[] = [];
    const result = searchWins(initial, {
      ...options, mode, maxBeats: 4,
      allowCommand: (state, command) => (command.type === 'Strike' || command.type === 'Wait') && noFinisher(state, command),
      onWin: win => wins.push(win),
    });
    assert.ok(result.wins > 0, mode);
    for (const win of wins) {
      verifyReplay(initial, win);
      assert.equal(win.actions.Strike, 3);
      assert.equal(win.actions.Wait, 1);
      let state = initial;
      for (const command of win.commands) {
        assert.ok(noFinisher(state, command));
        state = step(state, command).state;
      }
      assert.equal(state.stats.completedCombos, 0);
      assert.equal(state.stats.finisherKills, 0);
    }
  }
});

test('policy-rejected legal commands do not spend the transition budget in either mode', () => {
  for (const mode of ['exhaustive', 'sampled'] as const) {
    const result = searchWins(tinyEncounter(), { ...options, mode, maxTransitions: 1, allowCommand: () => false });
    assert.equal(result.transitions, 0);
    assert.equal(result.wins, 0);
    assert.equal(result.completed, mode === 'exhaustive');
    assert.notEqual(result.stopReason, 'transition-limit');
  }
});

test('search objective leaves exhaustive results unchanged and balanced is the default', () => {
  const initial = tinyEncounter();
  const exhaustive = searchWins(initial, options);
  assert.deepEqual(searchWins(initial, { ...options, objective: 'combo' }), exhaustive);
  const sampled = { ...options, mode: 'sampled' as const };
  assert.deepEqual(searchWins(initial, { ...sampled, objective: 'balanced' }), searchWins(initial, sampled));
});

test('combo objective finds a replayable finisher-focused witness in the full demo room', () => {
  const initial = createEncounter();
  let witness: WinningSequence | undefined;
  const result = searchWins(initial, {
    mode: 'sampled', objective: 'combo', maxBeats: 40, maxTransitions: 75_000, beamWidth: 96,
    onWin: win => {
      if (finisherShare(verifyWin(initial, win)) > 0.5) witness ??= win;
    },
  });
  assert.ok(witness, 'The fixed prototype room must have a demonstrated combo-focused winning line');
  verifyReplay(initial, witness);
  assert.ok(finisherShare(verifyWin(initial, witness)) > 0.5,
    'Combo finishers must deal most of the actual enemy HP removed');
  assert.equal(result.completed, false, 'A witness does not prove complete enumeration');
});
