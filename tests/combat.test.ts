import test from 'node:test';
import assert from 'node:assert/strict';
import { createEncounter, legalCommands, preview, step } from '../src/engine';
import { CONFIG, DIRS, equal, inside, key, type Command, type Enemy, type EnemyKind, type Pos, type State } from '../src/model';

function fixture(): State {
  const state = createEncounter();
  state.enemies = [];
  Object.assign(state.player, { x: 5, y: 4 });
  return state;
}

function enemy(state: State, position: Pos, kind: EnemyKind = 'brawler'): Enemy {
  const value: Enemy = {
    ...position, id: Math.max(0, ...state.enemies.map(e => e.id)) + 1,
    kind, hp: 12, maxHp: 12, intent: null, down: 0, recovery: 0,
  };
  state.enemies.push(value);
  return value;
}

function find(state: State, id: number): Enemy {
  const value = state.enemies.find(e => e.id === id);
  assert.ok(value, `Expected living enemy ${id}`);
  return value;
}

function apply(state: State, command: Command): State {
  const result = step(state, command);
  assert.equal(result.accepted, true, result.reason);
  assert.equal(result.state.beat, state.beat + 1);
  return result.state;
}

function tell(attacker: Enemy, cells: Pos[]): void {
  attacker.intent = {
    kind: attacker.kind === 'lunger' ? 'lunge' : 'punch',
    cells: cells.map(cell => ({ ...cell })),
    damage: attacker.kind === 'lunger' ? 4 : 3,
  };
}

function position(actor: Pos): Pos { return { x: actor.x, y: actor.y }; }

test('combat lab starts a repeatable surrounding encounter in a 9 by 7 interior', () => {
  const state = createEncounter();
  assert.deepEqual(state, createEncounter());
  assert.equal(CONFIG.width, 9);
  assert.equal(CONFIG.height, 7);
  assert.deepEqual(position(state.player), { x: 5, y: 4 });
  assert.equal(state.player.hp, 24);
  assert.equal(state.enemies.length, 6);
  assert.equal(state.enemies.filter(e => e.kind === 'brawler').length, 4);
  assert.equal(state.enemies.filter(e => e.kind === 'lunger').length, 2);
  assert.ok(state.enemies.every(e => e.hp === 12 && !e.intent && inside(e)));
  for (const direction of ['north', 'south', 'east', 'west']) {
    assert.ok(state.enemies.some(e => direction === 'north' ? e.y < state.player.y : direction === 'south' ? e.y > state.player.y : direction === 'east' ? e.x > state.player.x : e.x < state.player.x), direction);
  }
  for (const e of state.enemies) {
    const distance = Math.max(Math.abs(e.x - state.player.x), Math.abs(e.y - state.player.y));
    assert.ok(distance >= 2 && distance <= 3);
  }
});

