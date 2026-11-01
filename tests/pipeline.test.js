// Тести чистої частини пайплайну (без браузера): криві, .cube, параметри, CPU-еталон кольору.
// Самі GLSL-шейдери перевіряються в браузері, див. README, розділ «Перевірка шейдерів».

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAMERAS, CAMERA_LIMITS, NEUTRAL_CAMERA } from '../cameras.js';
import { FILMS, FILM_LIMITS, NEUTRAL_FILM, TINT_LIMIT, developFilm } from '../films.js';
import { NEUTRAL_FRAME, rollFrame } from '../random.js';
import {
  SEGMENTS, buildCurveLUT, computeParams, formatDateStamp, makeCurve, parseCube, referenceColor,
} from '../pipeline.js';

test('штамп дати: формат «\'РР ММ ДД» з нулями', () => {
  assert.equal(formatDateStamp(new Date(2026, 10, 1)), "'26 11 01");
  assert.equal(formatDateStamp(new Date(1999, 0, 9)), "'99 01 09");
  assert.equal(formatDateStamp(new Date(2005, 11, 31)), "'05 12 31");
});

test('семисегментні цифри: правильна кількість сегментів', () => {
  const counts = { 0: 6, 1: 2, 2: 5, 3: 5, 4: 4, 5: 5, 6: 6, 7: 3, 8: 7, 9: 6 };
  for (const [d, n] of Object.entries(counts)) assert.equal(SEGMENTS[d].length, n, `цифра ${d}`);
  assert.deepEqual(Object.keys(SEGMENTS).sort(), Object.keys(counts).sort());
});

test('dateStamp в overlay передається в параметри без змін', () => {
  const overlay = { dateStamp: "'26 11 01" };
  assert.equal(computeParams(NEUTRAL_CAMERA, NEUTRAL_FILM, NEUTRAL_FRAME, null, overlay).overlay, overlay);
});

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
  const gray = [100, 100, 100]; // не рівно середній сірий: деякі S-криві там проходять через пряму
  const neutral = referenceColor(gray, computeParams(NEUTRAL_CAMERA, NEUTRAL_FILM, NEUTRAL_FRAME));
  for (const film of FILMS.filter((f) => f.id !== 'null')) {
    const out = referenceColor(gray, computeParams(CAMERAS[0], film, NEUTRAL_FRAME));
    const diff = out.reduce((s, v, i) => s + Math.abs(v - neutral[i]), 0);
    assert.ok(diff > 2, `${film.id}: відмінність ${diff}`);
  }
  const kodak = FILMS.find((f) => f.id === 'kodak-gold-200');
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
  const expected = {
    vignetteStrength: 0.25, vignetteRadius: 1.0, edgeSoftness: 0.3, chromaticAberration: 0.002,
    barrelDistortion: 0.02, glowAmount: 0.35, glowThreshold: 0.75, sharpness: 0.2,
  };
  for (const [k, v] of Object.entries(expected)) assert.equal(leica[k], v, k);
});

test('Leica Q3: цифрова камера з власним look замість плівки', () => {
  const q3 = CAMERAS.find((c) => c.id === 'leica-q3');
  assert.ok(q3 && q3.digital === true);
  assert.equal(CAMERAS.filter((c) => c.digital).length, 1, 'цифрова лише Q3');
  const look = q3.look;
  assert.ok(look && look.name === 'Leica Look');
  // на відміну від плівки: чорний не піднятий, шум замість зерна, без гало, вуалі й міксу каналів
  const curve = makeCurve(look.tonecurve);
  assert.equal(curve(0), 0);
  assert.equal(curve(1), 1);
  assert.ok(look.grainAmount <= 0.08 && look.halation === 0 && look.fog === 0);
  assert.ok(q3.sharpness >= 0.5, 'різка лінза');
  assert.ok(q3.chromaticAberration <= 0.0005 && q3.barrelDistortion === 0, 'аберації й дисторсія виправлені');
  for (const [key, range] of Object.entries(FILM_LIMITS)) assert.ok(within(look[key], range), key);
  look.shadowTint.concat(look.highlightTint).forEach((v) => assert.ok(Math.abs(v) <= TINT_LIMIT));
  // пайплайн приймає цифровий look як профіль плівки
  const p = computeParams(q3, look, rollFrame(5, { digital: true }));
  assert.ok(p.grainAmount <= 0.08 && p.glowAmount <= 0.1);
  assert.equal(p.leak, null);
  // тіні глибші, ніж у плівки з піднятим чорним
  const q = referenceColor([40, 40, 40], computeParams(NEUTRAL_CAMERA, look, NEUTRAL_FRAME));
  const gold = referenceColor([40, 40, 40], computeParams(NEUTRAL_CAMERA, FILMS.find((f) => f.id === 'kodak-gold-200'), NEUTRAL_FRAME));
  assert.ok(q[0] < gold[0], `Q3 ${q[0]} глибше за плівку ${gold[0]}`);
});

