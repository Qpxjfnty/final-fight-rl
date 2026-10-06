export interface Pos { x: number; y: number }
export type EnemyKind = 'brawler' | 'lunger';
export type Action = 'Step' | 'Strike' | 'Throw' | 'Vault' | 'Wait';
export type Command =
  | { type: 'Step'; target: Pos }
  | { type: 'Strike'; targetId: number }
  | { type: 'Throw'; targetId: number; direction: Pos }
  | { type: 'Vault'; targetId: number }
  | { type: 'Wait' };
export interface Intent { kind: 'punch' | 'lunge'; cells: Pos[]; damage: number }
export interface Enemy extends Pos {
  id: number; kind: EnemyKind; hp: number; maxHp: number;
  intent: Intent | null; down: number; recovery: number;
}
export interface Player extends Pos {
  hp: number; maxHp: number; combo: { targetId: number; hits: 1 | 2 } | null;
  vaultCooldown: number;
}
export interface Stats {
  completedCombos: number; brokenCombos: number; finisherKills: number;
  damageTaken: number; cancelledAttacks: number; actions: Record<Action, number>;
}
export interface State {
  version: string; phase: 'combat' | 'won' | 'dead'; beat: number;
  openingStepAvailable: boolean;
  player: Player; enemies: Enemy[]; stats: Stats; log: string[];
}
export interface Threat { enemyId: number; cells: Pos[]; damage: number }
export interface Preview {
  valid: boolean; reason: string; freeStep: boolean; comboStage: 0 | 1 | 2 | 3;
  hits: { enemyId: number; damage: number }[];
  pushes: { enemyId: number; from: Pos; to: Pos }[];
  lunges: { enemyId: number; from: Pos; to: Pos }[];
  destination: Pos | null; path: Pos[]; knockdowns: number[];
  interrupted: number[]; cancelled: number[]; threats: Threat[]; incomingDamage: number;
}
export interface StepResult { accepted: boolean; state: State; events: string[]; reason?: string }
export const CONFIG = {
  width: 9, height: 7, playerHp: 24, enemyHp: 12,
  strikeDamage: [1, 1, 10] as readonly number[], throwDamage: 1,
  throwRange: 3, knockdownBeats: 3, vaultCooldown: 3,
  punchDamage: 3, lungeDamage: 4, lungeRange: 3,
} as const;
export const DIRS: Pos[] = [
  { x: 0, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 0 }, { x: 1, y: 1 },
  { x: 0, y: 1 }, { x: -1, y: 1 }, { x: -1, y: 0 }, { x: -1, y: -1 },
];
export const equal = (a: Pos, b: Pos): boolean => a.x === b.x && a.y === b.y;
export const add = (a: Pos, b: Pos, n = 1): Pos => ({ x: a.x + b.x * n, y: a.y + b.y * n });
export const distance = (a: Pos, b: Pos): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
export const inside = (p: Pos): boolean => Number.isInteger(p.x) && Number.isInteger(p.y) && p.x >= 1 && p.x <= CONFIG.width && p.y >= 1 && p.y <= CONFIG.height;
export const key = (p: Pos): string => `${p.x},${p.y}`;