for (const kind of ['brawler', 'lunger'] as const) {
  test(`${kind} cancels a deserted tell, spends the beat idle, and can act next beat`, () => {
    const state = fixture();
    const attacker = enemy(state, kind === 'brawler' ? { x: 4, y: 4 } : { x: 2, y: 4 }, kind);
    tell(attacker, kind === 'brawler' ? [{ x: 5, y: 4 }] : [{ x: 3, y: 4 }, { x: 4, y: 4 }, { x: 5, y: 4 }]);
    const command: Command = { type: 'Step', target: { x: 5, y: 5 } };
    const predicted = preview(state, command);
    assert.deepEqual(predicted.cancelled, [attacker.id]);
    assert.equal(predicted.incomingDamage, 0);
    const next = apply(state, command);
    const cancelled = find(next, attacker.id);
    assert.deepEqual(position(cancelled), position(attacker));
    assert.equal(cancelled.intent, null, 'Cancellation must not create another tell on the same beat');
    assert.equal(cancelled.recovery, 0, 'Cancelling an attack is not firing an attack');
    assert.equal(next.player.hp, 24);
    assert.equal(next.stats.cancelledAttacks, 1);
    const following = find(apply(next, { type: 'Wait' }), attacker.id);
    assert.ok(following.intent || !equal(following, cancelled), 'The enemy may act immediately on its next beat');
  });

  test(`${kind} also cancels after a vault carries the player off its tell`, () => {
    const state = fixture();
    const attacker = enemy(state, kind === 'brawler' ? { x: 4, y: 4 } : { x: 2, y: 4 }, kind);
    const crossed = enemy(state, { x: 5, y: 3 });
    tell(attacker, kind === 'brawler' ? [{ x: 5, y: 4 }] : [{ x: 3, y: 4 }, { x: 4, y: 4 }, { x: 5, y: 4 }]);
    const next = apply(state, { type: 'Vault', targetId: crossed.id });
    assert.deepEqual(position(next.player), { x: 5, y: 2 });
    assert.equal(next.player.hp, 24);
    assert.deepEqual(position(find(next, attacker.id)), position(attacker));
    assert.equal(find(next, attacker.id).intent, null);
    assert.equal(find(next, attacker.id).recovery, 0);
  });

  test(`${kind} that really attacks must recover for the following beat`, () => {
    const state = fixture();
    const attacker = enemy(state, kind === 'brawler' ? { x: 4, y: 4 } : { x: 2, y: 4 }, kind);
    tell(attacker, kind === 'brawler' ? [{ x: 5, y: 4 }] : [{ x: 3, y: 4 }, { x: 4, y: 4 }, { x: 5, y: 4 }]);
    const next = apply(state, { type: 'Wait' });
    assert.equal(next.player.hp, kind === 'brawler' ? 21 : 20);
    assert.equal(find(next, attacker.id).recovery, 1);
    assert.equal(find(next, attacker.id).intent, null);
    const recovery = apply(next, { type: 'Wait' });
    assert.deepEqual(position(find(recovery, attacker.id)), position(find(next, attacker.id)));
    assert.equal(find(recovery, attacker.id).intent, null);
    assert.equal(find(recovery, attacker.id).recovery, 0);
    assert.equal(recovery.player.hp, next.player.hp);
    assert.ok(find(apply(recovery, { type: 'Wait' }), attacker.id).intent);
  });
}

test('throwing a body across a committed lunge cancels it without recovery or retargeting', () => {
  const state = fixture();
  const attacker = enemy(state, { x: 2, y: 4 }, 'lunger');
  const body = enemy(state, { x: 5, y: 3 });
  const collision = enemy(state, { x: 3, y: 5 });
  tell(attacker, [{ x: 3, y: 4 }, { x: 4, y: 4 }, { x: 5, y: 4 }]);
  const command: Command = { type: 'Throw', targetId: body.id, direction: { x: -1, y: 1 } };
  const predicted = preview(state, command);
  assert.deepEqual(predicted.cancelled, [attacker.id]);
  assert.equal(predicted.incomingDamage, 0);
  const next = apply(state, command);
  assert.deepEqual(position(find(next, body.id)), { x: 4, y: 4 });
  assert.equal(find(next, collision.id).hp, 11);
  assert.equal(find(next, attacker.id).intent, null);
  assert.equal(find(next, attacker.id).recovery, 0);
  assert.deepEqual(position(find(next, attacker.id)), { x: 2, y: 4 });
  assert.equal(next.player.hp, 24);
});

test('new tells commit fixed cells and cannot attack on the telegraph beat', () => {
  const state = fixture();
  const attacker = enemy(state, { x: 4, y: 4 });
  const told = apply(state, { type: 'Wait' });
  assert.equal(told.player.hp, 24);
  assert.deepEqual(find(told, attacker.id).intent?.cells, [{ x: 5, y: 4 }]);
  const escaped = apply(told, { type: 'Step', target: { x: 5, y: 5 } });
  assert.equal(escaped.player.hp, 24, 'Still being adjacent does not allow retargeting');
  assert.equal(find(escaped, attacker.id).intent, null);
});

