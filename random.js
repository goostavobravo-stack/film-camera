// Генератор випадкових величин: seeded (mulberry32) з межами для кожного кадру.

const UINT32 = 4294967296;

/** Перетворює число або рядок у uint32. */
export function hashSeed(input) {
  if (typeof input === 'number' && Number.isFinite(input)) return Math.floor(input) >>> 0;
  const str = String(input);
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Новий випадковий seed для кадру. */
export function newSeed() {
  const c = globalThis.crypto;
  if (c && c.getRandomValues) return c.getRandomValues(new Uint32Array(1))[0];
  return Math.floor(Math.random() * UINT32) >>> 0;
}

export function createRng(seed) {
  let s = hashSeed(seed);
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32;
  };
  return {
    next,
    /** Рівномірно з [min, max). */
    uniform: (min, max) => min + next() * (max - min),
    /** Ціле з [min, max] включно. */
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
  };
}

/** Межі всіх випадкових величин кадру. */
export const FRAME_LIMITS = {
  exposureEV: [-0.3, 0.3],
  whiteBalanceK: [-300, 300],
  whiteBalanceTint: [-5, 5],
  grainMul: [0.8, 1.3],
  lightLeakChance: [0.08, 0.12],
  leakStrength: [0.35, 0.8],
  leakSize: [0.25, 0.55],
  dustChance: 0.15,
  dustSpots: [1, 5],
  dustScratches: [0, 2],
  dustSpotRadius: [0.0008, 0.003], // частка ширини кадру
  overexposeChance: 0.05,
  overexposeEV: [0.5, 1],
  softFocusChance: 0.1,
  softFocusAmount: [0.25, 0.7],
};

/** Кадр без жодного випадкового ефекту. */
export const NEUTRAL_FRAME = {
  seed: 0,
  exposureEV: 0,
  whiteBalanceK: 0,
  whiteBalanceTint: 0,
  grainMul: 1,
  leak: null,
  dust: null,
  overexposeEV: 0,
  softFocus: null,
  events: [],
};

const LEAK_COLD = [1.0, 0.25, 0.1]; // червоний
const LEAK_WARM = [1.0, 0.6, 0.15]; // оранжевий

/**
 * Усі випадкові значення кадру з одного seed. Той самий seed дає той самий результат.
 * Координати пилу — у частках кадру, (0,0) у лівому верхньому куті.
 */
export function rollFrame(seed) {
  const rng = createRng(seed);
  const L = FRAME_LIMITS;
  const events = [];

  const frame = {
    seed: hashSeed(seed),
    exposureEV: rng.uniform(...L.exposureEV),
    whiteBalanceK: rng.uniform(...L.whiteBalanceK),
    whiteBalanceTint: rng.uniform(...L.whiteBalanceTint),
    grainMul: rng.uniform(...L.grainMul),
    leak: null,
    dust: null,
    overexposeEV: 0,
    softFocus: null,
    events,
  };

  const leakChance = rng.uniform(...L.lightLeakChance);
  if (rng.chance(leakChance)) {
    const side = rng.int(0, 3); // 0 ліво, 1 право, 2 верх, 3 низ
    const t = rng.uniform(0.1, 0.9);
    const out = 0.04;
    // x, y в uv-просторі WebGL (y вгору)
    const pos = [[-out, t], [1 + out, t], [t, 1 + out], [t, -out]][side];
    const hue = rng.next();
    frame.leak = {
      side,
      x: pos[0],
      y: pos[1],
      size: rng.uniform(...L.leakSize),
      strength: rng.uniform(...L.leakStrength),
      color: LEAK_COLD.map((c, i) => c + (LEAK_WARM[i] - c) * hue),
    };
    events.push('lightLeak');
  }

  if (rng.chance(L.dustChance)) {
    const spots = [];
    const scratches = [];
    for (let i = rng.int(...L.dustSpots); i > 0; i--) {
      spots.push({
        x: rng.next(),
        y: rng.next(),
        r: rng.uniform(...L.dustSpotRadius),
        a: rng.uniform(0.4, 0.9),
      });
    }
    for (let i = rng.int(...L.dustScratches); i > 0; i--) {
      scratches.push({
        x: rng.uniform(0.05, 0.95),
        y: rng.uniform(0, 0.5),
        len: rng.uniform(0.15, 0.6), // частка висоти
        angle: rng.uniform(-0.15, 0.15), // радіани від вертикалі
        bend: rng.uniform(-0.02, 0.02),
        width: rng.uniform(0.5, 1.2), // px при ширині 1500
        a: rng.uniform(0.25, 0.6),
      });
    }
    frame.dust = { spots, scratches };
    events.push('dust');
  }

  if (rng.chance(L.overexposeChance)) {
    frame.overexposeEV = rng.uniform(...L.overexposeEV);
    events.push('overexpose');
  }

  if (rng.chance(L.softFocusChance)) {
    frame.softFocus = {
      mode: rng.chance(0.5) ? 'all' : 'edges',
      amount: rng.uniform(...L.softFocusAmount),
    };
    events.push('softFocus');
  }

  return frame;
}
