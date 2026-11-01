import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAMERAS } from '../cameras.js';
import { FILMS } from '../films.js';
import { NEUTRAL_FRAME } from '../random.js';
import { computeParams } from '../pipeline.js';
import {
  GRAIN_MIN_PX, GRAIN_REF_WIDTH, GRAIN_STRENGTH, GRAIN_TEX_SIGMA, GRAIN_TEX_SIZE, buildGrainTexture, exposureGrainMul,
  formatGrain, grainCellPx,
} from '../grain.js';

const S = GRAIN_TEX_SIZE;
const tex = buildGrainTexture();
const field = (c) => Float32Array.from({ length: S * S }, (_, i) => (tex[i * 4 + c] - 128) / GRAIN_TEX_SIGMA);
const stats = (a) => {
  const mean = a.reduce((s, v) => s + v, 0) / a.length;
  const std = Math.sqrt(a.reduce((s, v) => s + (v - mean) ** 2, 0) / a.length);
  return { mean, std };
};
const corr = (a, b, dx, dy) => {
  let s = 0;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) s += a[y * S + x] * b[((y + dy) % S) * S + ((x + dx) % S)];
  return s / (S * S);
};

test('текстура зерна: чотири поля з нульовим середнім і одиничним розмахом', () => {
  assert.equal(tex.length, S * S * 4);
  for (let c = 0; c < 4; c++) {
    const { mean, std } = stats(field(c));
    assert.ok(Math.abs(mean) < 0.03, `канал ${c}: середнє ${mean}`);
    assert.ok(std > 0.95 && std < 1.03, `канал ${c}: σ ${std}`);
  }
});

test('текстура зерна: смуговий спектр (сусіди корелюють, великих плям немає)', () => {
  const r = field(0);
  const lag1 = corr(r, r, 1, 0);
  assert.ok(lag1 > 0.15 && lag1 < 0.6, `сусідні пікселі ${lag1}: дрібні грудочки, не білий шум`);
  for (const lag of [6, 10, 16, 32]) {
    assert.ok(Math.abs(corr(r, r, lag, 0)) < 0.05, `лаг ${lag}: низьких частот (плям) бути не повинно`);
    assert.ok(Math.abs(corr(r, r, 0, lag)) < 0.05);
  }
});

test('текстура зерна: канали незалежні, плитка без швів, результат відтворюється', () => {
  const [r, g, b, a] = [0, 1, 2, 3].map(field);
  for (const [x, y] of [[r, g], [r, b], [g, b], [r, a], [g, a], [b, a]]) assert.ok(Math.abs(corr(x, y, 0, 0)) < 0.04);
  // через шов (останній і перший стовпець) кореляція така сама, як усередині
  const across = corr(r, r, 1, 0);
  let seam = 0;
  for (let y = 0; y < S; y++) seam += r[y * S + (S - 1)] * r[y * S];
  seam /= S;
  assert.ok(Math.abs(seam - across) < 0.15, `шов ${seam} проти ${across}`);
  assert.deepEqual(buildGrainTexture(64, 5), buildGrainTexture(64, 5));
  assert.notDeepEqual(buildGrainTexture(64, 5), buildGrainTexture(64, 6));
});

test('експозиція: недоекспозиція посилює зерно, переекспозиція послаблює (~19 % на стоп)', () => {
  assert.equal(exposureGrainMul(0), 1);
  assert.ok(Math.abs(exposureGrainMul(-1) - 1.19) < 0.01);
  assert.ok(Math.abs(exposureGrainMul(1) - 0.84) < 0.01);
  let prev = Infinity;
  for (let ev = -2; ev <= 2; ev += 0.25) {
    const m = exposureGrainMul(ev);
    assert.ok(m < prev);
    prev = m;
  }
  assert.equal(exposureGrainMul(-10), exposureGrainMul(-2), 'межі');
});