test('камер не менше дев\'яти, id унікальні, leakMul розумний', () => {
  assert.ok(CAMERAS.length >= 10);
  assert.equal(new Set(CAMERAS.map((c) => c.id)).size, CAMERAS.length);
  for (const c of CAMERAS) {
    assert.ok(c.name && c.blurb);
    if (c.leakMul !== undefined) assert.ok(c.leakMul >= 1 && c.leakMul <= 4);
  }
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
  for (const film of FILMS.filter((f) => f.id !== 'null')) {
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
  for (const film of FILMS.filter((f) => f.id !== 'null')) {
    const f = makeCurve(film.tonecurve);
    assert.ok(f(0.25) < 0.25, `${film.id}: тіні темніші за пряму`);
    assert.ok(f(0.75) > 0.75, `${film.id}: світла світліші за пряму`);
  }
});

test('каталог плівок: реальні бренди, унікальні id, повні поля', () => {
  assert.ok(FILMS.length >= 17);
  assert.equal(new Set(FILMS.map((f) => f.id)).size, FILMS.length);
  const brands = new Set(FILMS.map((f) => f.brand));
  for (const b of ['Kodak', 'Fujifilm', 'Ilford', 'CineStill', 'Lomography', 'Agfa', 'Особливі']) {
    assert.ok(brands.has(b), `немає бренду ${b}`);
  }
  for (const f of FILMS) {
    assert.ok(f.name && f.blurb && f.iso !== undefined, f.id);
    assert.equal(f.label.length, 2);
    assert.equal(f.mix.length, 3);
    f.mix.forEach((row) => assert.equal(row.length, 3));
  }
  assert.ok(FILMS.some((f) => f.special === 'expired' && f.name === 'Просрочка'));
  assert.ok(FILMS.some((f) => f.special === 'reel' && f.name === 'Намотка'));
});

test('ч/б плівки дають нейтральний сірий з колірного входу', () => {
  for (const id of ['kodak-tri-x-400', 'ilford-hp5-400']) {
    const film = FILMS.find((f) => f.id === id);
    const p = computeParams(NEUTRAL_CAMERA, film, NEUTRAL_FRAME);
    for (const rgb of [[200, 40, 40], [30, 180, 60], [40, 60, 200], [220, 200, 80]]) {
      const [r, g, b] = referenceColor(rgb, p);
      assert.ok(Math.max(r, g, b) - Math.min(r, g, b) < 3, `${id} ${rgb}: ${r} ${g} ${b}`);
    }
  }
});

test('кольорові плівки з міксом зсувають відтінки', () => {
  const green = [60, 170, 70];
  const purple = FILMS.find((f) => f.id === 'lomo-purple');
  const [r, g, b] = referenceColor(green, computeParams(NEUTRAL_CAMERA, purple, NEUTRAL_FRAME));
  assert.ok(r > green[0] + 30 && b > green[2] + 20, `зелень стає пурпурною: ${r} ${g} ${b}`);
  const red = FILMS.find((f) => f.id === 'lomo-redscale');
  const [rr, , bb] = referenceColor([120, 140, 200], computeParams(NEUTRAL_CAMERA, red, NEUTRAL_FRAME));
  assert.ok(rr > bb + 40, 'редскейл: червоне домінує над синім');
});

test('halation плівки додається до свічення лінзи', () => {
  const cine = FILMS.find((f) => f.id === 'cinestill-800t');
  const bare = computeParams(NEUTRAL_CAMERA, cine, NEUTRAL_FRAME);
  assert.ok(bare.glowAmount >= 0.6, 'навіть без лінзового свічення гало є');
  assert.ok(bare.glowThreshold < 0.7);
  assert.deepEqual(bare.glowTint, cine.halationTint);
  const withGlow = computeParams(CAMERAS.find((c) => c.id === 'leica'), cine, NEUTRAL_FRAME);
  assert.ok(withGlow.glowAmount > bare.glowAmount);
  const plain = computeParams(NEUTRAL_CAMERA, NEUTRAL_FILM, NEUTRAL_FRAME);
  assert.equal(plain.glowAmount, 0);
});

test('спалах: сила з кадру передається в параметри', () => {
  assert.equal(computeParams(NEUTRAL_CAMERA, NEUTRAL_FILM, NEUTRAL_FRAME).flash, 0);
  const p = computeParams(NEUTRAL_CAMERA, NEUTRAL_FILM, { ...NEUTRAL_FRAME, flash: 1.1 });
  assert.equal(p.flash, 1.1);
});

test('developFilm: звичайна плівка повертається як є', () => {
  const film = FILMS.find((f) => f.id === 'kodak-gold-200');
  const dev = developFilm(film, 123);
  assert.equal(dev.film, film);
  assert.equal(dev.overlay, null);
  assert.equal(dev.info, null);
});

test('Просрочка: випадкова плівка, прострочена, у межах профілю', () => {
  const expired = FILMS.find((f) => f.special === 'expired');
  const bases = new Set();
  for (let seed = 0; seed < 300; seed++) {
    const dev = developFilm(expired, seed);
    assert.deepEqual(dev, developFilm(expired, seed), 'той самий seed — той самий результат');
    const base = FILMS.find((f) => f.id === dev.info.base);
    assert.ok(base && !base.special, 'база — звичайна плівка');
    bases.add(base.id);
    assert.ok(dev.info.years >= 4 && dev.info.years <= 28);

    const f = dev.film;
    const fb = makeCurve(f.tonecurve);
    const bb = makeCurve(base.tonecurve);
    assert.ok(fb(0) > bb(0) + 0.04, 'чорний піднятий (вуаль)');
    assert.ok(fb(1) < bb(1), 'білий приглушений');
    assert.ok(f.fog > 0 && f.fogMottle > 0);
    assert.ok(f.grainAmount >= Math.min(1, base.grainAmount * 1.3 - 1e-9));
    assert.ok(f.saturation <= base.saturation);
    for (const [key, range] of Object.entries(FILM_LIMITS)) assert.ok(within(f[key], range), `${key}=${f[key]}`);
    for (const pts of [f.tonecurve, f.channelCurves.r, f.channelCurves.g, f.channelCurves.b]) {
      pts.forEach(([x, y]) => assert.ok(within(x, [0, 1]) && within(y, [0, 1])));
    }
    // і весь пайплайн приймає такий профіль
    const p = computeParams(CAMERAS[0], f, rollFrame(seed), null, dev.overlay);
    assert.ok(p.grainAmount <= 1);
  }
  assert.ok(bases.size >= 8, `різноманітність баз: ${bases.size}`);
});

test('Намотка: кіноплівка з перфорацією, гало і ремджетом', () => {
  const reel = FILMS.find((f) => f.special === 'reel');
  let withRemjet = 0;
  const codes = new Set();
  for (let seed = 0; seed < 300; seed++) {
    const dev = developFilm(reel, seed);
    assert.deepEqual(dev, developFilm(reel, seed));
    const sp = dev.overlay.sprockets;
    assert.ok(sp.bar > 0 && sp.bar < 0.15 && sp.offset >= 0 && sp.offset < 1 && sp.text.length > 10);
    if (dev.overlay.remjet) {
      withRemjet++;
      assert.ok(dev.overlay.remjet.length >= 40 && dev.overlay.remjet.length <= 160);
      for (const s of dev.overlay.remjet) assert.ok(within(s.x, [0, 1]) && within(s.y, [0, 1]) && within(s.a, [0.35, 0.8]));
    }
    codes.add(dev.info.base);
    const f = dev.film;
    assert.ok(f.halation >= 0.5, 'сильне гало');
    for (const [key, range] of Object.entries(FILM_LIMITS)) assert.ok(within(f[key], range), `${key}=${f[key]}`);
    for (const t of [f.shadowTint, f.highlightTint]) t.forEach((v) => assert.ok(Math.abs(v) <= TINT_LIMIT));
    const p = computeParams(NEUTRAL_CAMERA, f, NEUTRAL_FRAME, null, dev.overlay);
    assert.equal(p.overlay, dev.overlay);
  }
  assert.ok(withRemjet > 130 && withRemjet < 230, `ремджет у ${withRemjet} з 300`);
  assert.equal(codes.size, 3, 'усі три кіноплівки трапляються');
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

test('чистий режим: камера iPhone й плівка Null нічого не змінюють', () => {
  const iphone = CAMERAS.find((c) => c.id === 'iphone');
  const none = FILMS.find((f) => f.id === 'null');
  assert.ok(iphone && none);
  assert.equal(CAMERAS[0].id, 'iphone', 'iPhone першим у барабані');
  assert.equal(FILMS[0].id, 'null', 'Null першим у барабані');
  for (const [k, range] of Object.entries(CAMERA_LIMITS)) assert.ok(within(iphone[k], range), k);
  // усі ефекти камери на нулі
  for (const k of ['vignetteStrength', 'edgeSoftness', 'chromaticAberration', 'barrelDistortion', 'glowAmount', 'sharpness']) {
    assert.equal(iphone[k], 0, k);
  }
  const p = computeParams(iphone, none, NEUTRAL_FRAME);
  assert.equal(p.grainAmount, 0);
  assert.equal(p.glowAmount, 0);
  assert.equal(p.fog, 0);
  assert.equal(p.saturation, 1);
  assert.deepEqual(p.shadowTint.concat(p.highlightTint), [0, 0, 0, 0, 0, 0]);
  let worst = 0;
  for (const rgb of colorGrid()) {
    const out = referenceColor(rgb, p);
    rgb.forEach((v, i) => { worst = Math.max(worst, Math.abs(out[i] - v)); });
  }
  assert.ok(worst <= 1, `відхилення ${worst} з 255`);
});

test('плівка Null не потрапляє в «Просрочку» й не має спеціальної обробки', () => {
  const none = FILMS.find((f) => f.id === 'null');
  assert.equal(none.special, undefined);
  assert.equal(developFilm(none, 5).film, none);
  const expired = FILMS.find((f) => f.special === 'expired');
  for (let seed = 0; seed < 300; seed++) assert.notEqual(developFilm(expired, seed).info.base, 'null');
});
