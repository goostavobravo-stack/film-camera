// Профілі плівок (колір). Криві задаються контрольними точками [x, y] у діапазоні 0–1.
//
// tonecurve      спільна S-крива (піднятий чорний, приглушений білий)
// channelCurves  окремі криві R, G, B, застосовуються після tonecurve
// mix            3×3 мікс каналів у лінійному світлі (рядки = вихідні R, G, B); для ч/б і «хімічних» плівок
// saturation     0–2, 1 = без змін
// greenCyanBoost додаткова насиченість зелено-блакитних відтінків (-0.5…0.5)
// shadowTint / highlightTint  RGB-зсув у тінях і світлах, обмежений TINT_LIMIT
// grainAmount 0–1, grainSize 0.5–2
// halation / halationTint / halationThreshold  червоне світіння навколо світел (немає remjet-шару)
// fog / fogTint / fogMottle  молочна вуаль (прострочена плівка), fogMottle — плямистість
// exposureBias   зсув експозиції плівки в EV (за замовчуванням EXPOSURE_BIAS_EV); у Null і нейтральної немає
// lut            URL файлу .cube (необов'язково); якщо файлу немає, лише криві
// special        'expired' | 'reel': плівка складається з профілю заново для кожного кадру, див. developFilm

import { createRng, hashSeed } from './random.js';

/** Максимальна амплітуда тонування (в частках 0–1), щоб не було сепії чи суперзеленого. */
export const TINT_LIMIT = 0.06;

