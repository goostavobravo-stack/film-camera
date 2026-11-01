// Пайплайн обробки кадру.
//
// Частина 1 (чиста, без браузера, тестується в node): криві, .cube, computeParams, referenceColor.
// Частина 2 (WebGL): клас FilmPipeline.
//
// Порядок проходів у GPU:
//   1. lens   — бочка/подушка, хроматична аберація, розмиття країв і «м'який фокус»
//   2. bright → blur ×2 — світлові протікання (halation) у половинній роздільності
//   3. final  — різкість, glow, експозиція, баланс білого, віньєтка, крива плівки,
//               3D LUT, насиченість, тонування, зерно, світлова протічка, пил

import { createRng } from './random.js';
import { TINT_LIMIT } from './films.js';

export const MAX_OUTPUT_SIZE = 2048;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------------------
// Криві
// ---------------------------------------------------------------------------

/** Монотонна кубічна інтерполяція (Fritsch–Carlson) по контрольних точках. */
export function makeCurve(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  const n = pts.length;
  if (n === 0) return (x) => x;
  if (n === 1) return () => pts[0][1];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const dx = [];
  const sl = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = xs[i + 1] - xs[i];
    sl[i] = (ys[i + 1] - ys[i]) / dx[i];
  }
  const t = new Array(n);
  t[0] = sl[0];
  t[n - 1] = sl[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = sl[i - 1] * sl[i] <= 0 ? 0 : (sl[i - 1] + sl[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (sl[i] === 0) {
      t[i] = t[i + 1] = 0;
      continue;
    }
    const a = t[i] / sl[i];
    const b = t[i + 1] / sl[i];
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      t[i] = tau * a * sl[i];
      t[i + 1] = tau * b * sl[i];
    }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const h = dx[i];
    const u = (x - xs[i]) / h;
    const u2 = u * u;
    const u3 = u2 * u;
    return (
      (2 * u3 - 3 * u2 + 1) * ys[i] +
      (u3 - 2 * u2 + u) * h * t[i] +
      (-2 * u3 + 3 * u2) * ys[i + 1] +
      (u3 - u2) * h * t[i + 1]
    );
  };
}

const lutCache = new WeakMap();

/** Таблиця 256×RGBA: tonecurve, потім крива каналу. Кешується по об'єкту плівки. */
export function buildCurveLUT(film) {
  const cached = lutCache.get(film);
  if (cached) return cached;
  const master = makeCurve(film.tonecurve);
  const ch = [film.channelCurves.r, film.channelCurves.g, film.channelCurves.b].map(makeCurve);
  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const m = master(i / 255);
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(clamp(ch[c](clamp(m, 0, 1)), 0, 1) * 255);
    out[i * 4 + 3] = 255;
  }
  lutCache.set(film, out);
  return out;
}

// ---------------------------------------------------------------------------
// 3D LUT (.cube)
// ---------------------------------------------------------------------------

/**
 * Розбирає .cube у «смугу» size²×size (x = blue*size + red, y = green), RGBA8.
 * Підтримується лише LUT_3D_SIZE і домен 0–1.
 */
export function parseCube(text) {
  let size = 0;
  const vals = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'LUT_3D_SIZE') size = parseInt(parts[1], 10);
    else if (parts[0] === 'LUT_1D_SIZE') throw new Error('1D LUT не підтримується');
    else if (/^[A-Z][A-Z_0-9]*$/.test(parts[0])) continue; // TITLE, DOMAIN_MIN, …
    else if (parts.length >= 3) vals.push(+parts[0], +parts[1], +parts[2]);
  }
  if (!(size >= 2)) throw new Error('У .cube немає LUT_3D_SIZE');
  if (vals.length !== size ** 3 * 3 || vals.some((v) => Number.isNaN(v))) {
    throw new Error('Некоректна кількість значень у .cube');
  }
  const data = new Uint8Array(size * size * size * 4);
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const src = (r + g * size + b * size * size) * 3;
        const dst = (g * size * size + b * size + r) * 4;
        data[dst] = Math.round(clamp(vals[src], 0, 1) * 255);
        data[dst + 1] = Math.round(clamp(vals[src + 1], 0, 1) * 255);
        data[dst + 2] = Math.round(clamp(vals[src + 2], 0, 1) * 255);
        data[dst + 3] = 255;
      }
    }
  }
  return { size, data };
}