test('three consecutive strikes deal 1, 1, 10 and defeat a fresh enemy', () => {
  let state = fixture();
  const target = enemy(state, { x: 6, y: 4 });
  for (const [index, damage] of [1, 1, 10].entries()) {
    const current = find(state, target.id);
    tell(current, [position(state.player)]);
    const command: Command = { type: 'Strike', targetId: target.id };
    const predicted = preview(state, command);
    assert.equal(predicted.comboStage, index + 1);
    assert.deepEqual(predicted.hits, [{ enemyId: target.id, damage }]);
    assert.equal(predicted.incomingDamage, 0);
    state = apply(state, command);
    assert.equal(state.player.hp, 24);
    if (index < 2) {
      assert.equal(find(state, target.id).hp, 11 - index);
      assert.equal(find(state, target.id).intent, null);
      assert.deepEqual(state.player.combo, { targetId: target.id, hits: index + 1 });
    }
  }
  assert.equal(state.phase, 'won');
  assert.ok(!state.enemies.some(e => e.id === target.id && e.hp > 0));
  assert.equal(state.player.combo, null);
  assert.equal(state.stats.completedCombos, 1);
  assert.equal(state.stats.finisherKills, 1);
});

test('changing strike targets starts a fresh combo instead of carrying progress', () => {
  const state = fixture();
  const first = enemy(state, { x: 6, y: 4 });
  const second = enemy(state, { x: 4, y: 4 });
  first.down = second.down = 5;
  const opened = apply(state, { type: 'Strike', targetId: first.id });
  const switched = apply(opened, { type: 'Strike', targetId: second.id });
  assert.deepEqual(switched.player.combo, { targetId: second.id, hits: 1 });
  assert.equal(find(switched, second.id).hp, 11);
  assert.equal(switched.stats.brokenCombos, 1);
});

test('step, throw, vault and wait each break a combo', () => {
  for (const type of ['Step', 'Throw', 'Vault', 'Wait'] as const) {
    const state = fixture();
    const target = enemy(state, { x: 6, y: 4 });
    state.player.combo = { targetId: target.id, hits: 2 };
    const command: Command = type === 'Step' ? { type, target: { x: 5, y: 5 } }
      : type === 'Throw' ? { type, targetId: target.id, direction: { x: 1, y: 0 } }
      : type === 'Vault' ? { type, targetId: target.id } : { type };
    const next = apply(state, command);
    assert.equal(next.player.combo, null, type);
    assert.equal(next.stats.brokenCombos, 1, type);
  }
});

test('an incoming strike breaks combo progress gained by the player that beat', () => {
  const state = fixture();
  const target = enemy(state, { x: 6, y: 4 });
  const attacker = enemy(state, { x: 4, y: 4 });
  state.player.combo = { targetId: target.id, hits: 1 };
  tell(attacker, [position(state.player)]);
  const next = apply(state, { type: 'Strike', targetId: target.id });
  assert.equal(find(next, target.id).hp, 11);
  assert.equal(next.player.hp, 21);
  assert.equal(next.player.combo, null);
  assert.equal(preview(next, { type: 'Strike', targetId: target.id }).comboStage, 1);
});

test('a collision throw damages and knocks down two enemies, without chain collisions', () => {
  const state = fixture();
  const body = enemy(state, { x: 5, y: 3 });
  const victim = enemy(state, { x: 7, y: 3 });
  const beyond = enemy(state, { x: 8, y: 3 });
  beyond.down = 1;
  tell(body, [position(state.player)]);
  const command: Command = { type: 'Throw', targetId: body.id, direction: { x: 1, y: 0 } };
  const predicted = preview(state, command);
  assert.deepEqual(predicted.hits, [{ enemyId: body.id, damage: 1 }, { enemyId: victim.id, damage: 1 }]);
  assert.deepEqual(new Set(predicted.knockdowns), new Set([body.id, victim.id]));
  assert.deepEqual(predicted.pushes, [{ enemyId: body.id, from: { x: 5, y: 3 }, to: { x: 6, y: 3 } }]);
  const next = apply(state, command);
  for (const id of [body.id, victim.id]) {
    assert.equal(find(next, id).hp, 11);
    assert.equal(find(next, id).down, 2);
    assert.equal(find(next, id).intent, null);
  }
  assert.equal(find(next, beyond.id).hp, 12);
  assert.deepEqual(position(find(next, victim.id)), position(victim));
  assert.deepEqual(position(find(next, beyond.id)), position(beyond));
  assert.equal(next.player.hp, 24);
});

