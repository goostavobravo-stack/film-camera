// Профілі камер (лінз): тільки геометрія й оптика, колір залежить від плівки.

/** Допустимі межі полів профілю. sharpness < 0 дає м'якість. */
export const CAMERA_LIMITS = {
  vignetteStrength: [0, 1],
  vignetteRadius: [0.5, 1.5],
  edgeSoftness: [0, 1],
  chromaticAberration: [0, 0.01],
  barrelDistortion: [-0.2, 0.2],
  glowAmount: [0, 1],
  glowThreshold: [0, 1],
  sharpness: [-1, 1],
};

/** Камера, що нічого не змінює. */
export const NEUTRAL_CAMERA = {
  id: 'neutral',
  name: 'Нейтральна',
  vignetteStrength: 0,
  vignetteRadius: 1,
  edgeSoftness: 0,
  chromaticAberration: 0,
  barrelDistortion: 0,
  glowAmount: 0,
  glowThreshold: 0.75,
  sharpness: 0,
};

export const CAMERAS = [
  {
    id: 'leica',
    name: 'Лейка',
    vignetteStrength: 0.25,
    vignetteRadius: 1.0,
    edgeSoftness: 0.3,
    chromaticAberration: 0.002,
    barrelDistortion: 0.02,
    glowAmount: 0.35,
    glowThreshold: 0.75,
    sharpness: 0.2,
  },
  {
    id: 'lomo',
    name: 'Ломо',
    vignetteStrength: 0.7,
    vignetteRadius: 0.7,
    edgeSoftness: 0.5,
    chromaticAberration: 0.004,
    barrelDistortion: 0.08,
    glowAmount: 0.25,
    glowThreshold: 0.8,
    sharpness: 0.1,
  },
  {
    id: 'compact',
    name: 'Компакт',
    vignetteStrength: 0.3,
    vignetteRadius: 0.9,
    edgeSoftness: 0.15,
    chromaticAberration: 0.001,
    barrelDistortion: -0.03,
    glowAmount: 0.5,
    glowThreshold: 0.7,
    sharpness: 0.35,
  },
];