const lutFiles = new Map();

/** Завантажує .cube за URL. Якщо файлу немає чи він зіпсований, повертає null. */
export async function loadLut(url) {
  if (!url) return null;
  if (!lutFiles.has(url)) {
    lutFiles.set(
      url,
      fetch(url)
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
        .then(parseCube)
        .catch((err) => {
          console.warn(`LUT ${url} недоступний, працюємо тільки з кривими:`, err.message);
          return null;
        }),
    );
  }
  return lutFiles.get(url);
}

// ---------------------------------------------------------------------------
// Параметри кадру
// ---------------------------------------------------------------------------

/** Зводить профіль камери, профіль плівки й випадкові значення кадру в параметри шейдерів. */
export const IDENTITY_MIX = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

/**
 * overlay — дані для малювання поверх кадру від «особливих» плівок (перфорація, ремджет), див. developFilm.
 * frame.flash — сила спалаху (0 = без спалаху).
 */
export function computeParams(camera, film, frame, lutData = null, overlay = null) {
  const exposureEV = frame.exposureEV + frame.overexposeEV;
  const k = frame.whiteBalanceK / 300;
  const tint = frame.whiteBalanceTint / 5;
  const sf = frame.softFocus;
  const tintClamp = (v) => v.map((x) => clamp(x, -TINT_LIMIT, TINT_LIMIT));

  return {
    vignetteStrength: camera.vignetteStrength,
    vignetteRadius: camera.vignetteRadius,
    blurEdge: Math.max(camera.edgeSoftness, sf && sf.mode === 'edges' ? sf.amount : 0),
    blurAll: sf && sf.mode === 'all' ? sf.amount : 0,
    chromaticAberration: camera.chromaticAberration,
    barrel: camera.barrelDistortion,
    // halation плівки додається до свічення лінзи; поріг береться нижчий із двох
    glowAmount: clamp(camera.glowAmount * (1 + 0.5 * frame.overexposeEV) + (film.halation ?? 0), 0, 1.6),
    glowThreshold:
      (film.halation ?? 0) > 0
        ? Math.min(camera.glowAmount > 0 ? camera.glowThreshold : 1, film.halationThreshold ?? 0.7)
        : camera.glowThreshold,
    glowTint: film.halationTint ?? [1, 0.62, 0.42],
    sharpness: camera.sharpness,

    exposure: 2 ** exposureEV,
    wb: [1 + 0.07 * k, 1 - 0.04 * tint, 1 - 0.07 * k],
    mix: film.mix ?? IDENTITY_MIX,
    flash: frame.flash ?? 0,
    fog: film.fog ?? 0,
    fogTint: film.fogTint ?? [0.82, 0.78, 0.84],
    fogMottle: film.fogMottle ?? 0,
    saturation: film.saturation,
    greenCyanBoost: film.greenCyanBoost,
    shadowTint: tintClamp(film.shadowTint),
    highlightTint: tintClamp(film.highlightTint),
    grainAmount: clamp(film.grainAmount * frame.grainMul, 0, 1),
    grainSize: film.grainSize,
    seed: frame.seed,
    curveLUT: buildCurveLUT(film),

    leak: frame.leak,
    dust: frame.dust,
    overlay,
    lut: lutData,
  };
}

const toLin = (v) => Math.max(v, 0) ** 2.2;
const toSrgb = (v) => Math.max(v, 0) ** (1 / 2.2);
const LUMA = [0.2126, 0.7152, 0.0722];
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * CPU-еталон колірної частини фінального проходу для пікселя в центрі кадру
 * (без просторових ефектів, зерна, протічки, пилу й LUT). rgb і результат — 0–255.
 */
