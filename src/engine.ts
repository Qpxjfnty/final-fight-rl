import {
  CONFIG, DIRS, add, distance, equal, inside,
  type Command, type Enemy, type Intent, type Pos, type Preview, type State, type StepResult,
} from './model';

const position = ({ x, y }: Pos): Pos => ({ x, y });
const living = (state: State): Enemy[] => state.enemies.filter(enemy => enemy.hp > 0).sort((a, b) => a.id - b.id);
const enemyAt = (state: State, cell: Pos, ignoredId?: number): Enemy | undefined =>
  state.enemies.find(enemy => enemy.hp > 0 && enemy.id !== ignoredId && equal(enemy, cell));
const occupied = (state: State, cell: Pos, ignoredId?: number): boolean =>
  equal(state.player, cell) || Boolean(enemyAt(state, cell, ignoredId));
const free = (state: State, cell: Pos, ignoredId?: number): boolean => inside(cell) && !occupied(state, cell, ignoredId);

function canWalk(state: State, from: Pos, to: Pos, ignoredId?: number): boolean {
  if (distance(from, to) !== 1 || !free(state, to, ignoredId)) return false;
  if (from.x !== to.x && from.y !== to.y) {
    return free(state, { x: from.x, y: to.y }, ignoredId)
      || free(state, { x: to.x, y: from.y }, ignoredId);
  }
  return true;
}

function emptyPreview(): Preview {
  return {
    valid: false, reason: '', freeStep: false, comboStage: 0, hits: [], pushes: [], lunges: [], destination: null,
    path: [], knockdowns: [], interrupted: [], cancelled: [], threats: [], incomingDamage: 0,
  };
}

interface ThrowPath { landing: Pos; path: Pos[]; collision?: Enemy }
function throwPath(state: State, enemy: Enemy, direction: Pos): ThrowPath | null {
  if (!Number.isInteger(direction.x) || !Number.isInteger(direction.y)
    || Math.abs(direction.x) > 1 || Math.abs(direction.y) > 1
    || (direction.x === 0 && direction.y === 0)) return null;
  const path: Pos[] = [];
  let collision: Enemy | undefined;
  for (let n = 1; n <= CONFIG.throwRange; n += 1) {
    const cell = add(enemy, direction, n);
    if (!inside(cell) || equal(state.player, cell)) break;
    const other = enemyAt(state, cell, enemy.id);
    if (other) { collision = other; break; }
    path.push(cell);
  }
  // An immediately adjacent obstacle leaves no legal landing cell.
  return path.length ? { landing: path[path.length - 1], path, collision } : null;
}

function validationError(state: State, command: Command): string | null {
  if (state.phase !== 'combat') return 'This fight has ended. Restart to fight again.';
  if (command.type === 'Wait') return null;
  if (command.type === 'Step') {
    if (!inside(command.target)) return 'Stay inside the arena.';
    if (distance(state.player, command.target) !== 1) return 'Step to one neighboring cell.';
    if (!free(state, command.target)) return 'That cell is occupied.';
    if (!canWalk(state, state.player, command.target)) return 'You cannot step diagonally between two enemies.';
    return null;
  }
  const target = state.enemies.find(enemy => enemy.id === command.targetId && enemy.hp > 0);
  if (!target) return 'Choose a living enemy.';
  if (distance(state.player, target) !== 1) return 'Choose an adjacent enemy.';
  if (command.type === 'Strike') return null;
  if (command.type === 'Throw') {
    return throwPath(state, target, command.direction) ? null : 'There is no empty landing cell in that direction.';
  }
  if (state.player.vaultCooldown > 0) return `Vault needs ${state.player.vaultCooldown} more action${state.player.vaultCooldown === 1 ? '' : 's'}.`;
  const destination = add(target, { x: target.x - state.player.x, y: target.y - state.player.y });
  return free(state, destination) ? null : 'The cell beyond that enemy must be empty and inside the arena.';
}

