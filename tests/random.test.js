import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FRAME_LIMITS as L, createRng, hashSeed, rollFrame } from '../random.js';

const SEEDS = 5000;
const within = (v, [lo, hi]) => v >= lo && v <= hi;

test('один seed дає однаковий результат', () => {
  for (const seed of [0, 1, 42, 123456789, 'abc', 4294967295]) {
    assert.deepEqual(rollFrame(seed), rollFrame(seed));
  }
  const a = createRng(7);
  const b = createRng(7);
  for (let i = 0; i < 100; i++) assert.equal(a.next(), b.next());
});

test('різні seed дають різні кадри', () => {
  const seen = new Set();
  for (let s = 0; s < 200; s++) seen.add(JSON.stringify(rollFrame(s)));
  assert.ok(seen.size > 190);
});

test('число й рядок як seed не конфліктують із hashSeed', () => {
  assert.equal(hashSeed(5), 5);
  assert.equal(hashSeed('5'), hashSeed('5'));
  assert.ok(Number.isInteger(hashSeed('hello')) && hashSeed('hello') >= 0);
});

test('rng: uniform і int тримаються в межах', () => {
  const rng = createRng(99);
  for (let i = 0; i < 10000; i++) {
    const u = rng.uniform(-2, 3);
    assert.ok(u >= -2 && u < 3);
    const n = rng.int(2, 5);
    assert.ok(Number.isInteger(n) && n >= 2 && n <= 5);
  }
  const hits = new Set();
  for (let i = 0; i < 1000; i++) hits.add(rng.int(2, 5));
  assert.deepEqual([...hits].sort(), [2, 3, 4, 5]);
});

test('усі значення кадру в межах профілю при багатьох seed', () => {
  for (let seed = 0; seed < SEEDS; seed++) {
    const f = rollFrame(seed);
    assert.ok(within(f.exposureEV, L.exposureEV), `exposureEV ${f.exposureEV}`);
    assert.ok(within(f.whiteBalanceK, L.whiteBalanceK));
    assert.ok(within(f.whiteBalanceTint, L.whiteBalanceTint));
    assert.ok(within(f.grainMul, L.grainMul));

    if (f.leak) {
      assert.ok(within(f.leak.strength, L.leakStrength));
      assert.ok(within(f.leak.size, L.leakSize));
      assert.ok([0, 1, 2, 3].includes(f.leak.side));
      assert.ok(f.leak.color[0] === 1 && f.leak.color[1] >= 0.25 && f.leak.color[1] <= 0.6, 'колір теплий');
      assert.ok(f.leak.color[2] <= 0.1 + 0.05 + 1e-9);
    }

    if (f.dust) {
      assert.ok(f.dust.spots.length >= L.dustSpots[0] && f.dust.spots.length <= L.dustSpots[1]);
      assert.ok(f.dust.scratches.length >= L.dustScratches[0] && f.dust.scratches.length <= L.dustScratches[1]);
      for (const s of f.dust.spots) {
        assert.ok(within(s.x, [0, 1]) && within(s.y, [0, 1]));
        assert.ok(within(s.r, L.dustSpotRadius));
      }
    }

    if (f.overexposeEV !== 0) assert.ok(within(f.overexposeEV, L.overexposeEV));
    if (f.softFocus) {
      assert.ok(['all', 'edges'].includes(f.softFocus.mode));
      assert.ok(within(f.softFocus.amount, L.softFocusAmount));
    }

    // events відповідають вмісту кадру
    assert.equal(f.events.includes('lightLeak'), !!f.leak);
    assert.equal(f.events.includes('dust'), !!f.dust);
    assert.equal(f.events.includes('overexpose'), f.overexposeEV > 0);
    assert.equal(f.events.includes('softFocus'), !!f.softFocus);
  }
});

test('спалах: сила в межах і не зсуває решту значень кадру', () => {
  for (let seed = 0; seed < 2000; seed++) {
    const off = rollFrame(seed);
    const on = rollFrame(seed, { flash: true });
    assert.equal(off.flash, 0);
    assert.ok(within(on.flash, L.flashPower), `flash ${on.flash}`);
    assert.ok(on.events.includes('flash') && !off.events.includes('flash'));
    const { flash: _f1, events: _e1, ...restOff } = off;
    const { flash: _f2, events: _e2, ...restOn } = on;
    assert.deepEqual(restOn, restOff);
  }
});

test('цифрова камера: стабільна експозиція, жодних плівкових подій', () => {
  const D = L.digital;
  for (let seed = 0; seed < 5000; seed++) {
    const f = rollFrame(seed, { digital: true });
    assert.ok(within(f.exposureEV, D.exposureEV));
    assert.ok(within(f.whiteBalanceK, D.whiteBalanceK));
    assert.ok(within(f.whiteBalanceTint, D.whiteBalanceTint));
    assert.ok(within(f.grainMul, D.grainMul));
    assert.equal(f.leak, null);
    assert.equal(f.dust, null);
    assert.equal(f.overexposeEV, 0);
    assert.equal(f.softFocus, null);
    assert.deepEqual(f.events, []);
    assert.deepEqual(f, rollFrame(seed, { digital: true }), 'відтворюваність');
    const withFlash = rollFrame(seed, { digital: true, flash: true });
    assert.ok(within(withFlash.flash, L.flashPower));
    assert.deepEqual(withFlash.events, ['flash']);
  }
});

test('leakMul збільшує шанс світлової протічки, але не понад 60 %', () => {
  const N = 20000;
  let normal = 0;
  let leaky = 0;
  let extreme = 0;
  for (let seed = 0; seed < N; seed++) {
    if (rollFrame(seed).leak) normal++;
    if (rollFrame(seed, { leakMul: 2.5 }).leak) leaky++;
    if (rollFrame(seed, { leakMul: 100 }).leak) extreme++;
  }
  assert.ok(leaky / N > normal / N * 2, `${leaky} проти ${normal}`);
  assert.ok(leaky / N > 0.2 && leaky / N < 0.3);
  assert.ok(extreme / N < 0.63);
});

test('частоти подій відповідають заданим ймовірностям', () => {
  const N = 40000;
  const count = { leak: 0, dust: 0, over: 0, soft: 0 };
  for (let seed = 0; seed < N; seed++) {
    const f = rollFrame(seed);
    if (f.leak) count.leak++;
    if (f.dust) count.dust++;
    if (f.overexposeEV) count.over++;
    if (f.softFocus) count.soft++;
  }
  const rate = (k) => count[k] / N;
  assert.ok(rate('leak') > 0.085 && rate('leak') < 0.115, `leak ${rate('leak')}`);
  assert.ok(rate('dust') > 0.135 && rate('dust') < 0.165, `dust ${rate('dust')}`);
  assert.ok(rate('over') > 0.04 && rate('over') < 0.06, `over ${rate('over')}`);
  assert.ok(rate('soft') > 0.085 && rate('soft') < 0.115, `soft ${rate('soft')}`);
});