test('a thrown enemy skips the current beat and two more, then tells before dealing damage', () => {
  const state = fixture();
  const body = enemy(state, { x: 5, y: 3 });
  enemy(state, { x: 3, y: 3 });
  let next = apply(state, { type: 'Throw', targetId: body.id, direction: { x: -1, y: 0 } });
  assert.deepEqual(position(find(next, body.id)), { x: 4, y: 3 });
  for (const remaining of [1, 0]) {
    next = apply(next, { type: 'Wait' });
    assert.equal(find(next, body.id).down, remaining);
    assert.equal(find(next, body.id).intent, null);
    assert.deepEqual(position(find(next, body.id)), { x: 4, y: 3 });
    assert.equal(next.player.hp, 24);
  }
  next = apply(next, { type: 'Wait' });
  assert.ok(find(next, body.id).intent);
  assert.equal(next.player.hp, 24);
  next = apply(next, { type: 'Wait' });
  assert.ok(next.player.hp < 24);
});

test('throws stop at the perimeter without additional wall damage and require a free first cell', () => {
  const state = fixture();
  Object.assign(state.player, { x: 7, y: 4 });
  const body = enemy(state, { x: 8, y: 4 });
  const command: Command = { type: 'Throw', targetId: body.id, direction: { x: 1, y: 0 } };
  const next = apply(state, command);
  assert.deepEqual(position(find(next, body.id)), { x: 9, y: 4 });
  assert.equal(find(next, body.id).hp, 11);
  const wall = fixture();
  Object.assign(wall.player, { x: 8, y: 4 });
  const edge = enemy(wall, { x: 9, y: 4 });
  assert.equal(preview(wall, { type: 'Throw', targetId: edge.id, direction: { x: 1, y: 0 } }).valid, false);
  const occupied = fixture();
  const adjacent = enemy(occupied, { x: 6, y: 4 });
  enemy(occupied, { x: 7, y: 4 });
  assert.equal(preview(occupied, { type: 'Throw', targetId: adjacent.id, direction: { x: 1, y: 0 } }).valid, false);
  assert.equal(preview(occupied, { type: 'Throw', targetId: adjacent.id, direction: { x: -1, y: 0 } }).valid, false, 'Cannot throw into the player');
});

test('vault crosses standing or downed enemies but cannot land on actors or outside the arena', () => {
  for (const down of [0, 2]) {
    const state = fixture();
    const crossed = enemy(state, { x: 6, y: 4 });
    crossed.down = down;
    const next = apply(state, { type: 'Vault', targetId: crossed.id });
    assert.deepEqual(position(next.player), { x: 7, y: 4 });
    assert.equal(find(next, crossed.id).hp, 12);
    assert.deepEqual(position(find(next, crossed.id)), { x: 6, y: 4 });
  }
  const blocked = fixture();
  const crossed = enemy(blocked, { x: 6, y: 4 });
  enemy(blocked, { x: 7, y: 4 });
  assert.equal(preview(blocked, { type: 'Vault', targetId: crossed.id }).valid, false);
  Object.assign(blocked.player, { x: 8, y: 4 });
  Object.assign(crossed, { x: 9, y: 4 });
  assert.equal(preview(blocked, { type: 'Vault', targetId: crossed.id }).valid, false);
});