/** Follow the committed ray even after a dodge, stopping before a body or target. */
function resolveLunge(state: State, enemy: Enemy, intent: Intent): { landing: Pos; canHit: boolean } {
  let landing = position(enemy);
  for (let index = 0; index < intent.cells.length; index += 1) {
    const cell = intent.cells[index];
    if (!inside(cell) || enemyAt(state, cell, enemy.id)) break;
    if (equal(cell, state.player)) return { landing, canHit: true };
    // The last cell is the attack target, not a movement destination.
    if (index < intent.cells.length - 1) landing = position(cell);
  }
  return { landing, canHit: false };
}

function makeIntent(state: State, enemy: Enemy, from: Pos = enemy): Intent | null {
  if (enemy.kind === 'brawler') {
    return distance(from, state.player) === 1
      ? { kind: 'punch', cells: [position(state.player)], damage: CONFIG.punchDamage }
      : null;
  }
  const dx = state.player.x - from.x;
  const dy = state.player.y - from.y;
  const range = distance(from, state.player);
  if (range < 1 || range > CONFIG.lungeRange || (dx !== 0 && dy !== 0 && Math.abs(dx) !== Math.abs(dy))) return null;
  const cells: Pos[] = [];
  const direction = { x: Math.sign(dx), y: Math.sign(dy) };
  for (let n = 1; n <= range; n += 1) {
    const cell = add(from, direction, n);
    if (!inside(cell) || enemyAt(state, cell, enemy.id)) return null;
    cells.push(cell);
  }
  return { kind: 'lunge', cells, damage: CONFIG.lungeDamage };
}

/** Find the first step of a shortest legal route to a position that can threaten. */
function nextEnemyStep(state: State, enemy: Enemy): Pos | null {
  const queue: { cell: Pos; first: Pos | null }[] = [{ cell: position(enemy), first: null }];
  const seen = new Set([`${enemy.x},${enemy.y}`]);
  for (let index = 0; index < queue.length; index += 1) {
    const node = queue[index];
    if (node.first && makeIntent(state, enemy, node.cell)) return node.first;
    for (const direction of DIRS) {
      const cell = add(node.cell, direction);
      const key = `${cell.x},${cell.y}`;
      if (seen.has(key) || !canWalk(state, node.cell, cell, enemy.id)) continue;
      seen.add(key);
      queue.push({ cell, first: node.first ?? cell });
    }
  }
  return null;
}

function breakCombo(state: State, events: string[]): void {
  if (!state.player.combo) return;
  state.player.combo = null;
  state.stats.brokenCombos += 1;
  events.push('Combo broken.');
}