export const FILM_LIMITS = {
  saturation: [0, 2],
  greenCyanBoost: [-0.5, 0.5],
  grainAmount: [0, 1],
  grainSize: [0.5, 2],
  halation: [0, 1],
  fog: [0, 0.4],
  fogMottle: [0, 1],
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round4 = (v) => Math.round(v * 1e4) / 1e4;

/** Плівки знімаються трохи темніше за нейтральну експозицію (EV): світла не пересвічені. */
export const EXPOSURE_BIAS_EV = -0.2;
/** Піднятий чорний у кривих зменшено до цієї частки: чорні глибші. */
export const BLACK_LIFT_SCALE = 0.3;
/** Наскільки тіні додатково темніші (частка в найтемніших тонах, плавно зникає до півтонів). */
export const TOE_DEPTH = 0.18;

const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Заглиблює тіні, не чіпаючи півтони й світла; зберігає монотонність кривої. */
const deepenShadow = (y) => y * (1 - TOE_DEPTH * (1 - smooth(0, 0.45, y)));

/** Заглиблює тіні готової кривої з контрольних точок. */
function deepenCurve(points) {
  return points.map(([x, y]) => [x, round4(deepenShadow(x === 0 ? y * BLACK_LIFT_SCALE : y))]);
}

/** S-крива з трохи піднятим чорним і приглушеним білим. contrast ≈ 0.5–1.2, mid зсуває середні тони. */
function sCurve({ black = 0.03, white = 0.97, contrast = 0.9, mid = 0 }) {
  const b = black * BLACK_LIFT_SCALE;
  return [0, 0.125, 0.25, 0.5, 0.75, 0.875, 1].map((x) => {
    const y = b + (white - b) * x - contrast * 0.12 * Math.sin(2 * Math.PI * x) + mid * Math.sin(Math.PI * x);
    return [x, round4(deepenShadow(clamp(y, 0, 1)))];
  });
}

/** Крива каналу: зсув у тінях, середніх і світлах. */
const chan = (s, m, h) => [[0, clamp(s, 0, 1)], [0.5, 0.5 + m], [1, clamp(1 + h, 0, 1)]];
const LINE = [[0, 0], [1, 1]];
const IDENTITY_MIX = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const bw = (r, g, b) => [[r, g, b], [r, g, b], [r, g, b]];

/** Плівка, що нічого не змінює. */
export const NEUTRAL_FILM = {
  id: 'neutral',
  name: 'Нейтральна',
  tonecurve: LINE,
  channelCurves: { r: LINE, g: LINE, b: LINE },
  mix: IDENTITY_MIX,
  saturation: 1,
  greenCyanBoost: 0,
  shadowTint: [0, 0, 0],
  highlightTint: [0, 0, 0],
  grainAmount: 0,
  grainSize: 1,
  halation: 0,
  fog: 0,
  fogMottle: 0,
  lut: null,
};

/** Звичайні плівки: прописані профілі реальних емульсій (наближення, не вимірювання). */
const STOCKS = [
  // --- Kodak ---
  {
    id: 'kodak-gold-200',
    brand: 'Kodak',
    name: 'Kodak Gold 200',
    iso: 200,
    blurb: 'теплі жовтуваті світла, помірне зерно',
    label: ['#f2b705', '#a3161a'],
    tonecurve: sCurve({ black: 0.035, white: 0.97, contrast: 0.9 }),
    channelCurves: { r: chan(0.01, 0.04, 0), g: chan(0, 0.005, -0.01), b: chan(0.02, -0.05, -0.08) },
    saturation: 1.08,
    greenCyanBoost: 0,
    shadowTint: [0.01, 0.004, -0.004],
    highlightTint: [0.03, 0.014, -0.025],
    grainAmount: 0.36,
    grainSize: 1.15,
    halation: 0.08,
  },
  {
    id: 'kodak-ultramax-400',
    brand: 'Kodak',
    name: 'Kodak Ultramax 400',
    iso: 400,
    blurb: 'щільні теплі кольори, помітне зерно',
    label: ['#e8a200', '#1d3b8a'],
    tonecurve: sCurve({ black: 0.03, white: 0.975, contrast: 1.0 }),
    channelCurves: { r: chan(0, 0.04, 0.005), g: chan(0, 0, 0), b: chan(0.02, -0.035, -0.06) },
    saturation: 1.15,
    greenCyanBoost: 0,
    shadowTint: [0.005, 0, 0],
    highlightTint: [0.025, 0.01, -0.02],
    grainAmount: 0.5,
    grainSize: 1.2,
    halation: 0.08,
  },
  {
    id: 'kodak-portra-400',
    brand: 'Kodak',
    name: 'Kodak Portra 400',
    iso: 400,
    blurb: 'ніжна шкіра, м\'які пастельні тони',
    label: ['#c9b48a', '#2b2b2b'],
    tonecurve: sCurve({ black: 0.05, white: 0.96, contrast: 0.7 }),
    channelCurves: { r: chan(0.01, 0.02, 0), g: chan(0, 0, -0.01), b: chan(0.02, -0.015, -0.03) },
    saturation: 0.88,
    greenCyanBoost: -0.05,
    shadowTint: [0.005, 0, 0.008],
    highlightTint: [0.014, 0.007, -0.004],
    grainAmount: 0.22,
    grainSize: 0.9,
    halation: 0.06,
  },
  {
    id: 'kodak-ektar-100',
    brand: 'Kodak',
    name: 'Kodak Ektar 100',
    iso: 100,
    blurb: 'дуже насичені червоні й сині, майже без зерна',
    label: ['#d7261e', '#f5f5f0'],
    tonecurve: sCurve({ black: 0.02, white: 0.985, contrast: 1.05 }),
    channelCurves: { r: chan(0, 0.03, 0.01), g: chan(0, 0, 0), b: chan(0.005, -0.01, -0.01) },
    saturation: 1.3,
    greenCyanBoost: 0,
    shadowTint: [0.005, 0, 0.008],
    highlightTint: [0.01, 0.004, -0.006],
    grainAmount: 0.12,
    grainSize: 0.7,
    halation: 0.04,
  },
  {
    id: 'kodak-ektachrome-e100',
    brand: 'Kodak',
    name: 'Kodak Ektachrome E100',
    iso: 100,
    blurb: 'слайд: чисті холодні тони, глибокі чорні',
    label: ['#1e6bb8', '#f5f5f0'],
    tonecurve: sCurve({ black: 0.01, white: 0.99, contrast: 1.1 }),
    channelCurves: { r: chan(0, -0.005, 0), g: chan(0, 0, 0), b: chan(0, 0.015, 0.02) },
    saturation: 1.18,
    greenCyanBoost: 0.05,
    shadowTint: [0, 0.002, 0.01],
    highlightTint: [0, 0, 0],
    grainAmount: 0.1,
    grainSize: 0.7,
    halation: 0.02,
  },
  {
    id: 'kodak-tri-x-400',
    brand: 'Kodak',
    name: 'Kodak Tri-X 400',
    iso: 400,
    blurb: 'ч/б: високий контраст, велике зерно',
    label: ['#2a2a2a', '#f2c200'],
    tonecurve: sCurve({ black: 0.04, white: 0.97, contrast: 1.1 }),
    channelCurves: { r: LINE, g: LINE, b: LINE },
    mix: bw(0.33, 0.5, 0.17),
    saturation: 0,
    shadowTint: [0, 0, 0],
    highlightTint: [0.004, 0.002, 0],
    grainAmount: 0.62,
    grainSize: 1.3,
    halation: 0.03,
  },
  // --- Fujifilm ---
  {
    id: 'fuji-c200',
    brand: 'Fujifilm',
    name: 'Fujicolor C200',
    iso: 200,
    blurb: 'сочні зелені й блакитні, м\'які тіні',
    label: ['#1d8a43', '#f5f5f0'],
    tonecurve: deepenCurve([[0, 0.03], [0.25, 0.2], [0.5, 0.5], [0.75, 0.82], [1, 0.965]]),
    channelCurves: {
      r: [[0, 0], [0.5, 0.49], [1, 1]],
      g: [[0, 0.01], [0.5, 0.515], [1, 1]],
      b: [[0, 0.015], [0.5, 0.505], [1, 0.985]],
    },
    saturation: 1.1,
    greenCyanBoost: 0.25,
    shadowTint: [-0.005, 0.012, 0.012],
    highlightTint: [0.004, 0, -0.004],
    grainAmount: 0.28,
    grainSize: 1.0,
    halation: 0.06,
  },
  {
    id: 'fuji-superia-400',
    brand: 'Fujifilm',
    name: 'Fujifilm Superia X-TRA 400',
    iso: 400,
    blurb: 'прохолодні зеленуваті тіні, жива зелень',
    label: ['#2aa05a', '#7a1020'],
    tonecurve: sCurve({ black: 0.035, white: 0.97, contrast: 1.0 }),
    channelCurves: { r: chan(0, -0.01, 0), g: chan(0, 0.02, 0), b: chan(0.02, 0, -0.02) },
    saturation: 1.12,
    greenCyanBoost: 0.3,
    shadowTint: [-0.005, 0.01, 0.01],
    highlightTint: [0, 0.006, -0.004],
    grainAmount: 0.46,
    grainSize: 1.15,
    halation: 0.07,
  },
  {
    id: 'fuji-pro-400h',
    brand: 'Fujifilm',
    name: 'Fujifilm Pro 400H',
    iso: 400,
    blurb: 'пастельні м\'які кольори, блакитно-м\'ятні тіні',
    label: ['#7fc8b5', '#1b3a34'],
    tonecurve: sCurve({ black: 0.05, white: 0.955, contrast: 0.55 }),
    channelCurves: { r: chan(0, -0.015, 0), g: chan(0.005, 0.015, 0), b: chan(0.03, 0.01, -0.01) },
    saturation: 0.92,
    greenCyanBoost: 0.2,
    shadowTint: [-0.004, 0.006, 0.014],
    highlightTint: [0.006, 0.006, 0.004],
    grainAmount: 0.2,
    grainSize: 0.9,
    halation: 0.05,
  },
  {
    id: 'fuji-velvia-50',
    brand: 'Fujifilm',
    name: 'Fujifilm Velvia 50',
    iso: 50,
    blurb: 'слайд: гранична насиченість і контраст',
    label: ['#4b9d2a', '#f2e300'],
    tonecurve: sCurve({ black: 0.01, white: 0.99, contrast: 1.2 }),
    channelCurves: { r: chan(0, 0.02, 0.01), g: chan(0, 0.01, 0), b: chan(0, -0.01, 0) },
    saturation: 1.45,
    greenCyanBoost: 0.15,
    shadowTint: [0, 0.004, 0.008],
    highlightTint: [0.006, 0, -0.004],
    grainAmount: 0.08,
    grainSize: 0.6,
    halation: 0.02,
  },
  // --- Ilford ---
  {
    id: 'ilford-hp5-400',
    brand: 'Ilford',
    name: 'Ilford HP5 Plus 400',
    iso: 400,
    blurb: 'ч/б: м\'який контраст, широкі півтони',
    label: ['#f2f2ee', '#1a1a1a'],
    tonecurve: sCurve({ black: 0.05, white: 0.95, contrast: 0.8 }),
    channelCurves: { r: LINE, g: LINE, b: LINE },
    mix: bw(0.28, 0.55, 0.17),
    saturation: 0,
    shadowTint: [0, 0, 0],
    highlightTint: [0, 0, 0],
    grainAmount: 0.5,
    grainSize: 1.15,
    halation: 0.02,
  },
  // --- CineStill ---
  {
    id: 'cinestill-800t',
    brand: 'CineStill',
    name: 'CineStill 800T',
    iso: 800,
    blurb: 'вольфрамовий баланс: синюватий день, червоне гало',
    label: ['#1c1c1c', '#ff4d2e'],
    tonecurve: sCurve({ black: 0.04, white: 0.96, contrast: 0.8 }),
    channelCurves: { r: chan(0, -0.05, -0.03), g: chan(0, 0, 0), b: chan(0.03, 0.06, 0.04) },
    saturation: 0.98,
    greenCyanBoost: 0.05,
    shadowTint: [-0.01, 0.008, 0.025],
    highlightTint: [0.018, 0.006, -0.006],
    grainAmount: 0.45,
    grainSize: 1.1,
    halation: 0.65,
    halationTint: [1, 0.3, 0.18],
    halationThreshold: 0.62,
  },
  // --- Lomography ---
  {
    id: 'lomo-purple',
    brand: 'Lomography',
    name: 'LomoChrome Purple',
    iso: 400,
    blurb: 'зелень стає пурпурною, небо зсувається в блакить',
    label: ['#6b2fa0', '#f5e9ff'],
    tonecurve: sCurve({ black: 0.04, white: 0.97, contrast: 0.9 }),
    channelCurves: { r: LINE, g: LINE, b: LINE },
    mix: [[0.75, 0.45, 0], [0.2, 0.45, 0.2], [0, 0.35, 0.85]],
    saturation: 1.1,
    greenCyanBoost: 0,
    shadowTint: [0.004, 0, 0.01],
    highlightTint: [0.01, 0, 0.006],
    grainAmount: 0.4,
    grainSize: 1.1,
    halation: 0.1,
  },
  {
    id: 'lomo-redscale',
    brand: 'Lomography',
    name: 'Lomography Redscale XR',
    iso: 200,
    blurb: 'проекспонована зворотним боком: червоно-жовтий',
    label: ['#c4281c', '#ffd23a'],
    tonecurve: sCurve({ black: 0.05, white: 0.96, contrast: 0.9 }),
    channelCurves: { r: LINE, g: LINE, b: LINE },
    mix: [[0.95, 0.4, 0], [0.18, 0.38, 0], [0, 0, 0.12]],
    saturation: 1.0,
    greenCyanBoost: 0,
    shadowTint: [0.01, 0, 0],
    highlightTint: [0.02, 0.01, 0],
    grainAmount: 0.5,
    grainSize: 1.2,
    halation: 0.2,
    halationTint: [1, 0.4, 0.15],
  },
  // --- Agfa ---
  {
    id: 'agfa-vista-200',
    brand: 'Agfa',
    name: 'Agfa Vista 200',
    iso: 200,
    blurb: 'червоні відтінки, зеленувато-блакитні тіні',
    label: ['#d8231c', '#f5f5f0'],
    tonecurve: sCurve({ black: 0.04, white: 0.965, contrast: 0.9 }),
    channelCurves: { r: chan(0, 0.05, 0.02), g: chan(0, -0.01, 0), b: chan(0.02, -0.04, -0.05) },
    saturation: 1.12,
    greenCyanBoost: 0,
    shadowTint: [-0.004, 0.008, 0.006],
    highlightTint: [0.028, 0.008, -0.02],
    grainAmount: 0.4,
    grainSize: 1.1,
    halation: 0.07,
  },
].map((f) => ({
  channelCurves: { r: LINE, g: LINE, b: LINE },
  mix: IDENTITY_MIX,
  greenCyanBoost: 0,
  fog: 0,
  fogMottle: 0,
  lut: null,
  exposureBias: EXPOSURE_BIAS_EV,
  ...f,
}));

const PORTRA = STOCKS.find((f) => f.id === 'kodak-portra-400');

/** Особливі «плівки»: профіль складається заново для кожного кадру, див. developFilm. */
const SPECIALS = [
  {
    ...PORTRA,
    id: 'expired',
    brand: 'Особливі',
    name: 'Просрочка',
    iso: '?',
    blurb: 'випадкова плівка, прострочена на роки: вуаль, зсуви кольору, зерно',
    label: ['#8a7d55', '#f2ead0'],
    special: 'expired',
  },
  {
    ...PORTRA,
    id: 'reel',
    brand: 'Особливі',
    name: 'Намотка',
    iso: 500,
    blurb: 'кіноплівка у фотоапараті: перфорація, гало, ремджет',
    label: ['#1a1a1a', '#ff9a2e'],
    special: 'reel',
  },
];

/** «Плівка Null»: без плівки. Разом з камерою iPhone дає чистий кадр, такий, як його віддав телефон. */
export const NULL_FILM = {
  ...NEUTRAL_FILM,
  id: 'null',
  brand: 'Без ефектів',
  name: 'Null',
  iso: '—',
  blurb: 'без плівки: колір і зерно не змінюються',
  label: ['#2a2a2a', '#b9b9b5'],
};

/** Список для барабана: Null першим, далі реальні плівки й особливі. */
export const FILMS = [NULL_FILM, ...STOCKS, ...SPECIALS];

// ---------------------------------------------------------------------------
// Особливі плівки
// ---------------------------------------------------------------------------

const CASTS = [
  { name: 'пурпурний', c: [1, -1, 1] },
  { name: 'зелений', c: [-1, 1, -1] },
  { name: 'жовтий', c: [1, 1, -1] },
  { name: 'блакитний', c: [-1, 0, 1] },
];

function fadeCurve(points, lift, compress, flat) {
  return points.map(([x, y]) => {
    const f = y + (x - y) * flat; // ближче до прямої: менше контрасту
    return [x, round4(clamp(lift + f * (1 - lift - compress), 0, 1))];
  });
}

function shiftCurve(points, delta) {
  return points.map(([x, y]) => [x, round4(clamp(y + delta * Math.sin(Math.PI * x), 0, 1))]);
}

/** Випадкова плівка зі списку, прострочена на 4–28 років. */
function developExpired(rng) {
  const base = rng.pick(STOCKS);
  const years = rng.int(4, 28);
  const age = clamp(years / 28, 0.15, 1);
  const cast = rng.pick(CASTS);
  const amp = rng.uniform(0.02, 0.05) * (0.5 + age);

  const film = {
    ...base,
    id: `expired:${base.id}`,
    tonecurve: fadeCurve(base.tonecurve, 0.05 + 0.1 * age, 0.012 + 0.04 * age, 0.35 * age),
    channelCurves: {
      r: shiftCurve(base.channelCurves.r, cast.c[0] * amp),
      g: shiftCurve(base.channelCurves.g, cast.c[1] * amp),
      b: shiftCurve(base.channelCurves.b, cast.c[2] * amp),
    },
    saturation: base.saturation === 0 ? 0 : Math.max(0.3, base.saturation * (1 - 0.4 * age * rng.uniform(0.6, 1))),
    greenCyanBoost: base.greenCyanBoost * 0.5,
    grainAmount: clamp(base.grainAmount * (1.3 + 0.9 * age), 0, 1),
    grainSize: clamp(base.grainSize * (1 + 0.35 * age), 0.5, 2),
    halation: base.halation * 1.2,
    fog: round4(clamp(0.04 + 0.14 * age, 0, 0.2)),
    fogTint: cast.c.map((c) => clamp(0.8 + c * 0.1, 0, 1)),
    fogMottle: round4(clamp(0.5 + 0.4 * age, 0, 1)),
  };
  return {
    film,
    overlay: null,
    info: { base: base.id, baseName: base.name, years, cast: cast.name, text: `${base.name}, прострочена на ${years} р.` },
  };
}

/** Кіноплівки Vision3, які хтось вирішив зарядити у фотоапарат. */
const REELS = [
  {
    code: '5219',
    stock: 'VISION3 500T',
    tonecurve: sCurve({ black: 0.05, white: 0.95, contrast: 0.75 }),
    channelCurves: { r: chan(0, -0.04, -0.03), g: chan(0, 0, 0), b: chan(0.03, 0.05, 0.04) },
    saturation: 0.95,
    shadowTint: [-0.01, 0.008, 0.022],
    highlightTint: [0.02, 0.008, -0.008],
    grainAmount: 0.5,
    grainSize: 1.15,
    halation: 0.7,
    halationTint: [1, 0.3, 0.18],
    halationThreshold: 0.62,
  },
  {
    code: '5207',
    stock: 'VISION3 250D',
    tonecurve: sCurve({ black: 0.045, white: 0.96, contrast: 0.8 }),
    channelCurves: { r: chan(0, 0.03, 0.02), g: chan(0, 0.005, 0), b: chan(0.01, -0.03, -0.04) },
    saturation: 1.0,
    shadowTint: [-0.004, 0.006, 0.014],
    highlightTint: [0.026, 0.012, -0.014],
    grainAmount: 0.38,
    grainSize: 1.0,
    halation: 0.5,
    halationTint: [1, 0.34, 0.2],
    halationThreshold: 0.66,
  },
  {
    code: '5213',
    stock: 'VISION3 200T',
    tonecurve: sCurve({ black: 0.045, white: 0.955, contrast: 0.8 }),
    channelCurves: { r: chan(0, -0.025, -0.015), g: chan(0, 0, 0), b: chan(0.02, 0.03, 0.02) },
    saturation: 0.98,
    shadowTint: [-0.008, 0.006, 0.018],
    highlightTint: [0.022, 0.01, -0.01],
    grainAmount: 0.42,
    grainSize: 1.05,
    halation: 0.6,
    halationTint: [1, 0.32, 0.19],
    halationThreshold: 0.64,
  },
];

function developReel(rng) {
  const v = rng.pick(REELS);
  const reel = SPECIALS.find((f) => f.special === 'reel');
  const jitter = () => rng.uniform(-0.01, 0.01);

  const film = {
    ...reel,
    id: `reel:${v.code}`,
    name: `Намотка ${v.stock}`,
    tonecurve: v.tonecurve,
    channelCurves: {
      r: shiftCurve(v.channelCurves.r, jitter()),
      g: shiftCurve(v.channelCurves.g, jitter()),
      b: shiftCurve(v.channelCurves.b, jitter()),
    },
    saturation: v.saturation,
    shadowTint: v.shadowTint,
    highlightTint: v.highlightTint,
    grainAmount: v.grainAmount,
    grainSize: v.grainSize,
    halation: v.halation,
    halationTint: v.halationTint,
    halationThreshold: v.halationThreshold,
  };

  // ремджет: чорні цятки від непромитого захисного шару
  let remjet = null;
  if (rng.chance(0.6)) {
    remjet = [];
    for (let i = rng.int(40, 160); i > 0; i--) {
      remjet.push({
        x: rng.next(),
        y: rng.next(),
        r: rng.uniform(0.0006, 0.0025) * (rng.chance(0.08) ? 3 : 1),
        a: rng.uniform(0.35, 0.8),
      });
    }
  }
  const n = rng.int(1, 60);
  const overlay = {
    remjet,
    sprockets: {
      bar: 0.075, // товщина смуги з перфорацією, частка короткої сторони
      offset: rng.next(),
      text: `${v.stock} ${v.code}  >${n}A  ${v.stock} ${v.code}  >${n + 1}  ${v.code}  >${n + 1}A`,
    },
  };
  return {
    film,
    overlay,
    info: { base: v.code, baseName: v.stock, text: `кіноплівка ${v.stock} у фотоапараті${remjet ? ', з ремджетом' : ''}` },
  };
}

/**
 * Звичайні плівки повертаються як є. «Просрочка» і «Намотка» складаються з seed кадру:
 * { film — профіль для computeParams, overlay — дані для малювання поверх кадру, info — опис для підпису }.
 */
export function developFilm(film, seed) {
  if (!film.special) return { film, overlay: null, info: null };
  const rng = createRng(hashSeed(`develop:${film.special}:${seed}`));
  return film.special === 'expired' ? developExpired(rng) : developReel(rng);
}
