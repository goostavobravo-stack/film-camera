import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STAGES, ShakeMeter, stageFor } from '../shake.js';

const G = 9.8;

/** Симуляція акселерометра з частотою hz: gravity + синусоїда амплітудою amp вздовж осі x і z. */
function run(meter, { seconds, hz = 60, amp, freq, noise = 0 }) {
  let t = 0;
  let firstDone = null;
  const n = Math.round(seconds * hz);
  for (let i = 0; i < n; i++) {
    t = (i * 1000) / hz;
    const s = Math.sin((2 * Math.PI * freq * t) / 1000);
    const jitter = noise ? (Math.sin(i * 12.9898) * 43758.5453 % 1) * noise : 0;
    meter.push(amp * s + jitter, amp * 0.4 * s, G + amp * 0.6 * s, t);
    if (firstDone === null && meter.done) firstDone = t / 1000;
  }
  return firstDone;
}

test('телефон лежить: прогресу немає', () => {
  const m = new ShakeMeter();
  run(m, { seconds: 30, amp: 0, freq: 1, noise: 0.05 });
  assert.equal(m.progress, 0);
  assert.ok(m.intensity < 0.01);
});

test('спокійні рухи (ходьба, тремтіння руки) не проявляють плівку', () => {
  const m = new ShakeMeter();
  run(m, { seconds: 30, amp: 2, freq: 2, noise: 0.1 });
  assert.equal(m.progress, 0);
});

test('енергійне трусіння заповнює шкалу за 5–20 секунд', () => {
  const m = new ShakeMeter();
  const doneAt = run(m, { seconds: 40, amp: 15, freq: 4 });
  assert.ok(doneAt !== null, 'шкала заповнилась');
  assert.ok(doneAt >= 5 && doneAt <= 20, `за ${doneAt} с`);
  assert.equal(m.progress, 1);
  assert.ok(m.done);
});

test('прогрес зростає монотонно, не перевищує 1, інтенсивність у межах 0…1', () => {
  const m = new ShakeMeter();
  let last = 0;
  for (let i = 0; i < 3000; i++) {
    const t = i * 16.7;
    m.push(12 * Math.sin(i / 3), 6 * Math.sin(i / 3), G + 8 * Math.sin(i / 3), t);
    assert.ok(m.progress >= last);
    assert.ok(m.progress <= 1);
    assert.ok(m.intensity >= 0 && m.intensity <= 1);
    last = m.progress;
  }
});

test('частота 120 Гц дає схожий час, що й 60 Гц (у межах 2×)', () => {
  const a = run(new ShakeMeter(), { seconds: 60, hz: 60, amp: 15, freq: 4 });
  const b = run(new ShakeMeter(), { seconds: 60, hz: 120, amp: 15, freq: 4 });
  assert.ok(a && b);
  assert.ok(b / a < 2.5 && a / b < 2.5, `${a} с проти ${b} с`);
});

test('перетягування пальцем: резервний режим теж доходить до 100 %', () => {
  const m = new ShakeMeter();
  let px = 0;
  while (!m.done && px < 1e6) {
    m.addDistance(25);
    px += 25;
  }
  assert.ok(m.done);
  assert.ok(px > 5000 && px < 40000, `${px} px`);
  m.addDistance(-100);
  assert.equal(m.progress, 1, "від'ємна відстань ігнорується");
});

test('етапи проявки відповідають прогресу', () => {
  assert.equal(stageFor(0).name, 'Проявник');
  assert.equal(stageFor(0.39).name, 'Проявник');
  assert.equal(stageFor(0.4).name, 'Зупинка');
  assert.equal(stageFor(0.6).name, 'Фіксаж');
  assert.equal(stageFor(0.8).name, 'Промивка');
  assert.equal(stageFor(1).name, 'Промивка');
  const froms = STAGES.map((s) => s.from);
  assert.deepEqual(froms, [...froms].sort((x, y) => x - y));
});
