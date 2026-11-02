import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BW_BASE, COLOR_BASE, DENSITY, negativePixels } from '../negative.js';

const px = (r, g, b, a = 255) => new Uint8ClampedArray([r, g, b, a]);

test('кольоровий негатив: тіні світлі й помаранчеві, світла темні', () => {
  const black = negativePixels(px(0, 0, 0));
  const white = negativePixels(px(255, 255, 255));
  // чорний позитив = основа плівки: помаранчева (R > G > B)
  assert.deepEqual([...black.slice(0, 3)], COLOR_BASE.map((b) => Math.round(255 * b)));
  assert.ok(black[0] > black[1] && black[1] > black[2]);
  // білий позитив = найщільніше місце негатива, значно темніше
  for (let c = 0; c < 3; c++) assert.ok(white[c] < black[c] * 0.2 + 1);
});

test('негатив інвертує яскравість: що світліше на позитиві, то темніше на негативі', () => {
  let prev = Infinity;
  for (let v = 0; v <= 255; v += 15) {
    const n = negativePixels(px(v, v, v));
    const luma = n[0] + n[1] + n[2];
    assert.ok(luma <= prev, `v=${v}`);
    prev = luma;
  }
});

test('кольори інвертуються: червоний предмет на негативі блакитніший за фон', () => {
  const red = negativePixels(px(220, 30, 30));
  const gray = negativePixels(px(30, 30, 30));
  // червоний канал темніший за сірий (щільний), зелений і синій лишаються світлішими
  assert.ok(red[0] < gray[0]);
  assert.ok(red[1] > red[0] * 0.8, 'G не темніший за R');
});

test('чорно-білий негатив майже нейтральний і не має сильної оранжевої маски', () => {
  const n = negativePixels(px(100, 100, 100), true);
  assert.ok(Math.max(n[0], n[1], n[2]) - Math.min(n[0], n[1], n[2]) < 20);
  const c = negativePixels(px(100, 100, 100), false);
  assert.ok(c[0] - c[2] > 60, 'кольорова маска явно оранжева');
  assert.ok(BW_BASE.every((b) => b > 0.7 && b < 0.9));
});

test('альфа не змінюється, розмір масиву зберігається, результат у межах 0–255', () => {
  const data = new Uint8ClampedArray(4 * 64);
  for (let i = 0; i < data.length; i++) data[i] = (i * 37) % 256;
  const alphas = data.filter((_, i) => i % 4 === 3);
  const out = negativePixels(new Uint8ClampedArray(data));
  assert.equal(out.length, data.length);
  assert.deepEqual([...out.filter((_, i) => i % 4 === 3)], [...alphas]);
  assert.ok(out.every((v) => v >= 0 && v <= 255));
});

test('перетворення відтворюється: з основи й щільності позитив відновлюється з точністю до рівня', () => {
  // користувач переводить негатив у позитив: інверсія не повинна втрачати суттєву інформацію
  for (let v = 0; v <= 255; v += 5) {
    const n = negativePixels(px(v, v, v))[0];
    const back = (1 - n / (255 * COLOR_BASE[0])) / DENSITY;
    assert.ok(Math.abs(back * 255 - v) < 3, `v=${v} → ${back * 255}`);
  }
});
