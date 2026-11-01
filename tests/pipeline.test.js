// Тести чистої частини пайплайну (без браузера): криві, .cube, параметри, CPU-еталон кольору.
// Самі GLSL-шейдери перевіряються в браузері, див. README, розділ «Перевірка шейдерів».

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAMERAS, CAMERA_LIMITS, NEUTRAL_CAMERA } from '../cameras.js';
import { FILMS, FILM_LIMITS, NEUTRAL_FILM, TINT_LIMIT } from '../films.js';
import { NEUTRAL_FRAME, rollFrame } from '../random.js';
import { buildCurveLUT, computeParams, makeCurve, parseCube, referenceColor } from '../pipeline.js';

const within = (v, [lo, hi]) => v >= lo && v <= hi;

function colorGrid() {
  const out = [];
  for (const r of [0, 64, 128, 200, 255]) {
    for (const g of [0, 64, 128, 200, 255]) {
      for (const b of [0, 64, 128, 200, 255]) out.push([r, g, b]);
    }
  }
  return out;
}

test('вимкнені ефекти: кадр майже не змінюється', () => {
  const p = computeParams(NEUTRAL_CAMERA, NEUTRAL_FILM, NEUTRAL_FRAME);
  assert.equal(p.vignetteStrength, 0);
  assert.equal(p.blurEdge, 0);
  assert.equal(p.blurAll, 0);
  assert.equal(p.chromaticAberration, 0);
  assert.equal(p.barrel, 0);
  assert.equal(p.glowAmount, 0);
  assert.equal(p.sharpness, 0);
  assert.equal(p.grainAmount, 0);
  assert.equal(p.exposure, 1);
  assert.deepEqual(p.wb, [1, 1, 1]);
  assert.equal(p.leak, null);
  assert.equal(p.dust, null);

  let worst = 0;
  for (const rgb of colorGrid()) {
    const out = referenceColor(rgb, p);
    rgb.forEach((v, i) => { worst = Math.max(worst, Math.abs(out[i] - v)); });
  }
  assert.ok(worst <= 1, `найбільше відхилення ${worst} з 255`);
});

test('реальні профілі помітно змінюють кадр', () => {
  const gray = [128, 128, 128];
  const neutral = referenceColor(gray, computeParams(NEUTRAL_CAMERA, NEUTRAL_FILM, NEUTRAL_FRAME));
  for (const film of FILMS) {
    const out = referenceColor(gray, computeParams(CAMERAS[0], film, NEUTRAL_FRAME));
    const diff = out.reduce((s, v, i) => s + Math.abs(v - neutral[i]), 0);
    assert.ok(diff > 2, `${film.id}: відмінність ${diff}`);
  }
  const kodak = FILMS.find((f) => f.id === 'kodak-gold');
  const k = referenceColor([160, 160, 160], computeParams(CAMERAS[0], kodak, NEUTRAL_FRAME));
  assert.ok(k[0] > k[2], 'Kodak Gold тепліший: R > B на сірому');
});

test('експозиція +1 EV подвоює лінійне світло', () => {
  const up = computeParams(NEUTRAL_CAMERA, NEUTRAL_FILM, { ...NEUTRAL_FRAME, exposureEV: 1 });
  assert.ok(Math.abs(up.exposure - 2) < 1e-9);
  const dark = referenceColor([60, 60, 60], computeParams(NEUTRAL_CAMERA, NEUTRAL_FILM, NEUTRAL_FRAME));
  const bright = referenceColor([60, 60, 60], up);
  assert.ok(bright[0] > dark[0] * 1.3);
});

test('зерно множиться на grainMul і не виходить за 1', () => {
  const film = { ...NEUTRAL_FILM, grainAmount: 0.9 };
  const p = computeParams(NEUTRAL_CAMERA, film, { ...NEUTRAL_FRAME, grainMul: 1.3 });
  assert.equal(p.grainAmount, 1);
  const q = computeParams(NEUTRAL_CAMERA, { ...NEUTRAL_FILM, grainAmount: 0.5 }, { ...NEUTRAL_FRAME, grainMul: 0.8 });
  assert.ok(Math.abs(q.grainAmount - 0.4) < 1e-9);
});

test('computeParams працює для випадкових кадрів усіх профілів', () => {
  for (let seed = 0; seed < 300; seed++) {
    const frame = rollFrame(seed);
    for (const cam of CAMERAS) {
      for (const film of FILMS) {
        const p = computeParams(cam, film, frame);
        assert.ok(p.grainAmount >= 0 && p.grainAmount <= 1);
        assert.ok(p.blurEdge >= 0 && p.blurEdge <= 1 && p.blurAll >= 0 && p.blurAll <= 1);
        assert.ok(p.exposure > 0.5 && p.exposure < 2.6);
        for (const rgb of [[10, 10, 10], [250, 240, 230], [30, 200, 90]]) {
          referenceColor(rgb, p).forEach((v) => assert.ok(v >= 0 && v <= 255));
        }
      }
    }
  }
});

