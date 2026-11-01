import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DRUM_ITEM_PX, drumIndexAt, drumItemLook } from '../drum.js';
import { COMPLETE_AT, RATCHET_STEP, ratchetTicks } from '../lever.js';

test('барабан: індекс за прокруткою, з межами', () => {
  const n = 5;
  assert.equal(drumIndexAt(0, n), 0);
  assert.equal(drumIndexAt(DRUM_ITEM_PX * 2, n), 2);
  assert.equal(drumIndexAt(DRUM_ITEM_PX * 2 + DRUM_ITEM_PX * 0.49, n), 2);
  assert.equal(drumIndexAt(DRUM_ITEM_PX * 2 + DRUM_ITEM_PX * 0.51, n), 3);
  assert.equal(drumIndexAt(-50, n), 0, 'не нижче першого');
  assert.equal(drumIndexAt(9999, n), n - 1, 'не вище останнього');
  assert.equal(drumIndexAt(10, 0), 0, 'порожній список');
});

test('барабан: пункт у центрі прямий і яскравий, далі загинається за циліндр і гасне', () => {
  const c = drumItemLook(0);
  assert.equal(Math.abs(c.rotate), 0);
  assert.equal(c.scale, 1);
  assert.equal(c.opacity, 1);
  const up = drumItemLook(-1);
  const down = drumItemLook(1);
  assert.ok(up.rotate > 0 && down.rotate < 0, 'верхні й нижні нахилені в протилежні боки');
  assert.equal(up.rotate, -down.rotate);
  assert.ok(up.opacity < 1 && up.scale < 1);
  assert.ok(drumItemLook(2).opacity < drumItemLook(1).opacity);
  assert.ok(drumItemLook(50).opacity >= 0.15, 'не зникає зовсім');
  assert.equal(drumItemLook(50).rotate, drumItemLook(2.2).rotate, 'кут обмежений');
});

test('важіль: храповик клацає кожні 8 % ходу', () => {
  assert.equal(ratchetTicks(0, 0.07), 0);
  assert.equal(ratchetTicks(0, 0.08), 1);
  assert.equal(ratchetTicks(0, 1), Math.floor(1 / RATCHET_STEP));
  assert.equal(ratchetTicks(0.5, 0.3), ratchetTicks(0.3, 0.5), 'в обидва боки однаково');
  assert.equal(ratchetTicks(0.3, 0.3), 0);
  assert.ok(COMPLETE_AT > 0.8 && COMPLETE_AT < 1, 'дотягнути треба майже до кінця');
});
