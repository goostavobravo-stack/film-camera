// Профілі плівок (колір). Криві задаються контрольними точками [x, y] у діапазоні 0–1.
//
// tonecurve      спільна S-крива (піднятий чорний, приглушений білий)
// channelCurves  окремі криві R, G, B, застосовуються після tonecurve
// saturation     0–2, 1 = без змін
// greenCyanBoost додаткова насиченість зелено-блакитних відтінків (-0.5…0.5)
// shadowTint / highlightTint  RGB-зсув у тінях і світлах, обмежений TINT_LIMIT
// grainAmount 0–1, grainSize 0.5–2
// lut            URL файлу .cube (необов'язково); якщо файлу немає, лише криві

/** Максимальна амплітуда тонування (в частках 0–1), щоб не було сепії чи суперзеленого. */
export const TINT_LIMIT = 0.06;

export const FILM_LIMITS = {
  saturation: [0, 2],
  greenCyanBoost: [-0.5, 0.5],
  grainAmount: [0, 1],
  grainSize: [0.5, 2],
};

const LINE = [[0, 0], [1, 1]];

/** Плівка, що нічого не змінює. */
export const NEUTRAL_FILM = {
  id: 'neutral',
  name: 'Нейтральна',
  tonecurve: LINE,
  channelCurves: { r: LINE, g: LINE, b: LINE },
  saturation: 1,
  greenCyanBoost: 0,
  shadowTint: [0, 0, 0],
  highlightTint: [0, 0, 0],
  grainAmount: 0,
  grainSize: 1,
  lut: null,
};

export const FILMS = [
  {
    id: 'fujicolor',
    name: 'Fujicolor',
    tonecurve: [[0, 0.03], [0.25, 0.2], [0.5, 0.5], [0.75, 0.82], [1, 0.965]],
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
    lut: null,
  },
  {
    id: 'kodak-gold',
    name: 'Kodak Gold',
    tonecurve: [[0, 0.035], [0.25, 0.21], [0.5, 0.51], [0.75, 0.83], [1, 0.97]],
    channelCurves: {
      r: [[0, 0.01], [0.5, 0.54], [1, 1]],
      g: [[0, 0], [0.5, 0.505], [1, 0.99]],
      b: [[0, 0.02], [0.5, 0.45], [1, 0.92]],
    },
    saturation: 1.08,
    greenCyanBoost: 0,
    shadowTint: [0.01, 0.004, -0.004],
    highlightTint: [0.03, 0.014, -0.025],
    grainAmount: 0.38,
    grainSize: 1.2,
    lut: null,
  },
  {
    id: 'portra',
    name: 'Portra',
    tonecurve: [[0, 0.05], [0.25, 0.25], [0.5, 0.5], [0.75, 0.77], [1, 0.96]],
    channelCurves: {
      r: [[0, 0.01], [0.5, 0.52], [1, 1]],
      g: [[0, 0], [0.5, 0.5], [1, 0.99]],
      b: [[0, 0.02], [0.5, 0.485], [1, 0.97]],
    },
    saturation: 0.88,
    greenCyanBoost: -0.05,
    shadowTint: [0.005, 0, 0.008],
    highlightTint: [0.014, 0.007, -0.004],
    grainAmount: 0.22,
    grainSize: 0.9,
    lut: null,
  },
];