test('профілі камер у межах CAMERA_LIMITS', () => {
  for (const cam of [NEUTRAL_CAMERA, ...CAMERAS]) {
    for (const [key, range] of Object.entries(CAMERA_LIMITS)) {
      assert.ok(typeof cam[key] === 'number' && within(cam[key], range), `${cam.id}.${key}=${cam[key]}`);
    }
  }
  const leica = CAMERAS.find((c) => c.id === 'leica');
  assert.deepEqual(
    { ...leica, id: undefined, name: undefined },
    {
      id: undefined, name: undefined, vignetteStrength: 0.25, vignetteRadius: 1.0, edgeSoftness: 0.3,
      chromaticAberration: 0.002, barrelDistortion: 0.02, glowAmount: 0.35, glowThreshold: 0.75, sharpness: 0.2,
    },
  );
});

test('профілі плівок у межах FILM_LIMITS і з обмеженим тонуванням', () => {
  for (const film of [NEUTRAL_FILM, ...FILMS]) {
    for (const [key, range] of Object.entries(FILM_LIMITS)) {
      assert.ok(within(film[key], range), `${film.id}.${key}=${film[key]}`);
    }
    for (const tint of [film.shadowTint, film.highlightTint]) {
      assert.equal(tint.length, 3);
      tint.forEach((v) => assert.ok(Math.abs(v) <= TINT_LIMIT, `${film.id}: тонування ${v}`));
    }
    for (const pts of [film.tonecurve, film.channelCurves.r, film.channelCurves.g, film.channelCurves.b]) {
      const xs = pts.map((p) => p[0]);
      assert.deepEqual(xs, [...xs].sort((a, b) => a - b));
      assert.equal(new Set(xs).size, xs.length, 'x у кривій унікальні');
      pts.forEach(([x, y]) => assert.ok(within(x, [0, 1]) && within(y, [0, 1])));
    }
  }
});

test('tonecurve плівок: піднятий чорний, приглушений білий, S-форма', () => {
  for (const film of FILMS) {
    const f = makeCurve(film.tonecurve);
    assert.ok(f(0) > 0, `${film.id}: чорний піднятий`);
    assert.ok(f(1) < 1, `${film.id}: білий приглушений`);
    // монотонність
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const y = f(i / 100);
      assert.ok(y >= prev - 1e-12, `${film.id}: крива не спадає`);
      prev = y;
    }
  }
  const fuji = makeCurve(FILMS[0].tonecurve);
  assert.ok(fuji(0.25) < 0.25, 'тіні темніші за пряму');
  assert.ok(fuji(0.75) > 0.75, 'світла світліші за пряму');
});

test('makeCurve: проходить через контрольні точки і монотонна', () => {
  const pts = [[0, 0.1], [0.3, 0.2], [0.7, 0.9], [1, 0.95]];
  const f = makeCurve(pts);
  for (const [x, y] of pts) assert.ok(Math.abs(f(x) - y) < 1e-9);
  let prev = -1;
  for (let i = 0; i <= 200; i++) {
    const y = f(i / 200);
    assert.ok(y >= prev - 1e-12);
    prev = y;
  }
  assert.equal(f(-1), 0.1);
  assert.equal(f(2), 0.95);
  assert.equal(makeCurve([])(0.3), 0.3);
});

test('buildCurveLUT: тотожна крива дає тотожну таблицю', () => {
  const lut = buildCurveLUT({ ...NEUTRAL_FILM });
  assert.equal(lut.length, 256 * 4);
  for (let i = 0; i < 256; i++) {
    assert.equal(lut[i * 4], i);
    assert.equal(lut[i * 4 + 1], i);
    assert.equal(lut[i * 4 + 2], i);
    assert.equal(lut[i * 4 + 3], 255);
  }
});

function identityCube(size) {
  const lines = ['TITLE "identity"', `LUT_3D_SIZE ${size}`, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1', '# коментар'];
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) lines.push(`${r / (size - 1)} ${g / (size - 1)} ${b / (size - 1)}`);
    }
  }
  return lines.join('\n');
}

test('parseCube: розкладає .cube у смугу size²×size', () => {
  const size = 4;
  const { data, size: n } = parseCube(identityCube(size));
  assert.equal(n, size);
  assert.equal(data.length, size * size * size * 4);
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const i = (g * size * size + b * size + r) * 4;
        assert.deepEqual([...data.slice(i, i + 4)], [
          Math.round((r / (size - 1)) * 255),
          Math.round((g / (size - 1)) * 255),
          Math.round((b / (size - 1)) * 255),
          255,
        ]);
      }
    }
  }
});

test('parseCube: відхиляє зіпсовані файли', () => {
  assert.throws(() => parseCube('LUT_3D_SIZE 2\n0 0 0\n'), /кількість/);
  assert.throws(() => parseCube('0 0 0\n'), /LUT_3D_SIZE/);
  assert.throws(() => parseCube('LUT_1D_SIZE 16\n0 0 0'), /1D/);
});
