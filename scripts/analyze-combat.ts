import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEncounter, step } from '../src/engine';
import { type Action, type Command, type State } from '../src/model';
import { generateAnalysisRoom } from './analysis-rooms';
import { searchWins, type SearchMode, type WinningSequence } from './winning-search';

const ACTIONS: Action[] = ['Step', 'Strike', 'Throw', 'Vault', 'Wait'];
export interface AnalysisOptions {
  mode: SearchMode; rooms: number; seed: number; maxBeats: number;
  objective: 'combo' | 'balanced';
  maxTransitions: number; beamWidth: number; output: string;
}
const HELP = `Combat action-usage analysis

Usage: npm run analyze -- [options]
  --mode sampled|exhaustive  Search strategy (default: sampled)
  --rooms N                 Generated rooms in addition to the fixed demo (default: 4)
  --seed N                  First unsigned 32-bit room seed (default: 1)
  --max-beats N             Maximum player actions, including a free Step (default: 40)
  --objective combo|balanced  Sampled search priority (default: combo)
  --max-transitions N       Simulated-action budget per room (default: 75000)
  --beam-width N            Paths retained per sampled-search layer (default: 96)
  --output PATH             Parent folder for a new report directory
  --help                    Show this help

The legacy --max-beats name counts player actions, not elapsed combat beats.
Exhaustive mode keeps distinct paths, including loops, up to that action limit. It only
claims completeness when all paths through that horizon have been visited.
Sampled mode prunes paths and is a biased sample, not an exhaustive census.
A room passes when at least one replayed win gets more than 50% of its effective
damage from combo finishers. Chip wins are allowed. Missing a combo-focused win
in a partial search flags review, not proof that only chip strategies can win.
`;

export function parseOptions(args: string[]): AnalysisOptions {
  const options: AnalysisOptions = {
    mode: 'sampled', objective: 'combo', rooms: 4, seed: 1, maxBeats: 40, maxTransitions: 75_000, beamWidth: 96,
    output: fileURLToPath(new URL('../work/qa/combat-analysis/', import.meta.url)),
  };
  const integerKeys = {
    '--rooms': ['rooms', 0], '--seed': ['seed', 0], '--max-beats': ['maxBeats', 0],
    '--max-transitions': ['maxTransitions', 1], '--beam-width': ['beamWidth', 1],
  } as const;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (seen.has(flag)) throw new Error(`Repeated option: ${flag}`);
    seen.add(flag);
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    if (flag === '--mode') {
      if (value !== 'sampled' && value !== 'exhaustive') throw new Error('Mode must be sampled or exhaustive.');
      options.mode = value;
    } else if (flag === '--objective') {
      if (value !== 'combo' && value !== 'balanced') throw new Error('Objective must be combo or balanced.');
      options.objective = value;
    } else if (flag === '--output') {
      if (!value.trim()) throw new Error('Output path must not be empty.');
      options.output = resolve(value);
    } else if (Object.hasOwn(integerKeys, flag)) {
      const [key, minimum] = integerKeys[flag as keyof typeof integerKeys];
      const number = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < minimum) {
        throw new Error(`${flag} must be an integer >= ${minimum}.`);
      }
      options[key] = number;
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }
  if (options.seed > 0xffff_ffff) throw new Error('--seed must fit an unsigned 32-bit integer.');
  return options;
}

export interface WinMetrics {
  completedCombos: number; brokenCombos: number; finisherKills: number;
  chipStrikeActions: number; chipStrikeDamage: number; finisherDamage: number;
  throwDamage: number; damageTaken: number;
  /** Elapsed combat beat of the first completed third Strike; null for wins without a finisher. */
  firstComboBeat: number | null;
  /** One-based player action index of that third Strike, including any free opening Step. */
  firstComboAction: number | null;
}
type TotalMetric = Exclude<keyof WinMetrics, 'firstComboBeat' | 'firstComboAction'>;
const METRICS: TotalMetric[] = [
  'completedCombos', 'brokenCombos', 'finisherKills', 'chipStrikeActions',
  'chipStrikeDamage', 'finisherDamage', 'throwDamage', 'damageTaken',
];
export const allowsNoFinisher = (state: State, command: Command): boolean =>
  command.type !== 'Strike' || state.player.combo?.targetId !== command.targetId || state.player.combo.hits !== 2;

