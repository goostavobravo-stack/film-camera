import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAMERAS } from '../cameras.js';
import { FILMS } from '../films.js';
import { computeParams } from '../pipeline.js';
import { NEUTRAL_FRAME } from '../random.js';
import { FINDERS, PREVIEW_GRAIN, buildPreviewParams, finderMarkup } from '../viewfinder.js';

test('у кожної камери є тип видошукача з розміткою', () => {
  for (const cam of CAMERAS) {
    assert.ok(cam.finder && FINDERS[cam.finder], `${cam.id}: ${cam.finder}`);
    assert.ok(finderMarkup(cam.finder).trim().length > 20);
  }
  assert.equal(finderMarkup('немає такого'), '');
  assert.equal(new Set(CAMERAS.map((c) => c.finder)).size, Object.keys(FINDERS).length, 'усі типи використані');
});

test('типи видошукачів відповідають камерам', () => {
  const type = (id) => CAMERAS.find((c) => c.id === id).finder;
  assert.equal(type('leica'), 'rangefinder');
  assert.equal(type('canon-ae1'), 'slr');
  assert.equal(type('zenit-e'), 'slr');
  assert.equal(type('olympus-mju2'), 'compact');
  assert.equal(type('holga'), 'toy');
  assert.equal(type('leica-q3'), 'evf');
});

test('превʼю: без випадкових подій, лише лінза камери й плівка', () => {
  for (const cam of CAMERAS) {
    for (const film of FILMS) {
      const p = buildPreviewParams(cam, film, 12345);
      assert.equal(p.leak, null);
      assert.equal(p.dust, null);
      assert.equal(p.overlay, null);
      assert.equal(p.flash, 0);
      assert.equal(p.exposure, 1, 'без випадкової експозиції');
      assert.deepEqual(p.wb, [1, 1, 1]);
      assert.equal(p.blurAll, 0);
      assert.equal(p.vignetteStrength, cam.vignetteStrength);
      assert.equal(p.barrel, cam.barrelDistortion);
    }
  }
});

test('превʼю: зерно слабше, ніж на знімку, спалах вмикається', () => {
  const cam = CAMERAS.find((c) => c.id === 'leica');
  const film = FILMS.find((f) => f.id === 'kodak-tri-x-400');
  const shot = computeParams(cam, film, NEUTRAL_FRAME);
  const preview = buildPreviewParams(cam, film, 1);
  assert.ok(Math.abs(preview.grainAmount - shot.grainAmount * PREVIEW_GRAIN) < 1e-9);
  assert.ok(buildPreviewParams(cam, film, 1, { flash: true }).flash > 0);
});

test('превʼю цифрової камери використовує її look, а не плівку', () => {
  const q3 = CAMERAS.find((c) => c.id === 'leica-q3');
  const p = buildPreviewParams(q3, FILMS[0], 7);
  assert.equal(p.grainClump, 0);
  assert.ok(p.grainAmount <= 0.05);
});

test('превʼю «Просрочки» й «Намотки» залежить від seed і відтворюється', () => {
  const cam = CAMERAS[0];
  for (const id of ['expired', 'reel']) {
    const film = FILMS.find((f) => f.id === id);
    const a = buildPreviewParams(cam, film, 1);
    const b = buildPreviewParams(cam, film, 1);
    assert.deepEqual({ ...a, curveLUT: [...a.curveLUT] }, { ...b, curveLUT: [...b.curveLUT] });
    const seen = new Set();
    for (let seed = 0; seed < 40; seed++) seen.add(JSON.stringify([...buildPreviewParams(cam, film, seed).curveLUT]));
    assert.ok(seen.size > 5, `${id}: різні seed дають різний вигляд`);
  }
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