test('computeParams: зерно залежить від експозиції кадру', () => {
  const film = FILMS.find((f) => f.id === 'kodak-ultramax-400');
  const cam = CAMERAS.find((c) => c.id === 'leica');
  const normal = computeParams(cam, film, NEUTRAL_FRAME).grainAmount;
  const under = computeParams(cam, film, { ...NEUTRAL_FRAME, exposureEV: -0.3 }).grainAmount;
  const over = computeParams(cam, film, { ...NEUTRAL_FRAME, overexposeEV: 1 }).grainAmount;
  assert.ok(under > normal && normal > over, `${under} > ${normal} > ${over}`);
});

test('формат 120 (Holga, Diana) зернить дрібніше, ніж 35 мм', () => {
  const film = FILMS.find((f) => f.id === 'kodak-tri-x-400');
  const medium = CAMERAS.filter((c) => c.format === 'medium').map((c) => c.id).sort();
  assert.deepEqual(medium, ['diana', 'holga']);
  const small = computeParams(CAMERAS.find((c) => c.id === 'leica'), film, NEUTRAL_FRAME);
  const big = computeParams(CAMERAS.find((c) => c.id === 'holga'), film, NEUTRAL_FRAME);
  assert.ok(big.grainSize < small.grainSize);
  assert.ok(big.grainAmount < small.grainAmount);
  assert.deepEqual(formatGrain(CAMERAS[0]), { size: 1, amount: 1 });
});

test('зерно росте з чутливістю плівки', () => {
  const grain = (id) => FILMS.find((f) => f.id === id).grainAmount;
  assert.ok(grain('kodak-ektar-100') < grain('kodak-gold-200'));
  assert.ok(grain('kodak-gold-200') < grain('kodak-ultramax-400'));
  assert.ok(grain('fuji-velvia-50') < grain('fuji-superia-400'));
  assert.ok(grain('kodak-portra-400') < grain('kodak-tri-x-400'));
  assert.equal(GRAIN_REF_WIDTH, 1600);
});

test('зерно дрібне: зернина на готовому кадрі близько піксельного розміру, а не плями', () => {
  for (const w of [1080, 1620, 2048]) {
    for (const film of FILMS) {
      const px = grainCellPx(film.grainSize, w);
      assert.ok(px >= GRAIN_MIN_PX && px <= 2.4, `${film.id} при ${w}px: ${px}`);
    }
  }
  // відносно ширини кадру розмір стабільний (вище мінімуму), тож превʼю й знімок схожі
  const a = grainCellPx(1.5, 1600);
  const b = grainCellPx(1.5, 3200);
  assert.ok(Math.abs(b / a - 2) < 1e-9);
  assert.equal(grainCellPx(0.5, 400), GRAIN_MIN_PX);
});

test('амплітуда зерна реалістична: у півтонах не більше ~12 рівнів з 255 навіть у Tri-X', () => {
  const peak = (f) => f.grainAmount * GRAIN_STRENGTH * 1.5 * 255; // 1.5 = найбільша вага в тінях
  const stable = FILMS.filter((f) => !f.special);
  for (const f of stable) assert.ok(peak(f) <= 12, `${f.id}: ${peak(f).toFixed(1)}`);
  const gold = peak(FILMS.find((f) => f.id === 'kodak-gold-200'));
  assert.ok(gold < 8, `Gold 200: ${gold.toFixed(1)}`);
  assert.ok(GRAIN_STRENGTH <= 0.05);
});

test('зерно: плівки грудкуваті й кольорові, ч/б без кольорового зерна, цифровий сенсор піксельний', () => {
  for (const film of FILMS) {
    const p = computeParams(CAMERAS[0], film, NEUTRAL_FRAME);
    assert.equal(p.grainClump, 1, `${film.id}: плівкові грудочки`);
    assert.ok(p.grainChroma >= 0 && p.grainChroma <= 1);
    if (film.saturation === 0) assert.equal(p.grainChroma, 0, `${film.id}: ч/б без хроматичного зерна`);
    else assert.ok(p.grainChroma > 0, `${film.id}: барвникові хмарки`);
  }
  const q3 = CAMERAS.find((c) => c.id === 'leica-q3');
  assert.equal(computeParams(q3, q3.look, NEUTRAL_FRAME).grainClump, 0);
});
