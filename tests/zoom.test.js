import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_CONFIDENCE, TELE_CANDIDATES, estimateZoom, guessTeleFactor, ncc, sampleCrop, teleStrategy, zoomLabel,
} from '../zoom.js';

const W = 160;
const H = 120;

/** Правдоподібна сцена: сума плавних хвиль різного масштабу, без повторів. */
function scene(seed = 1) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const waves = Array.from({ length: 28 }, () => ({
    fx: (rnd() * 0.22 + 0.01) * (rnd() < 0.5 ? -1 : 1),
    fy: (rnd() * 0.22 + 0.01) * (rnd() < 0.5 ? -1 : 1),
    ph: rnd() * 6.28,
    a: rnd() + 0.2,
  }));
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) out[y * W + x] = waves.reduce((t, k) => t + k.a * Math.sin(k.fx * x + k.fy * y + k.ph), 0);
  }
  return out;
}

/** Кадр ідеального телеоб'єктива: центральна частина основного в 1/f, розтягнута до повного розміру. */
const teleOf = (main, f, dx = 0, dy = 0) => sampleCrop(main, W, H, f, 1, 0, 0) && (() => {
  const out = new Float32Array(W * H);
  const cw = W / f;
  const ch = H / f;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = W / 2 + ((x + 0.5) / W - 0.5) * cw + dx;
      const sy = H / 2 + ((y + 0.5) / H - 0.5) * ch + dy;
      out[y * W + x] = sampleCrop(main, W, H, 1, 1) && sample(main, sx - 0.5, sy - 0.5);
    }
  }
  return out;
})();

function sample(g, x, y) {
  const cx = Math.min(W - 1, Math.max(0, x));
  const cy = Math.min(H - 1, Math.max(0, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(W - 1, x0 + 1);
  const y1 = Math.min(H - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  return g[y0 * W + x0] * (1 - fx) * (1 - fy) + g[y0 * W + x1] * fx * (1 - fy) + g[y1 * W + x0] * (1 - fx) * fy + g[y1 * W + x1] * fx * fy;
}

test('ncc: однакові → 1, інверсія → −1, рівний масив → 0, нечутливий до яскравості й контрасту', () => {
  const a = Float32Array.from({ length: 100 }, (_, i) => Math.sin(i / 5));
  assert.ok(Math.abs(ncc(a, a) - 1) < 1e-9);
  assert.ok(Math.abs(ncc(a, a.map((v) => -v)) + 1) < 1e-9);
  assert.equal(ncc(a, new Float32Array(100).fill(3)), 0);
  assert.ok(ncc(a, a.map((v) => v * 3 + 10)) > 0.999);
});

test('вимірює збільшення телеоб\'єктива для всіх кандидатів', () => {
  const main = scene(7);
  for (const f of TELE_CANDIDATES) {
    const r = estimateZoom(main, teleOf(main, f), W, H);
    assert.equal(r.factor, f, `очікували ${f}, отримали ${r.factor} (${r.scores.map((s) => s.toFixed(2))})`);
    assert.ok(r.score > 0.9, `впевненість ${r.score}`);
  }
});

test('3× і 5× впізнаються при шумі, іншій яскравості, зсуві та тремтінні рук', () => {
  let s = 99;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) - 0.5;
  for (const f of [3, 5]) {
    for (const seed of [1, 2, 3]) {
      const main = scene(seed);
      const tele = teleOf(main, f, 1.5, -1).map((v) => v * 0.8 + 0.3 + rnd() * 0.25);
      const r = estimateZoom(main, tele, W, H);
      assert.equal(r.factor, f, `scene ${seed}: ${f} → ${r.factor}`);
      assert.ok(r.score >= MIN_CONFIDENCE, `впевненість ${r.score}`);
    }
  }
});

test('рівна або неспівставна сцена дає низьку впевненість', () => {
  const flat = new Float32Array(W * H).fill(0.5);
  assert.ok(estimateZoom(flat, flat, W, H).score < MIN_CONFIDENCE);
  const r = estimateZoom(scene(10), scene(11), W, H);
  assert.ok(r.score < MIN_CONFIDENCE, `різні сцени: ${r.score}`);
});

test('sampleCrop: factor 1 повертає зменшену копію, більший factor бере центр', () => {
  const g = Float32Array.from({ length: W * H }, (_, i) => (i % W) / W);
  const full = sampleCrop(g, W, H, 1, 8);
  const crop = sampleCrop(g, W, H, 4, 8);
  assert.ok(full[7] > full[0], 'градієнт по x зберігається');
  const range = (a) => a[7] - a[0];
  assert.ok(range(crop) < range(full) / 3, 'у центральній чверті перепад менший');
  assert.ok(Math.abs(crop[3] - 0.5) < 0.1, 'центр кадра на місці');
});

test('підписи й припущення про збільшення', () => {
  assert.equal(zoomLabel(3), '3×');
  assert.equal(zoomLabel(5), '5×');
  assert.equal(zoomLabel(2.5), '2.5×');
  assert.equal(guessTeleFactor(393, 852), 3);
  assert.equal(guessTeleFactor(852, 393), 3, 'орієнтація не важлива');
  assert.equal(guessTeleFactor(402, 874), 5);
  assert.equal(guessTeleFactor(440, 956), 5);
  assert.equal(guessTeleFactor(), 3);
});

test('teleStrategy: iPhone Pro знає свою модель за екраном, вимірює лише неоднозначний розмір', () => {
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)';
  assert.deepEqual(teleStrategy(393, 852, ua), { guess: 3, measure: false, candidates: [3] }, '15 Pro: 3×, без вимірювань');
  assert.equal(teleStrategy(402, 874, ua).guess, 5);
  assert.equal(teleStrategy(440, 956, ua).guess, 5);
  assert.equal(teleStrategy(440, 956, ua).measure, false);
  const amb = teleStrategy(430, 932, ua);
  assert.equal(amb.measure, true);
  assert.deepEqual(amb.candidates, [3, 5]);
  const android = teleStrategy(412, 915, 'Mozilla/5.0 (Linux; Android 14)');
  assert.equal(android.measure, true);
  assert.ok(android.candidates.includes(3) && android.candidates.includes(5));
});
