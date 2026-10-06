import test from 'node:test';
import assert from 'node:assert/strict';
import { generateAnalysisRoom } from '../scripts/analysis-rooms';
import { createEncounter, legalCommands, step } from '../src/engine';
import { distance, inside, key } from '../src/model';

test('analysis room seeds reproduce independently, including zero and the maximum uint32', () => {
  for (const seed of [0, 1, 42, 0x80000000, 0xffffffff]) {
    const first = generateAnalysisRoom(seed);
    generateAnalysisRoom((seed + 1) >>> 0);
    assert.deepEqual(generateAnalysisRoom(seed), first);
  }
  const layouts = new Set(Array.from({ length: 32 }, (_, seed) =>
    JSON.stringify(generateAnalysisRoom(seed).enemies.map(({ id, x, y }) => ({ id, x, y })))));
  assert.equal(layouts.size, 32, 'Distinct sample seeds should produce distinct layouts');
});

test('generated rooms preserve combat rules and surround the player with six legal spawn cells', () => {
  const base = createEncounter();
  for (let seed = 0; seed < 256; seed += 1) {
    const state = generateAnalysisRoom(seed);
    assert.deepEqual(state.player, base.player);
    assert.equal(state.enemies.length, 6);
    assert.equal(state.enemies.filter(enemy => enemy.kind === 'brawler').length, 4);
    assert.equal(state.enemies.filter(enemy => enemy.kind === 'lunger').length, 2);
    assert.equal(new Set(state.enemies.map(key)).size, 6, `Unique cells for seed ${seed}`);
    for (const enemy of state.enemies) {
      assert.ok(inside(enemy));
      assert.ok(distance(enemy, state.player) >= 2 && distance(enemy, state.player) <= 3);
    }
    assert.ok(state.enemies.some(enemy => enemy.y < state.player.y), `North for seed ${seed}`);
    assert.ok(state.enemies.some(enemy => enemy.y > state.player.y), `South for seed ${seed}`);
    assert.ok(state.enemies.some(enemy => enemy.x < state.player.x), `West for seed ${seed}`);
    assert.ok(state.enemies.some(enemy => enemy.x > state.player.x), `East for seed ${seed}`);
    // Position generation must not alter any other starting rule or enemy identity.
    const restored = structuredClone(state);
    restored.enemies.forEach((enemy, index) => {
      enemy.x = base.enemies[index].x;
      enemy.y = base.enemies[index].y;
    });
    assert.deepEqual(restored, base);
  }
});

test('generated rooms allow every initial step and can be played by the real combat engine', () => {
  for (const seed of [0, 1, 42, 1729, 0xffffffff]) {
    const state = generateAnalysisRoom(seed);
    const commands = legalCommands(state);
    const steps = commands.filter(command => command.type === 'Step');
    assert.equal(steps.length, 8, `All adjacent cells are clear for seed ${seed}`);
    assert.equal(commands.length, 9, 'Initial commands comprise eight steps and Wait');
    for (const command of commands) {
      const result = step(state, command);
      assert.equal(result.accepted, true, result.reason);
      assert.equal(result.state.beat, 1);
      assert.equal(result.state.phase, 'combat');
    }
  }
});

test('generated states are isolated from each other and from the live fixed encounter', () => {
  const fixed = createEncounter();
  const before = generateAnalysisRoom(0);
  const altered = generateAnalysisRoom(0);
  altered.player.hp = 1;
  altered.enemies[0].x = 1;
  altered.stats.actions.Wait = 99;
  altered.log.push('analysis only');
  assert.deepEqual(generateAnalysisRoom(0), before);
  assert.deepEqual(createEncounter(), fixed);
});

test('invalid analysis seeds fail instead of silently aliasing another room', () => {
  for (const seed of [-1, 0x100000000, 0.5, NaN, Infinity, -Infinity]) {
    assert.throws(() => generateAnalysisRoom(seed), /unsigned 32-bit integer/);
  }
});
