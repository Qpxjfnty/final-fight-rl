import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createEncounter, legalCommands, step } from '../src/engine';
import { distance, type Command, type State } from '../src/model';

// A bounded tactical search is a feasibility probe, not a claim about human difficulty.
interface Candidate { state: State; commands: Command[] }
const signature = (s: State) => JSON.stringify([s.player, s.enemies, s.phase]);
function score(s: State): number {
  const living = s.enemies.filter(e => e.hp > 0);
  const remainingHp = living.reduce((sum, enemy) => sum + enemy.hp, 0);
  const nearest = living.length ? Math.min(...living.map(e => distance(e, s.player))) : 0;
  return s.stats.finisherKills * 140 + (6 - living.length) * 60
    + (72 - remainingHp) * 2 + s.player.hp * 8
    + (s.player.combo?.hits ?? 0) * 8
    + s.enemies.reduce((sum, e) => sum + e.down * 0.5, 0)
    - nearest - s.beat * 1.2;
}

const initial = createEncounter();
let beam: Candidate[] = [{ state: initial, commands: [] }];
let winner: Candidate | undefined;
const seen = new Map<string, number>();
for (let depth = 0; depth < 65 && !winner; depth++) {
  const next = new Map<string, Candidate>();
  for (const candidate of beam) {
    for (const command of legalCommands(candidate.state)) {
      const result = step(candidate.state, command);
      if (!result.accepted || result.state.phase === 'dead') continue;
      const key = signature(result.state), value = score(result.state);
      if ((seen.get(key) ?? -Infinity) >= value) continue;
      const entry = { state: result.state, commands: [...candidate.commands, command] };
      if (result.state.phase === 'won') {
        if (!winner || value > score(winner.state)) winner = entry;
      } else if (!next.has(key) || value > score(next.get(key)!.state)) next.set(key, entry);
    }
  }
  beam = [...next.values()].sort((a, b) => score(b.state) - score(a.state)).slice(0, 96);
  for (const candidate of beam) seen.set(signature(candidate.state), score(candidate.state));
  if (!beam.length && !winner) break;
}
if (!winner) throw new Error('The bounded search did not find a winning line; inspect encounter balance.');

let replayed = createEncounter();
const beats = winner.commands.map(command => {
  const result = step(replayed, command);
  if (!result.accepted) throw new Error('Search emitted an invalid command.');
  replayed = result.state;
  return { command, state: replayed, events: result.events };
});
if (JSON.stringify(replayed) !== JSON.stringify(winner.state)) throw new Error('Replay was nondeterministic.');
let reckless = createEncounter();
for (let beat = 0; beat < 80 && reckless.phase === 'combat'; beat++) {
  const commands = legalCommands(reckless);
  const strike = commands.find(c => c.type === 'Strike' && c.targetId === reckless.player.combo?.targetId)
    ?? commands.find(c => c.type === 'Strike');
  reckless = step(reckless, strike ?? { type: 'Wait' }).state;
}
const dir = fileURLToPath(new URL('../work/qa/combat-lab/', import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/playthrough.json`, JSON.stringify({
  note: 'Bounded search checks feasibility; human pacing and fun remain unverified.',
  initial, summary: { beat: replayed.beat, hp: replayed.player.hp, ...replayed.stats },
  stationaryStrikes: { phase: reckless.phase, beat: reckless.beat, hp: reckless.player.hp, ...reckless.stats },
  beats,
}, null, 2));
console.log(JSON.stringify({ winning: { beats: replayed.beat, hp: replayed.player.hp, ...replayed.stats },
  stationaryStrikes: { phase: reckless.phase, beats: reckless.beat, hp: reckless.player.hp, ...reckless.stats } }, null, 2));
