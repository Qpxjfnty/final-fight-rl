import { createEncounter } from '../src/engine';
import { CONFIG, distance, type Pos, type State } from '../src/model';

/** A local PRNG keeps seed 0 valid and leaves the browser's fixed encounter alone. */
function randomForSeed(seed: number): () => number {
  let value = seed;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(value ^ (value >>> 15), value | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 0x100000000;
  };
}

/**
 * Generate an offline analysis encounter, not a certified-winnable room.
 * Six 60-degree sectors surround the player; enemies start 2–3 cells away.
 * Only positions vary. The live game's createEncounter remains unchanged.
 */
export function generateAnalysisRoom(seed: number): State {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new RangeError('Room seed must be an unsigned 32-bit integer.');
  }
  const random = randomForSeed(seed);
  const state = createEncounter();
  const sectors: Pos[][] = Array.from({ length: 6 }, () => []);
  const fullTurn = Math.PI * 2;
  const sectorWidth = fullTurn / sectors.length;
  for (let y = 1; y <= CONFIG.height; y += 1) {
    for (let x = 1; x <= CONFIG.width; x += 1) {
      const cell = { x, y };
      const range = distance(cell, state.player);
      if (range < 2 || range > 3) continue;
      // Center the first sector on north, then proceed clockwise.
      const angle = Math.atan2(x - state.player.x, state.player.y - y);
      const sector = Math.floor(((angle + sectorWidth / 2 + fullTurn) % fullTurn) / sectorWidth);
      sectors[sector].push(cell);
    }
  }
  const placements = sectors.map(cells => {
    if (!cells.length) throw new Error('The arena cannot provide six surrounding spawn sectors.');
    return cells[Math.floor(random() * cells.length)];
  });
  // Shuffle assignments so lungers are not confined to the same two sectors.
  for (let index = placements.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [placements[index], placements[other]] = [placements[other], placements[index]];
  }
  state.enemies.forEach((enemy, index) => Object.assign(enemy, placements[index]));
  return state;
}
