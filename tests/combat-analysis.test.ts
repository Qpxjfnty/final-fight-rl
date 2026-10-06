import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createEncounter } from '../src/engine';
import { parseOptions, runAnalysis, verifyWin, finisherShare, comboVerdict } from '../scripts/analyze-combat';
import { type WinningSequence } from '../scripts/winning-search';

test('analysis CLI rejects invalid or ambiguous budgets instead of silently changing the search', () => {
  assert.equal(parseOptions([]).mode, 'sampled');
  assert.deepEqual(Object.fromEntries(Object.entries(parseOptions([
    '--mode', 'exhaustive', '--rooms', '0', '--seed', '0', '--max-beats', '0',
    '--max-transitions', '1', '--beam-width', '1',
  ])).filter(([key]) => key !== 'output')), {
    mode: 'exhaustive', objective: 'combo', rooms: 0, seed: 0, maxBeats: 0, maxTransitions: 1, beamWidth: 1,
  });
  for (const args of [
    ['--mode', 'all'], ['--rooms', '-1'], ['--seed', '4294967296'], ['--max-beats', '2.5'],
    ['--max-transitions', '0'], ['--beam-width', 'NaN'], ['--rooms'], ['--unknown', '1'],
    ['--rooms', '1', '--rooms', '2'], ['--output', ''], ['--objective', 'invalid'],
  ]) assert.throws(() => parseOptions(args), args.join(' '));
});

test('recorded wins must replay to victory with the claimed action counts and health', () => {
  const state = createEncounter();
  state.enemies = [{ ...state.enemies[0], x: 6, y: 4, hp: 1 }];
  const win: WinningSequence = {
    commands: [{ type: 'Strike', targetId: state.enemies[0].id }], beats: 1, hp: 24,
    actions: { Step: 0, Strike: 1, Throw: 0, Vault: 0, Wait: 0 },
  };
  const original = structuredClone(state);
  assert.doesNotThrow(() => verifyWin(state, win));
  assert.deepEqual(state, original);
  assert.throws(() => verifyWin(state, { ...win, hp: 23 }));
  assert.throws(() => verifyWin(state, { ...win, beats: 2 }));
  assert.throws(() => verifyWin(state, { ...win, actions: { ...win.actions, Strike: 2 } }));
  assert.throws(() => verifyWin(state, { ...win, commands: [{ type: 'Wait' }] }));
  assert.throws(() => verifyWin(state, { ...win, commands: [{ type: 'Strike', targetId: 999 }] }));
});

test('combo qualification measures actual finisher damage rather than just the presence of a combo kill', () => {
  for (const hp of [3, 4, 12]) {
    const state = createEncounter();
    state.enemies = [{ ...state.enemies[0], x: 6, y: 4, hp }];
    const metrics = verifyWin(state, {
      commands: Array.from({ length: 3 }, () => ({ type: 'Strike' as const, targetId: state.enemies[0].id })),
      beats: 3, hp: 24, actions: { Step: 0, Strike: 3, Throw: 0, Vault: 0, Wait: 0 },
    });
    assert.equal(metrics.completedCombos, 1);
    assert.equal(metrics.finisherKills, 1);
    assert.equal(metrics.finisherDamage, hp - 2, 'Overkill must not count as effective damage.');
    assert.equal(metrics.chipStrikeDamage, 2);
    assert.equal(metrics.chipStrikeActions, 2);
    assert.equal(finisherShare(metrics) > 0.5, hp === 12);
  }
  const state = createEncounter();
  state.enemies = [
    { ...state.enemies[0], x: 6, y: 4, hp: 1 },
    { ...state.enemies[1], x: 9, y: 4, hp: 1 },
  ];
  const chip = verifyWin(state, {
    commands: [{ type: 'Throw', targetId: state.enemies[0].id, direction: { x: 1, y: 0 } }],
    beats: 1, hp: 24, actions: { Step: 0, Strike: 0, Throw: 1, Vault: 0, Wait: 0 },
  });
  assert.equal(chip.throwDamage, 2, 'Both bodies in a collision contribute actual damage.');
  assert.equal(finisherShare(chip), 0);
  assert.equal(finisherShare({ ...chip, finisherDamage: 2 }), 0.5, 'Exactly half is not a majority.');
});

test('a combo witness passes even alongside chip wins; missing witnesses are never called chip-only proof', () => {
  assert.equal(comboVerdict(1, 100, false), 'pass');
  assert.equal(comboVerdict(0, 100, false), 'needs-review');
  assert.equal(comboVerdict(0, 0, false), 'inconclusive');
  assert.equal(comboVerdict(0, 100, true), 'no-combo-win-within-horizon');
});

test('analysis reports distinguish horizon exhaustion from incomplete searches and preserve exact room states', () => {
  const parent = mkdtempSync(join(tmpdir(), 'combat-analysis-test-'));
  try {
    const base = { ...parseOptions([]), rooms: 1, seed: 0, maxBeats: 0, output: parent };
    const exhaustive = runAnalysis({ ...base, mode: 'exhaustive' });
    const summary = JSON.parse(readFileSync(join(exhaustive, 'summary.json'), 'utf8'));
    assert.equal(summary.rooms.length, 2);
    assert.ok(summary.rooms.every((room: { verdict: string; completed: boolean; wins: number }) =>
      room.verdict === 'no-win-within-horizon' && room.completed && room.wins === 0));
    const rooms = JSON.parse(readFileSync(join(exhaustive, 'rooms.json'), 'utf8'));
    assert.deepEqual(rooms[0].initial, createEncounter());
    assert.equal(rooms[1].seed, 0);
    assert.match(readFileSync(join(exhaustive, 'wins.csv'), 'utf8'), /^room,win,beats,hp,Step,Strike,Throw,Vault,Wait,.*finisherDamageShare,comboFocused\n$/);
    assert.equal(readFileSync(join(exhaustive, 'winning-sequences.jsonl'), 'utf8'), '');
    const sampled = runAnalysis({ ...base, mode: 'sampled', maxBeats: 1, maxTransitions: 1 });
    assert.notEqual(sampled, exhaustive, 'A second report must not overwrite the first.');
    const partial = JSON.parse(readFileSync(join(sampled, 'summary.json'), 'utf8'));
    assert.ok(partial.rooms.every((room: { verdict: string; completed: boolean }) =>
      room.verdict === 'inconclusive' && !room.completed));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('the CLI leaves reviewable reports and returns a failing check when it cannot establish combo viability', () => {
  const parent = mkdtempSync(join(tmpdir(), 'combat-analysis-cli-'));
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx',
      fileURLToPath(new URL('../scripts/analyze-combat.ts', import.meta.url)),
      '--mode', 'exhaustive', '--rooms', '0', '--max-beats', '0', '--output', parent,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stdout, /Report: /);
    assert.match(result.stderr, /needs review/);
    assert.match(result.stderr, /not proof of impossibility/);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
