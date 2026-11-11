export interface Rng {
  next(): number;
  float(min: number, max: number): number;
  int(min: number, max: number): number;
  normal(mean: number, sd: number): number;
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
  digits(n: number): string;
  alnum(n: number): string;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  return {
    next,
    float: (min, max) => min + next() * (max - min),
    int,
    normal: (mean, sd) => {
      const u = 1 - next();
      const v = next();
      return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    chance: (p) => next() < p,
    pick: <T>(items: readonly T[]): T => {
      if (items.length === 0) throw new Error('pick() needs a non-empty list');
      return items[int(0, items.length - 1)] as T;
    },
    digits: (n) => Array.from({ length: n }, () => String(int(0, 9))).join(''),
    alnum: (n) => {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
      return Array.from({ length: n }, () => chars[int(0, chars.length - 1)]).join('');
    },
  };
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}
