import { legalCommands, step } from '../src/engine';
import { distance, type Action, type Command, type State } from '../src/model';

export type SearchMode = 'exhaustive' | 'sampled';
export interface SearchOptions {
  mode: SearchMode;
  /** Sampled search preference; combo seeks a combo-focused witness, not unbiased action frequencies. */
  objective?: 'balanced' | 'combo';
  /** Number of additional player actions from the supplied initial state. */
  maxBeats: number;
  maxTransitions: number;
  beamWidth: number;
  /** Optional strategy restriction. Must be pure and must not mutate its inputs. */
  allowCommand?: (state: State, command: Command) => boolean;
  onWin?: (win: WinningSequence) => void;
}
export interface WinningSequence {
  commands: Command[];
  beats: number;
  hp: number;
  actions: Record<Action, number>;
}
export interface ActionSummary {
  min: number;
  max: number;
  total: number;
  usedInWins: number;
}
export interface SearchResult {
  mode: SearchMode;
  maxBeats: number;
  transitions: number;
  wins: number;
  /** Only exhaustive traversal can certify completion, within maxBeats and the allowed policy. */
  completed: boolean;
  stopReason: 'exhausted' | 'transition-limit' | 'beam-limit';
  /** Every reported winning sequence contributes once, including repeated states. */
  actionSummary: Record<Action, ActionSummary>;
}

const actions: Action[] = ['Step', 'Strike', 'Throw', 'Vault', 'Wait'];
const zeroActions = (): Record<Action, number> => ({ Step: 0, Strike: 0, Throw: 0, Vault: 0, Wait: 0 });
const actionOrder: Record<Action, number> = { Strike: 0, Throw: 1, Vault: 2, Step: 3, Wait: 4 };
const orderedCommands = (state: State): Command[] => legalCommands(state)
  .sort((a, b) => actionOrder[a.type] - actionOrder[b.type]);

function validate(options: SearchOptions): void {
  if (options.mode !== 'exhaustive' && options.mode !== 'sampled') throw new RangeError('Unknown search mode.');
  if (options.objective !== undefined && options.objective !== 'balanced' && options.objective !== 'combo') {
    throw new RangeError('Unknown search objective.');
  }
  for (const [name, minimum] of [['maxBeats', 0], ['maxTransitions', 1], ['beamWidth', 1]] as const) {
    if (!Number.isSafeInteger(options[name]) || options[name] < minimum) {
      throw new RangeError(`${name} must be a safe integer of at least ${minimum}.`);
    }
  }
}

/**
 * Find terminal wins and stream their command lists and action counts.
 *
 * Exhaustive mode walks the entire allowed legal command tree up to maxBeats,
 * unless maxTransitions is reached. An optional pure allowCommand predicate
 * restricts both modes before simulation and transition accounting. It
 * deliberately never merges states: different
 * paths (including detours and loops) are different winning sequences. Wins
 * stop at the first terminal state; actions after a win are not legal.
 *
 * Sampled mode is a deterministic, heuristic beam search. It merges equivalent
 * combat states and discards lower-scoring paths, so its counts describe only
 * discovered wins and it never claims exhaustive completion. Balanced scoring
 * rewards damage, kills, and survival. The optional combo objective deliberately
 * favors finishers to find a witness that wins using the intended combat loop.
 * Neither objective affects exhaustive enumeration or restricts legal actions.
 */