test('vault is unavailable until three other committed actions have passed', () => {
  const state = fixture();
  const crossed = enemy(state, { x: 6, y: 4 });
  crossed.down = 20;
  let next = apply(state, { type: 'Vault', targetId: crossed.id });
  assert.equal(next.player.vaultCooldown, 3);
  for (const cooldown of [2, 1, 0]) {
    const attempted = step(next, { type: 'Vault', targetId: crossed.id });
    assert.equal(attempted.accepted, false);
    assert.equal(attempted.state, next);
    next = apply(next, { type: 'Wait' });
    assert.equal(next.player.vaultCooldown, cooldown);
  }
  assert.equal(preview(next, { type: 'Vault', targetId: crossed.id }).valid, true);
});

test('vault does not protect the player when the landing cell remains in a committed lunge', () => {
  const state = fixture();
  const crossed = enemy(state, { x: 6, y: 4 });
  const attacker = enemy(state, { x: 7, y: 1 }, 'lunger');
  tell(attacker, [{ x: 7, y: 2 }, { x: 7, y: 3 }, { x: 7, y: 4 }]);
  const command: Command = { type: 'Vault', targetId: crossed.id };
  assert.equal(preview(state, command).incomingDamage, 4);
  const next = apply(state, command);
  assert.equal(next.player.hp, 20);
  assert.equal(find(next, attacker.id).recovery, 1);
});

test('diagonal steps cannot pass through an occupied corner', () => {
  const state = fixture();
  enemy(state, { x: 6, y: 4 });
  assert.equal(preview(state, { type: 'Step', target: { x: 6, y: 5 } }).valid, false);
  assert.equal(preview(state, { type: 'Step', target: { x: 4, y: 5 } }).valid, true);
});

test('invalid commands and all inspection preserve beat, combo, cooldown and the entire input state', () => {
  const state = fixture();
  const adjacent = enemy(state, { x: 6, y: 4 });
  const far = enemy(state, { x: 1, y: 1 });
  state.player.combo = { targetId: adjacent.id, hits: 2 };
  state.player.vaultCooldown = 2;
  const commands: Command[] = [
    { type: 'Step', target: { x: 0, y: 4 } },
    { type: 'Step', target: { x: 5, y: 4 } },
    { type: 'Step', target: { x: 7, y: 4 } },
    { type: 'Step', target: { x: 6, y: 4 } },
    { type: 'Step', target: { x: 5.5, y: 4 } },
    { type: 'Strike', targetId: 999 },
    { type: 'Strike', targetId: far.id },
    { type: 'Throw', targetId: far.id, direction: { x: 1, y: 0 } },
    { type: 'Throw', targetId: adjacent.id, direction: { x: 0, y: 0 } },
    { type: 'Throw', targetId: adjacent.id, direction: { x: 2, y: 0 } },
    { type: 'Vault', targetId: adjacent.id },
  ];
  const original = structuredClone(state);
  for (const command of commands) {
    const predicted = preview(state, command);
    assert.equal(predicted.valid, false, JSON.stringify(command));
    const result = step(state, command);
    assert.equal(result.accepted, false);
    assert.equal(result.state, state);
    assert.deepEqual(state, original);
  }
  legalCommands(state);
  preview(state, { type: 'Strike', targetId: adjacent.id });
  assert.deepEqual(state, original);
});

test('throwing an approaching crowd creates the safe three-strike opening that standing still lacks', () => {
  const state = fixture();
  const target = enemy(state, { x: 6, y: 4 });
  const incoming = enemy(state, { x: 5, y: 3 });
  enemy(state, { x: 7, y: 3 }, 'lunger');
  tell(incoming, [position(state.player)]);
  const unsafe = apply(state, { type: 'Strike', targetId: target.id });
  assert.equal(unsafe.player.hp, 21);
  assert.equal(unsafe.player.combo, null);
  let safe = apply(state, { type: 'Throw', targetId: incoming.id, direction: { x: 1, y: 0 } });
  assert.equal(safe.player.hp, 24);
  for (let hit = 0; hit < 3; hit++) {
    const command: Command = { type: 'Strike', targetId: target.id };
    assert.equal(preview(safe, command).incomingDamage, 0);
    safe = apply(safe, command);
  }
  assert.equal(safe.player.hp, 24);
  assert.equal(safe.stats.finisherKills, 1);
  assert.equal(safe.stats.completedCombos, 1);
  assert.ok(!safe.enemies.some(e => e.id === target.id && e.hp > 0));
});