/** Verify every witness and measure actual HP removed, including overkill clipping. */
export function verifyWin(initial: State, win: WinningSequence): WinMetrics {
  let state = initial;
  const metrics = {
    ...Object.fromEntries(METRICS.map(metric => [metric, 0])), firstComboBeat: null, firstComboAction: null,
  } as unknown as WinMetrics;
  const counts = Object.fromEntries(ACTIONS.map(action => [action, 0])) as Record<Action, number>;
  for (const [index, command] of win.commands.entries()) {
    const result = step(state, command);
    if (!result.accepted) throw new Error(`Winning sequence contains an invalid action: ${result.reason}`);
    if (metrics.firstComboBeat === null && result.state.stats.completedCombos > state.stats.completedCombos) {
      metrics.firstComboBeat = result.state.beat - initial.beat;
      metrics.firstComboAction = index + 1;
    }
    const removed = state.enemies.reduce((sum, enemy) =>
      sum + enemy.hp - (result.state.enemies.find(after => after.id === enemy.id)?.hp ?? 0), 0);
    if (command.type === 'Strike') {
      if (allowsNoFinisher(state, command)) {
        metrics.chipStrikeActions += 1;
        metrics.chipStrikeDamage += removed;
      } else metrics.finisherDamage += removed;
    } else if (command.type === 'Throw') metrics.throwDamage += removed;
    state = result.state;
    counts[command.type] += 1;
  }
  if (state.phase !== 'won' || state.player.hp !== win.hp || win.actionCount !== win.commands.length
    || win.beats !== state.beat - initial.beat
    || ACTIONS.some(action => win.actions[action] !== counts[action])) {
    throw new Error('Winning sequence failed replay or action-count verification.');
  }
  metrics.completedCombos = state.stats.completedCombos - initial.stats.completedCombos;
  metrics.brokenCombos = state.stats.brokenCombos - initial.stats.brokenCombos;
  metrics.finisherKills = state.stats.finisherKills - initial.stats.finisherKills;
  metrics.damageTaken = state.stats.damageTaken - initial.stats.damageTaken;
  return metrics;
}

export interface Distribution {
  count: number; min: number; median: number; max: number; mean: number;
  histogram: Array<{ value: number; wins: number }>;
}

/** Weighted distribution over recorded wins, with no need to retain every winning path in memory. */
export function summarizeDistribution(counts: Map<number, number>): Distribution | null {
  const histogram = [...counts].sort(([left], [right]) => left - right)
    .map(([value, wins]) => ({ value, wins }));
  const count = histogram.reduce((sum, item) => sum + item.wins, 0);
  if (count === 0) return null;
  const lowerIndex = Math.floor((count - 1) / 2), upperIndex = Math.floor(count / 2);
  let visited = 0, lower = 0, upper = 0;
  for (const { value, wins } of histogram) {
    if (visited <= lowerIndex && visited + wins > lowerIndex) lower = value;
    if (visited <= upperIndex && visited + wins > upperIndex) upper = value;
    visited += wins;
  }
  return {
    count, min: histogram[0].value, median: (lower + upper) / 2,
    max: histogram[histogram.length - 1].value,
    mean: histogram.reduce((sum, item) => sum + item.value * item.wins, 0) / count,
    histogram,
  };
}

export function finisherShare(metrics: WinMetrics): number {
  const total = metrics.finisherDamage + metrics.chipStrikeDamage + metrics.throwDamage;
  return total ? metrics.finisherDamage / total : 0;
}

export function comboVerdict(qualifyingWins: number, totalWins: number, completed: boolean): string {
  if (qualifyingWins > 0) return 'pass';
  if (completed) return 'no-combo-win-within-horizon';
  return totalWins > 0 ? 'needs-review' : 'inconclusive';
}

