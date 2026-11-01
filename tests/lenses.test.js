import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLensList, describeLens } from '../lenses.js';

const dev = (label, id = label) => ({ kind: 'videoinput', deviceId: id, label });

test('describeLens розпізнає підписи iOS', () => {
  assert.equal(describeLens('Back Ultra Wide Camera').kind, 'ultra');
  assert.equal(describeLens('Back Camera').kind, 'wide');
  assert.equal(describeLens('Back Telephoto Camera').kind, 'tele');
  assert.equal(describeLens('Back Triple Camera').kind, 'virtual');
  assert.equal(describeLens('Back Dual Wide Camera').kind, 'virtual');
  assert.equal(describeLens('Front Camera').kind, 'front');
  assert.equal(describeLens('camera2 3, facing front').kind, 'front');
  assert.equal(describeLens('camera2 0, facing back').kind, 'wide');
  assert.equal(describeLens('', 2).kind, 'other');
  assert.equal(describeLens('', 2).short, '3');
});

test('buildLensList: порядок ширший → довший, без фронталки', () => {
  const list = buildLensList([
    dev('Front Camera'),
    dev('Back Telephoto Camera'),
    dev('Back Camera'),
    dev('Back Ultra Wide Camera'),
  ]);
  assert.deepEqual(list.map((l) => l.kind), ['ultra', 'wide', 'tele']);
  assert.deepEqual(list.map((l) => l.short), ['0.5×', '1×', 'Тел.']);
});

test('buildLensList: віртуальні камери ховаються, коли є окремі об\'єктиви', () => {
  const withLenses = buildLensList([dev('Back Triple Camera'), dev('Back Camera'), dev('Back Ultra Wide Camera')]);
  assert.deepEqual(withLenses.map((l) => l.kind), ['ultra', 'wide']);
  const onlyVirtual = buildLensList([dev('Back Dual Camera')]);
  assert.deepEqual(onlyVirtual.map((l) => l.kind), ['virtual']);
});

test('buildLensList: ігнорує не відео, зберігає deviceId', () => {
  const list = buildLensList([
    { kind: 'audioinput', deviceId: 'mic', label: 'Mic' },
    dev('Back Camera', 'abc123'),
  ]);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'abc123');
  assert.deepEqual(buildLensList([]), []);
});