interface Simulation { result: StepResult; preview: Preview }
function simulate(original: State, command: Command): Simulation {
  const details = emptyPreview();
  const error = validationError(original, command);
  if (error) {
    details.reason = error;
    return { result: { accepted: false, state: original, events: [], reason: error }, preview: details };
  }
  details.valid = true;
  const state: State = structuredClone(original);
  const events: string[] = [];
  const suppressed = new Set<number>();
  const spentTurn = new Set<number>();
  const justAttacked = new Set<number>();
  const freeStep = state.openingStepAvailable && state.beat === 0 && command.type === 'Step';
  details.freeStep = freeStep;
  state.openingStepAvailable = false;
  if (!freeStep) state.beat += 1;
  state.stats.actions[command.type] += 1;

  if (command.type !== 'Strike' || state.player.combo?.targetId !== command.targetId) breakCombo(state, events);
  if (!freeStep && command.type !== 'Vault' && state.player.vaultCooldown > 0) state.player.vaultCooldown -= 1;

  const suppress = (enemy: Enemy): void => {
    suppressed.add(enemy.id);
    if (enemy.intent) details.interrupted.push(enemy.id);
    enemy.intent = null;
  };
  const hurtEnemy = (enemy: Enemy, damage: number): void => {
    details.hits.push({ enemyId: enemy.id, damage });
    enemy.hp = Math.max(0, enemy.hp - damage);
    if (enemy.hp === 0) events.push(`Enemy ${enemy.id} is defeated.`);
  };

  if (command.type === 'Step') {
    details.destination = position(command.target);
    details.path = [position(command.target)];
    Object.assign(state.player, command.target);
    events.push(freeStep
      ? `Free opening step to ${command.target.x},${command.target.y}. Enemies wait; act again.`
      : `Step to ${command.target.x},${command.target.y}.`);
  } else if (command.type === 'Wait') {
    events.push('Wait one beat.');
  } else {
    const target = state.enemies.find(enemy => enemy.id === command.targetId)!;
    if (command.type === 'Strike') {
      const stage = state.player.combo?.targetId === target.id ? state.player.combo.hits + 1 : 1;
      details.comboStage = stage as 1 | 2 | 3;
      const damage = CONFIG.strikeDamage[stage - 1];
      suppress(target);
      events.push(`Strike ${stage}/3 hits enemy ${target.id} for ${damage}.`);
      hurtEnemy(target, damage);
      if (stage === 3) {
        state.stats.completedCombos += 1;
        if (target.hp === 0) state.stats.finisherKills += 1;
        state.player.combo = null;
      } else {
        state.player.combo = target.hp > 0 ? { targetId: target.id, hits: stage as 1 | 2 } : null;
      }
    } else if (command.type === 'Throw') {
      const trajectory = throwPath(state, target, command.direction)!;
      details.path = trajectory.path.map(position);
      details.pushes.push({ enemyId: target.id, from: position(target), to: position(trajectory.landing) });
      Object.assign(target, trajectory.landing);
      events.push(`Throw enemy ${target.id} to ${target.x},${target.y}.`);
      for (const enemy of [target, ...(trajectory.collision ? [trajectory.collision] : [])]) {
        suppress(enemy);
        enemy.down = CONFIG.knockdownBeats;
        enemy.recovery = 0;
        details.knockdowns.push(enemy.id);
        hurtEnemy(enemy, CONFIG.throwDamage);
      }
      if (trajectory.collision) events.push(`The thrown body knocks down enemy ${trajectory.collision.id}.`);
    } else {
      const destination = add(target, { x: target.x - state.player.x, y: target.y - state.player.y });
      details.destination = destination;
      details.path = [position(target), position(destination)];
      Object.assign(state.player, destination);
      state.player.vaultCooldown = CONFIG.vaultCooldown;
      events.push(`Vault over enemy ${target.id} to ${destination.x},${destination.y}.`);
    }
  }

  if (freeStep) {
    state.log = [...state.log, ...events.map(event => `[${state.beat}] ${event}`)].slice(-80);
    return { result: { accepted: true, state, events }, preview: details };
  }

  // Resolve only the tells already present before this beat. Every such enemy
  // spends its turn, whether it attacks, is interrupted, or cancels for no target.
  for (const enemy of living(state)) {
    if (suppressed.has(enemy.id) || enemy.down > 0 || enemy.recovery > 0) {
      spentTurn.add(enemy.id);
      enemy.intent = null;
      continue;
    }
    const intent = enemy.intent;
    if (!intent) continue;
    spentTurn.add(enemy.id);
    enemy.intent = null;
    const lunge = intent.kind === 'lunge' ? resolveLunge(state, enemy, intent) : null;
    const canHit = intent.kind === 'lunge'
      ? lunge!.canHit
      : distance(enemy, state.player) === 1 && intent.cells.some(cell => equal(cell, state.player));
    if (lunge && !equal(enemy, lunge.landing)) {
      details.lunges.push({ enemyId: enemy.id, from: position(enemy), to: position(lunge.landing) });
      Object.assign(enemy, lunge.landing);
      events.push(`Enemy ${enemy.id} lunges to ${enemy.x},${enemy.y}.`);
    }
    if (!canHit) {
      details.cancelled.push(enemy.id);
      state.stats.cancelledAttacks += 1;
      events.push(`Enemy ${enemy.id} cancels its attack: no reachable target. Its turn ends without recovery.`);
      continue;
    }
    details.threats.push({ enemyId: enemy.id, cells: intent.cells.map(position), damage: intent.damage });
    details.incomingDamage += intent.damage;
    breakCombo(state, events);
    const damage = Math.min(state.player.hp, intent.damage);
    state.player.hp -= damage;
    state.stats.damageTaken += damage;
    enemy.recovery = 1;
    justAttacked.add(enemy.id);
    events.push(`Enemy ${enemy.id} ${intent.kind === 'lunge' ? 'lunges' : 'punches'} for ${intent.damage}.`);
  }

  if (state.player.hp <= 0) {
    state.phase = 'dead';
    events.push('You are defeated. Restart to try another approach.');
  } else if (living(state).length === 0) {
    state.phase = 'won';
    events.push('Arena cleared.');
  } else {
    for (const enemy of living(state)) {
      if (spentTurn.has(enemy.id)) continue;
      let intent = makeIntent(state, enemy);
      let moved = false;
      if (!intent) {
        const destination = nextEnemyStep(state, enemy);
        if (destination) { Object.assign(enemy, destination); moved = true; }
        intent = makeIntent(state, enemy);
      }
      enemy.intent = intent;
      if (intent) events.push(`Enemy ${enemy.id} ${moved ? 'advances and readies' : 'readies'} a ${intent.kind} for next beat.`);
    }
  }

  for (const enemy of state.enemies) {
    if (enemy.down > 0) enemy.down -= 1;
    if (enemy.recovery > 0 && !justAttacked.has(enemy.id)) enemy.recovery -= 1;
    if (enemy.hp === 0) { enemy.intent = null; enemy.down = 0; enemy.recovery = 0; }
  }
  state.log = [...state.log, ...events.map(event => `[${state.beat}] ${event}`)].slice(-80);
  return { result: { accepted: true, state, events }, preview: details };
}