export function referenceColor(rgb, p) {
  let lin = rgb.map((v) => toLin(v / 255));
  lin = lin.map((v, i) => v * p.exposure * p.wb[i]);
  lin = p.mix.map((row) => row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]);
  let c = lin.map((v) => clamp(toSrgb(v), 0, 1));
  c = c.map((v, i) => p.curveLUT[Math.round(v * 255) * 4 + i] / 255);

  const mx = Math.max(...c);
  const mn = Math.min(...c);
  const d = mx - mn;
  let hueW = 0;
  if (d > 1e-4) {
    let h;
    if (mx === c[0]) h = (((c[1] - c[2]) / d) % 6 + 6) % 6;
    else if (mx === c[1]) h = (c[2] - c[0]) / d + 2;
    else h = (c[0] - c[1]) / d + 4;
    h *= 60;
    hueW = smooth(70, 110, h) * (1 - smooth(190, 230, h)) * smooth(0, 0.25, d);
  }
  const s = p.saturation + p.greenCyanBoost * hueW;
  const L = c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];
  c = c.map((v) => L + (v - L) * s);

  const L2 = c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];
  const sw = 1 - smooth(0, 0.5, L2);
  const hw = smooth(0.5, 1, L2);
  c = c.map((v, i) => v + p.shadowTint[i] * sw + p.highlightTint[i] * hw);
  return c.map((v) => clamp(v, 0, 1) * 255);
}

// ---------------------------------------------------------------------------
// Шейдери
// ---------------------------------------------------------------------------

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const PRECISION = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
`;

const LENS_FRAG = `${PRECISION}
varying vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uRes;
uniform float uBarrel, uCA, uBlurEdge, uBlurAll;

vec3 fetch(vec2 r, vec2 g, vec2 b, vec2 o) {
  return vec3(texture2D(uSrc, r + o).r, texture2D(uSrc, g + o).g, texture2D(uSrc, b + o).b);
}

void main() {
  vec2 c = vec2(0.5);
  vec2 d = vUv - c;
  // коло, що проходить через кути кадру: r = 1 у кутах
  vec2 q = d * uRes / (0.5 * length(uRes));
  float r = length(q);

  float zoom = 1.0 / max(1.0, 1.0 + uBarrel);
  vec2 s = c + d * (1.0 + uBarrel * r * r) * zoom;
  vec2 sR = c + (s - c) * (1.0 + uCA);
  vec2 sB = c + (s - c) * (1.0 - uCA);

  float amt = clamp(max(uBlurEdge * smoothstep(0.35, 1.0, r), uBlurAll), 0.0, 1.0);
  float radiusPx = amt * 0.008 * max(uRes.x, uRes.y);

  vec3 col;
  if (radiusPx < 0.25) {
    col = fetch(sR, s, sB, vec2(0.0));
  } else {
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 16; i++) {
      float fi = float(i);
      float rr = sqrt((fi + 0.5) / 16.0);
      float th = fi * 2.39996323;
      vec2 o = vec2(cos(th), sin(th)) * rr * radiusPx / uRes;
      acc += fetch(sR, s, sB, o);
    }
    col = acc / 16.0;
  }
  gl_FragColor = vec4(col, 1.0);
}`;

const BRIGHT_FRAG = `${PRECISION}
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uThr;
vec3 bright(vec2 uv) {
  vec3 c = texture2D(uTex, uv).rgb;
  return max(c - uThr, 0.0) / max(1.0 - uThr, 0.001);
}
void main() {
  vec2 o = uTexel * 0.5;
  vec3 s = bright(vUv + vec2(-o.x, -o.y)) + bright(vUv + vec2(o.x, -o.y))
         + bright(vUv + vec2(-o.x, o.y)) + bright(vUv + vec2(o.x, o.y));
  gl_FragColor = vec4(s * 0.25, 1.0);
}`;

const BLUR_FRAG = `${PRECISION}
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;
void main() {
  vec3 s = texture2D(uTex, vUv).rgb * 0.2270270270;
  s += (texture2D(uTex, vUv + uDir).rgb + texture2D(uTex, vUv - uDir).rgb) * 0.1945945946;
  s += (texture2D(uTex, vUv + uDir * 2.0).rgb + texture2D(uTex, vUv - uDir * 2.0).rgb) * 0.1216216216;
  s += (texture2D(uTex, vUv + uDir * 3.0).rgb + texture2D(uTex, vUv - uDir * 3.0).rgb) * 0.0540540541;
  s += (texture2D(uTex, vUv + uDir * 4.0).rgb + texture2D(uTex, vUv - uDir * 4.0).rgb) * 0.0162162162;
  gl_FragColor = vec4(s, 1.0);
}`;

const FINAL_FRAG = `${PRECISION}
varying vec2 vUv;
uniform sampler2D uScene, uGlow, uCurve, uDust, uLut;
uniform vec2 uRes, uSeed;
uniform float uSharp, uGlowAmt, uExposure, uVigStrength, uVigRadius;
uniform float uSat, uGCBoost, uGrain, uGrainSize, uHasDust, uLutSize, uLutAmt;
uniform float uFlash, uFogAmt, uFogMottle;
uniform vec3 uWB, uShadowTint, uHighTint, uLeakColor, uGlowTint, uFogTint;
uniform vec4 uLeak; // x, y, size, strength
uniform mat3 uMix;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
}