export function runAnalysis(options: AnalysisOptions): string {
  mkdirSync(options.output, { recursive: true });
  const directory = mkdtempSync(join(options.output, 'run-'));
  const csv = openSync(join(directory, 'wins.csv'), 'wx');
  const jsonl = openSync(join(directory, 'winning-sequences.jsonl'), 'wx');
  const rooms = [{ id: 'demo', seed: null as number | null, initial: createEncounter() }];
  for (let index = 0; index < options.rooms; index++) {
    const seed = (options.seed + index) >>> 0;
    rooms.push({ id: `seed-${seed}`, seed, initial: generateAnalysisRoom(seed) });
  }
  const reports: Array<Record<string, unknown>> = [];
  const markdown = [
    '# Combat action-usage analysis', '',
    `Mode: **${options.mode}**, objective: **${options.objective}**. Horizon: **${options.maxBeats} actions**. Budget: **${options.maxTransitions} simulated actions per room**.`, '',
    'A free opening Step counts as one action and zero combat beats. The horizon includes every player action. The legacy maxBeats option names this action limit.', '',
    'First-combo timing records the completed third Strike, not the first hit of an attempt. Combat beat and player action indices are measured from the room start; they are one-based. Turns before that combo equal its combat beat minus one. Wins without a completed combo have null timings and are excluded from timing distributions.', '',
    'A recorded win is replay-verified. Sampled results are biased toward the search heuristic; action frequencies are not player usage rates or proof that an action is necessary.', '',
    'Only a completed exhaustive search covers every allowed legal winning sequence within its horizon. Partial searches cannot establish that a room is unwinnable. Loops remain distinct sequences and are bounded by the action limit.', '',
    '**Room pass criterion:** at least one replayed winning sequence gets **more than 50% of actual enemy HP removed from combo finishers**. Chip-damage wins are allowed and do not fail a room. Missing such a witness in a partial search means review is needed, not that only chip strategies can win.', '',
    'The combo objective deliberately searches for qualifying witnesses. Use balanced to explore alternate strategies; neither sampled mode estimates the frequency of all possible wins.', '',
  ];
  try {
    writeSync(csv, ['room', 'win', 'actionCount', 'beats', 'hp', ...ACTIONS, ...METRICS,
      'firstComboBeat', 'firstComboAction', 'finisherDamageShare', 'comboFocused'].join(',') + '\n');
    writeFileSync(join(directory, 'rooms.json'), JSON.stringify(rooms, null, 2) + '\n');
    for (const room of rooms) {
      let recorded = 0;
      let minActions = Infinity, maxActions = 0, minBeats = Infinity, maxBeats = 0, minHp = Infinity, maxHp = 0;
      const profiles = new Map<string, number>();
      let winsWithoutFinishers = 0, qualifyingWins = 0, finisherShareTotal = 0, minFinisherShare = Infinity, maxFinisherShare = 0;
      const firstComboBeats = new Map<number, number>(), firstComboActions = new Map<number, number>();
      let witness: (WinningSequence & { metrics: WinMetrics; finisherDamageShare: number }) | null = null;
      const tactics = Object.fromEntries(METRICS.map(metric => [metric, { min: Infinity, max: 0, total: 0 }])) as
        Record<TotalMetric, { min: number; max: number; total: number }>;
      const result = searchWins(room.initial, {
        ...options,
        onWin(win) {
          const metrics = verifyWin(room.initial, win);
          if (metrics.completedCombos === 0) winsWithoutFinishers += 1;
          if (metrics.firstComboBeat !== null && metrics.firstComboAction !== null) {
            firstComboBeats.set(metrics.firstComboBeat, (firstComboBeats.get(metrics.firstComboBeat) ?? 0) + 1);
            firstComboActions.set(metrics.firstComboAction, (firstComboActions.get(metrics.firstComboAction) ?? 0) + 1);
          }
          const share = finisherShare(metrics);
          const comboFocused = share > 0.5;
          if (comboFocused) {
            qualifyingWins += 1;
            if (!witness || win.actionCount < witness.actionCount || (win.actionCount === witness.actionCount && win.hp > witness.hp)) {
              witness = { ...win, metrics, finisherDamageShare: share };
            }
          }
          maxFinisherShare = Math.max(maxFinisherShare, share);
          minFinisherShare = Math.min(minFinisherShare, share); finisherShareTotal += share;
          for (const metric of METRICS) {
            tactics[metric].min = Math.min(tactics[metric].min, metrics[metric]);
            tactics[metric].max = Math.max(tactics[metric].max, metrics[metric]);
            tactics[metric].total += metrics[metric];
          }
          recorded += 1;
          minActions = Math.min(minActions, win.actionCount); maxActions = Math.max(maxActions, win.actionCount);
          minBeats = Math.min(minBeats, win.beats); maxBeats = Math.max(maxBeats, win.beats);
          minHp = Math.min(minHp, win.hp); maxHp = Math.max(maxHp, win.hp);
          const profile = ACTIONS.map(action => win.actions[action]).join(',');
          profiles.set(profile, (profiles.get(profile) ?? 0) + 1);
          writeSync(csv, [room.id, recorded, win.actionCount, win.beats, win.hp, ...ACTIONS.map(action => win.actions[action]),
            ...METRICS.map(metric => metrics[metric]), metrics.firstComboBeat, metrics.firstComboAction, share, comboFocused].join(',') + '\n');
          writeSync(jsonl, JSON.stringify({ room: room.id, win: recorded, ...win, metrics, finisherDamageShare: share, comboFocused }) + '\n');
        },
      });
      if (recorded !== result.wins) throw new Error('Recorded win count differs from search result.');
      const verdict = result.wins ? 'winnable' : result.completed ? 'no-win-within-horizon' : 'inconclusive';
      const roomCheck = comboVerdict(qualifyingWins, result.wins, result.completed);
      const firstComboTiming = {
        winsWithCombo: recorded - winsWithoutFinishers, winsWithoutCombo: winsWithoutFinishers,
        combatBeat: summarizeDistribution(firstComboBeats), playerAction: summarizeDistribution(firstComboActions),
        combatBeatsBefore: summarizeDistribution(new Map([...firstComboBeats].map(([beat, wins]) => [beat - 1, wins]))),
      };
      const report = {
        room: room.id, seed: room.seed, verdict, roomCheck, ...result,
        qualifyingWins, comboWitness: witness, winsWithoutFinishers, tactics: recorded ? tactics : null,
        firstComboTiming,
        finisherDamageShare: recorded ? { min: minFinisherShare, max: maxFinisherShare, mean: finisherShareTotal / recorded } : null,
        actionCount: recorded ? { min: minActions, max: maxActions } : null,
        beats: recorded ? { min: minBeats, max: maxBeats } : null,
        hp: recorded ? { min: minHp, max: maxHp } : null,
        actionProfiles: [...profiles].map(([counts, wins]) => ({
          actions: Object.fromEntries(ACTIONS.map((action, index) => [action, Number(counts.split(',')[index])])), wins,
        })),
      };
      reports.push(report);
      console.log(`${room.id}: ${roomCheck}; ${qualifyingWins}/${recorded} combo-focused wins; ${result.transitions} transitions; ${result.completed ? 'complete within horizon' : 'partial'} (${result.stopReason})`);
      markdown.push(`## ${room.id}`, '',
        `**${roomCheck}** · ${qualifyingWins} combo-focused wins out of ${recorded} verified winning sequences · ${result.transitions} simulated actions · ${result.completed ? 'complete within horizon' : 'partial search'} (${result.stopReason}).`, '');
      if (recorded) {
        markdown.push(`Wins take ${minActions}–${maxActions} player actions across ${minBeats}–${maxBeats} combat beats and finish with ${minHp}–${maxHp} HP.`, '',
          `${winsWithoutFinishers} wins use no combo finishers (allowed). Finisher damage share: minimum ${(minFinisherShare * 100).toFixed(1)}%, mean ${(finisherShareTotal / recorded * 100).toFixed(1)}%, maximum ${(maxFinisherShare * 100).toFixed(1)}%. Damage counts actual enemy HP removed, excluding overkill.`, '');
        if (firstComboTiming.combatBeat && firstComboTiming.playerAction && firstComboTiming.combatBeatsBefore) {
          markdown.push(`First completed combo across ${firstComboTiming.winsWithCombo} wins:`, '',
            '| Timing | Minimum | Median | Mean | Maximum |', '| --- | ---: | ---: | ---: | ---: |');
          for (const [label, distribution] of [
            ['Completion combat turn', firstComboTiming.combatBeat],
            ['Completion player action', firstComboTiming.playerAction],
            ['Combat turns before completion', firstComboTiming.combatBeatsBefore],
          ] as const) {
            markdown.push(`| ${label} | ${distribution.min} | ${distribution.median} | ${distribution.mean.toFixed(2)} | ${distribution.max} |`);
          }
          markdown.push('', `${winsWithoutFinishers} wins without a completed combo are excluded. Completion is the third Strike; the free opening Step counts only toward the player action index.`, '',
            '| First-combo combat turn | Recorded wins |', '| --- | ---: |');
          for (const { value, wins } of firstComboTiming.combatBeat.histogram) markdown.push(`| ${value} | ${wins} |`);
          markdown.push('');
        } else markdown.push('No recorded win completes a combo, so first-combo timing is unavailable.', '');
        markdown.push('| Combat metric | Minimum | Mean | Maximum |', '| --- | ---: | ---: | ---: |');
        for (const metric of METRICS) {
          const summary = tactics[metric];
          markdown.push(`| ${metric} | ${summary.min} | ${(summary.total / recorded).toFixed(2)} | ${summary.max} |`);
        }
        markdown.push('',
          '| Action | Minimum | Mean | Maximum | Wins using action |', '| --- | ---: | ---: | ---: | ---: |');
        for (const action of ACTIONS) {
          const summary = result.actionSummary[action];
          markdown.push(`| ${action} | ${summary.min} | ${(summary.total / recorded).toFixed(2)} | ${summary.max} | ${summary.usedInWins} / ${recorded} |`);
        }
        markdown.push('');
      }
    }
    writeFileSync(join(directory, 'summary.json'), JSON.stringify({
      schemaVersion: 3, options, comboCriterion: { metric: 'effectiveFinisherDamageShare', operator: '>', threshold: 0.5 },
      firstComboTimingDefinition: 'First completed third Strike: firstComboBeat is its elapsed combat turn; firstComboAction is its one-based player action index, including a free opening Step. Combat turns before completion = firstComboBeat - 1. No-combo wins have null timings and are excluded from timing distributions.',
      note: 'Pass requires one qualifying witness; chip wins are allowed. Completeness is bounded by maxBeats player actions, including a free opening Step. Sampled searches are biased and never exhaustive.', rooms: reports,
    }, null, 2) + '\n');
    markdown.push('## Files', '',
      '- `wins.csv`: one row per discovered win, with total player actions, elapsed combat beats, all five action counts, and firstComboBeat / firstComboAction (blank for no-combo wins).',
      '- `winning-sequences.jsonl`: complete commands for each CSV row, including targets and throw directions.',
      '- `rooms.json`: exact initial states for reproduction.',
      '- `summary.json`: coverage, budgets, action statistics, first-combo timing distributions / histograms, and counts of action-usage profiles.', '');
    writeFileSync(join(directory, 'report.md'), markdown.join('\n'));
  } finally {
    closeSync(csv); closeSync(jsonl);
  }
  console.log(`Report: ${join(directory, 'report.md')}`);
  return directory;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).includes('--help')) console.log(HELP);
  else {
    try {
      const directory = runAnalysis(parseOptions(process.argv.slice(2)));
      const summary = JSON.parse(readFileSync(join(directory, 'summary.json'), 'utf8'));
      if (summary.rooms.some((room: { roomCheck: string }) => room.roomCheck !== 'pass')) {
        console.error('Combo viability needs review for one or more rooms. See the report; an incomplete search is not proof of impossibility.');
        process.exitCode = 2;
      }
    }
    catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }
}