export function createEncounter(): State {
  const placements: [Enemy['kind'], number, number][] = [
    ['brawler', 5, 2], ['brawler', 7, 3], ['brawler', 5, 6], ['brawler', 3, 5],
    ['lunger', 2, 4], ['lunger', 8, 4],
  ];
  return {
    version: 'combat-lab-v1', phase: 'combat', beat: 0, openingStepAvailable: true,
    player: { x: 5, y: 4, hp: CONFIG.playerHp, maxHp: CONFIG.playerHp, combo: null, vaultCooldown: 0 },
    enemies: placements.map(([kind, x, y], index) => ({
      id: index + 1, kind, x, y, hp: CONFIG.enemyHp, maxHp: CONFIG.enemyHp,
      intent: null, down: 0, recovery: 0,
    })),
    stats: {
      completedCombos: 0, brokenCombos: 0, finisherKills: 0, damageTaken: 0, cancelledAttacks: 0,
      actions: { Step: 0, Strike: 0, Throw: 0, Vault: 0, Wait: 0 },
    },
    log: ['Surrounded. Interrupt threats and make room for a three-hit combo.'],
  };
}

/** Full beat simulation shared with step makes every preview mechanically exact. */
export function preview(state: State, command: Command): Preview {
  return simulate(state, command).preview;
}

export function step(state: State, command: Command): StepResult {
  return simulate(state, command).result;
}

export function legalCommands(state: State): Command[] {
  if (state.phase !== 'combat') return [];
  const commands: Command[] = [{ type: 'Wait' }];
  for (const direction of DIRS) commands.push({ type: 'Step', target: add(state.player, direction) });
  for (const enemy of living(state)) {
    if (distance(state.player, enemy) !== 1) continue;
    commands.push({ type: 'Strike', targetId: enemy.id }, { type: 'Vault', targetId: enemy.id });
    for (const direction of DIRS) commands.push({ type: 'Throw', targetId: enemy.id, direction: position(direction) });
  }
  return commands.filter(command => validationError(state, command) === null);
}