vec3 toLin(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
vec3 toSrgb(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }

vec3 applyCurve(vec3 c) {
  vec3 u = (clamp(c, 0.0, 1.0) * 255.0 + 0.5) / 256.0;
  return vec3(texture2D(uCurve, vec2(u.r, 0.5)).r,
              texture2D(uCurve, vec2(u.g, 0.5)).g,
              texture2D(uCurve, vec2(u.b, 0.5)).b);
}

vec3 applyLut(vec3 c) {
  float n = uLutSize;
  c = clamp(c, 0.0, 1.0);
  float b = c.b * (n - 1.0);
  float b0 = floor(b);
  float b1 = min(b0 + 1.0, n - 1.0);
  vec2 g = c.rg * (n - 1.0) + 0.5;
  vec2 uv0 = vec2((b0 * n + g.x) / (n * n), g.y / n);
  vec2 uv1 = vec2((b1 * n + g.x) / (n * n), g.y / n);
  return mix(texture2D(uLut, uv0).rgb, texture2D(uLut, uv1).rgb, b - b0);
}

float hueWeight(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float d = mx - mn;
  if (d < 0.0001) return 0.0;
  float h;
  if (mx == c.r) h = mod((c.g - c.b) / d, 6.0);
  else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
  else h = (c.r - c.g) / d + 4.0;
  h *= 60.0;
  return smoothstep(70.0, 110.0, h) * (1.0 - smoothstep(190.0, 230.0, h)) * smoothstep(0.0, 0.25, d);
}

void main() {
  vec3 c = texture2D(uScene, vUv).rgb;

  // різкість: unsharp mask (>0) або змазування (<0)
  if (uSharp != 0.0) {
    vec2 t = (uSharp > 0.0 ? 1.0 : 2.5) / uRes;
    vec3 avg = (texture2D(uScene, vUv + vec2(t.x, 0.0)).rgb + texture2D(uScene, vUv - vec2(t.x, 0.0)).rgb
              + texture2D(uScene, vUv + vec2(0.0, t.y)).rgb + texture2D(uScene, vUv - vec2(0.0, t.y)).rgb) * 0.25;
    if (uSharp > 0.0) c += (c - avg) * uSharp * 1.6;
    else c = mix(c, (avg * 4.0 + c) * 0.2, -uSharp);
  }

  // halation: червонувате світіння навколо яскравих областей
  if (uGlowAmt > 0.0) c += texture2D(uGlow, vUv).rgb * uGlowTint * uGlowAmt;

  // експозиція, баланс білого, мікс каналів, віньєтка, спалах — у лінійному світлі
  vec3 lin = uMix * (toLin(c) * uExposure * uWB);
  vec2 q = (vUv - 0.5) * uRes / (0.5 * length(uRes));
  float r = length(q);
  lin *= 1.0 - uVigStrength * smoothstep(uVigRadius * 0.45, uVigRadius * 1.1, r);
  // пряме світло спалаху: гаряче пятно в центрі, темні краї
  if (uFlash > 0.0) lin *= mix(1.0, 0.45 + 1.6 * exp(-r * r * 1.8), uFlash);
  c = toSrgb(lin);

  // крива плівки (tonecurve + канали) і необов'язковий 3D LUT
  c = applyCurve(c);
  if (uLutSize > 0.0) c = mix(c, applyLut(c), uLutAmt);

  // насиченість і тонування тіней/світел
  float s = uSat + uGCBoost * hueWeight(c);
  float L = dot(c, LUMA);
  c = vec3(L) + (c - vec3(L)) * s;
  float L2 = dot(c, LUMA);
  c += uShadowTint * (1.0 - smoothstep(0.0, 0.5, L2)) + uHighTint * smoothstep(0.5, 1.0, L2);

  // молочна вуаль прострочених плівок: рівна основа плюс плями, до країв трохи сильніше
  if (uFogAmt > 0.0) {
    vec2 fp = vUv * vec2(uRes.x / uRes.y, 1.0) + uSeed * 0.013;
    float n = 0.5 * vnoise(fp * 2.5) + 0.3 * vnoise(fp * 6.0 + 7.1) + 0.2 * vnoise(fp * 15.0 + 3.7);
    float f = uFogAmt * ((1.0 - uFogMottle) + uFogMottle * n * 1.8) * (0.75 + 0.35 * r);
    c = 1.0 - (1.0 - clamp(c, 0.0, 1.0)) * (1.0 - uFogTint * f);
  }

  // зерно в luminance, сильніше в тінях
  if (uGrain > 0.0) {
    vec2 gp = floor(gl_FragCoord.xy / uGrainSize) + uSeed;
    float n = (hash12(gp) + hash12(gp + 17.3) + hash12(gp + 41.7)) / 3.0 - 0.5;
    float w = mix(1.6, 0.5, smoothstep(0.0, 0.9, dot(c, LUMA)));
    c += n * uGrain * 0.45 * w;
  }

  // світлова протічка (screen), великий м'який градієнт від краю
  if (uLeak.w > 0.0) {
    vec2 asp = vec2(uRes.x / uRes.y, 1.0);
    float d = length((vUv - uLeak.xy) * asp) / uLeak.z;
    float f = exp(-d * d * 1.5) * uLeak.w;
    vec3 lc = mix(uLeakColor, vec3(1.0, 0.85, 0.45), exp(-d * d * 6.0) * 0.6);
    c = 1.0 - (1.0 - clamp(c, 0.0, 1.0)) * (1.0 - clamp(lc * f, 0.0, 1.0));
  }

  // пил і подряпини
  if (uHasDust > 0.5) {
    vec4 dust = texture2D(uDust, vUv);
    c = mix(c, dust.rgb, dust.a);
  }

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

// ---------------------------------------------------------------------------
// WebGL
// ---------------------------------------------------------------------------

function buildProgram(gl, fragSrc) {
  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  };
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragSrc));
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(p, i);
    u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
  }
  return { p, u };
}