test('legal command enumeration matches validation and excludes all actions after an encounter ends', () => {
  const state = fixture();
  enemy(state, { x: 6, y: 4 });
  enemy(state, { x: 4, y: 3 });
  const candidates: Command[] = [{ type: 'Wait' }];
  for (let y = 0; y <= 8; y++) for (let x = 0; x <= 10; x++) candidates.push({ type: 'Step', target: { x, y } });
  for (const e of state.enemies) {
    candidates.push({ type: 'Strike', targetId: e.id }, { type: 'Vault', targetId: e.id });
    for (const direction of DIRS) candidates.push({ type: 'Throw', targetId: e.id, direction });
  }
  const serialized = (commands: Command[]) => new Set(commands.map(command => JSON.stringify(command)));
  assert.deepEqual(serialized(legalCommands(state)), serialized(candidates.filter(command => preview(state, command).valid)));
  for (const phase of ['won', 'dead'] as const) {
    state.phase = phase;
    assert.deepEqual(legalCommands(state), []);
    assert.equal(step(state, { type: 'Wait' }).accepted, false);
  }
});

test('simultaneous attacks resolve without a hidden attacker cap and death ends the encounter', () => {
  const state = fixture();
  for (const cell of [{ x: 4, y: 4 }, { x: 5, y: 3 }, { x: 6, y: 4 }]) {
    tell(enemy(state, cell), [position(state.player)]);
  }
  state.player.hp = 8;
  const predicted = preview(state, { type: 'Wait' });
  assert.equal(predicted.incomingDamage, 9);
  assert.equal(predicted.threats.length, 3);
  const next = apply(state, { type: 'Wait' });
  assert.equal(next.phase, 'dead');
  assert.equal(next.player.hp, 0);
});

test('bounded fights stay deterministic, preserve inputs, and agree with every selected preview', () => {
  for (let seed = 1; seed <= 8; seed++) {
    let state = createEncounter();
    let random = seed;
    for (let count = 0; count < 80 && state.phase === 'combat'; count++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const available = legalCommands(state);
      assert.ok(available.length);
      const command = available[random % available.length];
      const original = structuredClone(state);
      const predicted = preview(state, command);
      assert.equal(predicted.valid, true);
      const result = step(state, command);
      assert.equal(result.accepted, true);
      assert.deepEqual(state, original);
      assert.deepEqual(result, step(state, command));
      const next = result.state;
      assert.equal(next.player.hp, Math.max(0, state.player.hp - predicted.incomingDamage));
      assert.equal(next.stats.damageTaken - state.stats.damageTaken, Math.min(state.player.hp, predicted.incomingDamage));
      if (predicted.destination) assert.deepEqual(position(next.player), predicted.destination);
      for (const hit of predicted.hits) {
        const remaining = next.enemies.find(e => e.id === hit.enemyId);
        assert.equal(remaining?.hp ?? 0, Math.max(0, find(state, hit.enemyId).hp - hit.damage));
      }
      for (const pushed of predicted.pushes) {
        const remaining = next.enemies.find(e => e.id === pushed.enemyId);
        if (remaining) assert.deepEqual(position(remaining), pushed.to);
      }
      const actors = [next.player, ...next.enemies.filter(e => e.hp > 0)];
      assert.ok(actors.every(inside));
      assert.equal(new Set(actors.map(key)).size, actors.length);
      assert.ok(next.enemies.every(e => e.hp >= 0 && e.down >= 0 && e.recovery >= 0));
      state = next;
    }
  }
});