export function searchWins(initial: State, options: SearchOptions): SearchResult {
  validate(options);
  const commandsFor = (state: State): Command[] => orderedCommands(state)
    .filter(command => options.allowCommand?.(state, command) ?? true);
  const result: SearchResult = {
    mode: options.mode, maxBeats: options.maxBeats, transitions: 0, wins: 0,
    completed: options.mode === 'exhaustive',
    stopReason: options.mode === 'exhaustive' ? 'exhausted' : 'beam-limit',
    actionSummary: Object.fromEntries(actions.map(action => [action, {
      min: 0, max: 0, total: 0, usedInWins: 0,
    }])) as Record<Action, ActionSummary>,
  };

  const recordWin = (state: State, commands: Command[]): void => {
    const counts = zeroActions();
    for (const command of commands) counts[command.type] += 1;
    for (const action of actions) {
      const summary = result.actionSummary[action];
      summary.min = result.wins === 0 ? counts[action] : Math.min(summary.min, counts[action]);
      summary.max = Math.max(summary.max, counts[action]);
      summary.total += counts[action];
      if (counts[action] > 0) summary.usedInWins += 1;
    }
    result.wins += 1;
    // A consumer may retain or mutate its record without changing the search.
    options.onWin?.({ commands: structuredClone(commands), beats: commands.length, hp: state.player.hp, actions: counts });
  };
  const budgetAvailable = (): boolean => {
    if (result.transitions < options.maxTransitions) return true;
    result.completed = false;
    result.stopReason = 'transition-limit';
    return false;
  };
  const advance = (state: State, command: Command): State => {
    result.transitions += 1;
    const next = step(state, command);
    if (!next.accepted) throw new Error('Search encountered a command rejected by the game engine.');
    // Logs have no effect on combat and otherwise dominate repeated cloning.
    next.state.log = [];
    return next.state;
  };

  const start = structuredClone(initial);
  start.log = [];
  if (start.phase === 'won') recordWin(start, []);
  if (start.phase !== 'combat' || options.maxBeats === 0) return result;

  if (options.mode === 'exhaustive') {
    interface Frame { state: State; commands: Command[]; index: number }
    const stack: Frame[] = [{ state: start, commands: commandsFor(start), index: 0 }];
    const path: Command[] = [];
    // An explicit stack keeps large caller-supplied horizons off the JS stack.
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (frame.index === frame.commands.length) {
        stack.pop();
        if (stack.length) path.pop();
        continue;
      }
      if (!budgetAvailable()) return result;
      const command = frame.commands[frame.index++];
      const state = advance(frame.state, command);
      path.push(command);
      if (state.phase === 'won') recordWin(state, path);
      if (state.phase === 'combat' && path.length < options.maxBeats) {
        stack.push({ state, commands: commandsFor(state), index: 0 });
      } else path.pop();
    }
    return result;
  }

  const initialLiving = start.enemies.filter(enemy => enemy.hp > 0);
  const initialHp = initialLiving.reduce((sum, enemy) => sum + enemy.hp, 0);
  const score = (state: State): number => {
    const living = state.enemies.filter(enemy => enemy.hp > 0);
    const remainingHp = living.reduce((sum, enemy) => sum + enemy.hp, 0);
    const nearest = living.length ? Math.min(...living.map(enemy => distance(enemy, state.player))) : 0;
    const comboPreference = options.objective === 'combo'
      ? (state.stats.finisherKills - start.stats.finisherKills) * 140 + (state.player.combo?.hits ?? 0) * 8
      : 0;
    return comboPreference + (initialLiving.length - living.length) * 60
      + (initialHp - remainingHp) * 2 + state.player.hp * 8
      + living.reduce((sum, enemy) => sum + enemy.down * 0.5, 0)
      - nearest - (state.beat - start.beat) * 1.2;
  };
  const signature = (state: State): string => JSON.stringify([state.player, state.enemies, state.phase]);
  interface Candidate { state: State; commands: Command[]; value: number }
  let beam: Candidate[] = [{ state: start, commands: [], value: score(start) }];
  const seen = new Map<string, number>([[signature(start), beam[0].value]]);
  for (let depth = 0; depth < options.maxBeats && beam.length; depth++) {
    const next = new Map<string, Candidate>();
    for (const candidate of beam) {
      for (const command of commandsFor(candidate.state)) {
        if (!budgetAvailable()) return result;
        const state = advance(candidate.state, command);
        if (state.phase === 'dead') continue;
        if (state.phase === 'won') {
          recordWin(state, [...candidate.commands, command]);
          continue;
        }
        if (depth + 1 === options.maxBeats) continue;
        const key = signature(state), value = score(state);
        if ((seen.get(key) ?? -Infinity) >= value || (next.get(key)?.value ?? -Infinity) >= value) continue;
        next.set(key, { state, commands: [...candidate.commands, command], value });
      }
    }
    beam = [...next.values()].sort((a, b) => b.value - a.value).slice(0, options.beamWidth);
    for (const candidate of beam) seen.set(signature(candidate.state), candidate.value);
  }
  return result;
}