export class FilmPipeline {
  /** @param {HTMLCanvasElement} canvas канвас, у який виводиться результат */
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = null;
    this.w = 0;
    this.h = 0;
    this.dustCanvas = null;
    canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
    canvas.addEventListener('webglcontextrestored', () => this._init());
    this._init();
  }

  get supported() {
    return !!this.gl;
  }

  _init() {
    const gl = this.canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true, // потрібно для toBlob
    });
    this.gl = gl;
    if (!gl) return;
    this.targets = null;
    this.lutRef = undefined;

    this.progs = {
      lens: buildProgram(gl, LENS_FRAG),
      bright: buildProgram(gl, BRIGHT_FRAG),
      blur: buildProgram(gl, BLUR_FRAG),
      final: buildProgram(gl, FINAL_FRAG),
    };
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.disable(gl.DEPTH_TEST);

    this.srcTex = this._texture();
    this.curveTex = this._texture(gl.LINEAR);
    this.dustTex = this._texture();
    this.lutTex = this._texture();
    this.blank = new Uint8Array([0, 0, 0, 0]);
    this._upload(this.dustTex, 1, 1, this.blank);
    this._upload(this.lutTex, 1, 1, this.blank);
  }

  _texture(filter) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter || gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter || gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  _upload(tex, w, h, data) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  }

  _target(w, h) {
    const gl = this.gl;
    const tex = this._texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fbo, w, h };
  }

  _freeTargets() {
    const gl = this.gl;
    if (!this.targets) return;
    for (const t of Object.values(this.targets)) {
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fbo);
    }
    this.targets = null;
  }

  _ensureSize(w, h) {
    if (this.targets && this.w === w && this.h === h) return;
    this._freeTargets();
    this.w = this.canvas.width = w;
    this.h = this.canvas.height = h;
    const hw = Math.max(1, w >> 1);
    const hh = Math.max(1, h >> 1);
    this.targets = { scene: this._target(w, h), glowA: this._target(hw, hh), glowB: this._target(hw, hh) };
  }

  _use(prog, target, ...texs) {
    const gl = this.gl;
    gl.useProgram(prog.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, target ? target.w : this.w, target ? target.h : this.h);
    texs.forEach((t, i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, t);
    });
  }

  _draw() {
    this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
  }

  _setLut(lut) {
    if (this.lutRef === lut) return;
    this.lutRef = lut;
    if (lut) this._upload(this.lutTex, lut.size * lut.size, lut.size, lut.data);
    else this._upload(this.lutTex, 1, 1, this.blank);
  }

  /** Світлі плями пилу й тонкі подряпини. */
  _paintDust(ctx, dust, w, h) {
    const rng = createRng(dust.spots.length * 977 + dust.scratches.length);
    dust.spots.forEach((s) => {
      const r = Math.max(1, s.r * w);
      ctx.fillStyle = `rgba(242,238,228,${s.a})`;
      ctx.shadowColor = 'rgba(242,238,228,0.8)';
      ctx.shadowBlur = r * 0.8;
      ctx.beginPath();
      const n = 8;
      for (let k = 0; k < n; k++) {
        const ang = (k / n) * Math.PI * 2;
        const rr = r * rng.uniform(0.6, 1.2);
        const x = s.x * w + Math.cos(ang) * rr;
        const y = s.y * h + Math.sin(ang) * rr;
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
    });
    ctx.shadowBlur = 0;
    dust.scratches.forEach((s) => {
      const x0 = s.x * w;
      const y0 = s.y * h;
      const len = s.len * h;
      ctx.strokeStyle = `rgba(242,238,228,${s.a})`;
      ctx.lineWidth = Math.max(0.7, s.width * (w / 1500));
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo(
        x0 + s.bend * w + Math.sin(s.angle) * len * 0.5,
        y0 + len * 0.5,
        x0 + Math.sin(s.angle) * len,
        y0 + Math.cos(s.angle) * len,
      );
      ctx.stroke();
    });
  }

  /** Темні цятки ремджету (кіноплівка, що пройшла C-41). */
  _paintRemjet(ctx, specks, w) {
    specks.forEach((s) => {
      ctx.fillStyle = `rgba(10,8,6,${s.a})`;
      ctx.beginPath();
      ctx.arc(s.x * w, s.y * ctx.canvas.height, Math.max(0.8, s.r * w), 0, Math.PI * 2);
      ctx.fill();
    });
  }

  /** Смуги кіноплівки зверху й знизу: перфорація й крайовий напис. */
  _paintSprockets(ctx, sp, w, h) {
    const t = sp.bar * Math.min(w, h);
    ctx.fillStyle = 'rgba(12,9,7,0.97)';
    ctx.fillRect(0, 0, w, t);
    ctx.fillRect(0, h - t, w, t);

    const hw = t * 0.46;
    const hh = t * 0.34;
    const pitch = hw / 0.59;
    const hole = (x, y) => {
      const rad = hh * 0.3;
      ctx.beginPath();
      ctx.moveTo(x + rad, y);
      ctx.arcTo(x + hw, y, x + hw, y + hh, rad);
      ctx.arcTo(x + hw, y + hh, x, y + hh, rad);
      ctx.arcTo(x, y + hh, x, y, rad);
      ctx.arcTo(x, y, x + hw, y, rad);
      ctx.closePath();
      ctx.fill();
    };
    ctx.fillStyle = 'rgba(238,228,205,0.92)';
    for (let x = -pitch + sp.offset * pitch; x < w; x += pitch) {
      hole(x, t * 0.14);
      hole(x, h - t * 0.14 - hh);
    }

    ctx.fillStyle = 'rgba(255,140,40,0.9)';
    ctx.font = `${Math.max(8, t * 0.2)}px ui-monospace, Menlo, monospace`;
    ctx.textBaseline = 'middle';
    ctx.fillText(sp.text, t * 0.4, t * 0.82);
    ctx.fillText(sp.text, t * 0.4 + sp.offset * w * 0.3, h - t * 0.18);
  }

  /** Малює в окрему текстуру все, що лежить поверх кадру: пил, ремджет, перфорацію. */
  _drawOverlay(dust, overlay, w, h) {
    if (!this.dustCanvas) this.dustCanvas = document.createElement('canvas');
    const cv = this.dustCanvas;
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    if (overlay && overlay.remjet) this._paintRemjet(ctx, overlay.remjet, w);
    if (dust) this._paintDust(ctx, dust, w, h);
    if (overlay && overlay.sprockets) this._paintSprockets(ctx, overlay.sprockets, w, h);
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.dustTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  /**
   * Обробляє кадр і малює результат у this.canvas.
   * @param {HTMLCanvasElement|ImageBitmap} source вже обрізаний до потрібного формату кадр
   * @param {ReturnType<typeof computeParams>} p
   */
  render(source, p) {
    const gl = this.gl;
    if (!gl || gl.isContextLost()) throw new Error('WebGL недоступний');
    const w = source.width;
    const h = source.height;
    this._ensureSize(w, h);
    const T = this.targets;
    const loc = (prog, name) => prog.u[name] ?? null;

    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    // 1. лінза
    const lens = this.progs.lens;
    this._use(lens, T.scene, this.srcTex);
    gl.uniform1i(loc(lens, 'uSrc'), 0);
    gl.uniform2f(loc(lens, 'uRes'), w, h);
    gl.uniform1f(loc(lens, 'uBarrel'), p.barrel);
    gl.uniform1f(loc(lens, 'uCA'), p.chromaticAberration);
    gl.uniform1f(loc(lens, 'uBlurEdge'), p.blurEdge);
    gl.uniform1f(loc(lens, 'uBlurAll'), p.blurAll);
    this._draw();

    // 2. світлові протікання
    if (p.glowAmount > 0) {
      const { glowA, glowB } = T;
      const bright = this.progs.bright;
      this._use(bright, glowA, T.scene.tex);
      gl.uniform1i(loc(bright, 'uTex'), 0);
      gl.uniform2f(loc(bright, 'uTexel'), 1 / w, 1 / h);
      gl.uniform1f(loc(bright, 'uThr'), p.glowThreshold);
      this._draw();

      const blur = this.progs.blur;
      const stride = Math.max(1, w / 1000);
      const pass = (from, to, dx, dy, k) => {
        this._use(blur, to, from.tex);
        gl.uniform1i(loc(blur, 'uTex'), 0);
        gl.uniform2f(loc(blur, 'uDir'), (dx * k * stride) / from.w, (dy * k * stride) / from.h);
        this._draw();
      };
      pass(glowA, glowB, 1, 0, 1.5);
      pass(glowB, glowA, 0, 1, 1.5);
      pass(glowA, glowB, 1, 0, 3);
      pass(glowB, glowA, 0, 1, 3);
    }

    // 3. фінал
    this._upload(this.curveTex, 256, 1, p.curveLUT);
    this._setLut(p.lut);
    const hasOverlay = !!(p.dust || (p.overlay && (p.overlay.remjet || p.overlay.sprockets)));
    if (hasOverlay) this._drawOverlay(p.dust, p.overlay, w, h);

    const f = this.progs.final;
    this._use(f, null, T.scene.tex, T.glowA.tex, this.curveTex, this.dustTex, this.lutTex);
    ['uScene', 'uGlow', 'uCurve', 'uDust', 'uLut'].forEach((n, i) => gl.uniform1i(loc(f, n), i));
    gl.uniform2f(loc(f, 'uRes'), w, h);
    gl.uniform2f(loc(f, 'uSeed'), (p.seed % 4099) * 7.13, ((p.seed >>> 12) % 4093) * 3.71);
    gl.uniform1f(loc(f, 'uSharp'), p.sharpness);
    gl.uniform1f(loc(f, 'uGlowAmt'), p.glowAmount);
    gl.uniform1f(loc(f, 'uExposure'), p.exposure);
    gl.uniform3fv(loc(f, 'uWB'), p.wb);
    gl.uniform1f(loc(f, 'uVigStrength'), p.vignetteStrength);
    gl.uniform1f(loc(f, 'uVigRadius'), p.vignetteRadius);
    gl.uniform1f(loc(f, 'uSat'), p.saturation);
    gl.uniform1f(loc(f, 'uGCBoost'), p.greenCyanBoost);
    gl.uniform3fv(loc(f, 'uShadowTint'), p.shadowTint);
    gl.uniform3fv(loc(f, 'uHighTint'), p.highlightTint);
    gl.uniform1f(loc(f, 'uGrain'), p.grainAmount);
    gl.uniform1f(loc(f, 'uGrainSize'), Math.max(1, p.grainSize * Math.max(1, w / 1000)));
    gl.uniform1f(loc(f, 'uHasDust'), hasOverlay ? 1 : 0);
    gl.uniform3fv(loc(f, 'uGlowTint'), p.glowTint);
    gl.uniform1f(loc(f, 'uFlash'), p.flash);
    gl.uniform1f(loc(f, 'uFogAmt'), p.fog);
    gl.uniform3fv(loc(f, 'uFogTint'), p.fogTint);
    gl.uniform1f(loc(f, 'uFogMottle'), p.fogMottle);
    // матриця в GL — по стовпцях, тому транспонуємо
    const m = p.mix;
    gl.uniformMatrix3fv(loc(f, 'uMix'), false, [m[0][0], m[1][0], m[2][0], m[0][1], m[1][1], m[2][1], m[0][2], m[1][2], m[2][2]]);
    gl.uniform1f(loc(f, 'uLutSize'), p.lut ? p.lut.size : 0);
    gl.uniform1f(loc(f, 'uLutAmt'), 1);
    const leak = p.leak;
    gl.uniform4f(loc(f, 'uLeak'), leak ? leak.x : 0, leak ? leak.y : 0, leak ? leak.size : 1, leak ? leak.strength : 0);
    gl.uniform3fv(loc(f, 'uLeakColor'), leak ? leak.color : [0, 0, 0]);
    this._draw();
  }

  /** JPEG з поточного вмісту канваса. */
  toBlob(type = 'image/jpeg', quality = 0.92) {
    return new Promise((resolve, reject) => {
      this.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob не вдався'))), type, quality);
    });
  }

  /** Читає RGBA-пікселі результату (рядки йдуть знизу вгору, як у GL). Для відлагодження й самоперевірки. */
  readPixels() {
    const gl = this.gl;
    const out = new Uint8Array(this.w * this.h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  }
}
