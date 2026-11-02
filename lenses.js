// Модулі камери телефона (надширокий, основний, телеоб'єктив): розпізнаються за підписами пристроїв.
// Підписи браузер віддає лише після дозволу на камеру. iOS: «Back Ultra Wide Camera», «Back Camera»,
// «Back Telephoto Camera», а також віртуальні «Back Dual Camera» / «Back Triple Camera».

const ORDER = { ultra: 0, wide: 1, virtual: 2, tele: 3, other: 4 };

/** Визначає тип об'єктива за підписом пристрою. */
export function describeLens(label, index = 0) {
  const l = String(label || '').toLowerCase();
  if (/front|user|selfie|facetime/.test(l)) return { kind: 'front', short: 'Селфі', name: 'Фронтальна камера' };
  if (/dual|triple|quad/.test(l)) return { kind: 'virtual', short: 'Авто', name: 'Автовибір об\'єктива' };
  if (/ultra/.test(l)) return { kind: 'ultra', short: '0.5×', name: 'Надширококутний' };
  if (/tele/.test(l)) return { kind: 'tele', short: 'Тел.', name: 'Телеоб\'єктив' };
  if (/back|rear|environment|wide/.test(l)) return { kind: 'wide', short: '1×', name: 'Основний' };
  return { kind: 'other', short: String(index + 1), name: `Об'єктив ${index + 1}` };
}

/**
 * Список модулів із результату enumerateDevices(): без фронтальної камери, у порядку
 * від ширшого до довшого. Віртуальні «Dual/Triple» ховаються, якщо є окремі об'єктиви.
 * @returns {{id: string, kind: string, short: string, name: string}[]}
 */
export function buildLensList(devices) {
  const lenses = [];
  devices
    .filter((d) => d.kind === 'videoinput')
    .forEach((d, i) => {
      const info = describeLens(d.label, i);
      if (info.kind !== 'front') lenses.push({ id: d.deviceId, ...info });
    });
  // на Android усі задні камери підписані однаково («facing back»): перша основна, решту показуємо за номером
  let seenWide = false;
  lenses.forEach((l, i) => {
    if (l.kind !== 'wide') return;
    if (seenWide) Object.assign(l, { kind: 'other', short: String(i + 1), name: `Об'єктив ${i + 1}` });
    seenWide = true;
  });
  const hasSeparate = lenses.some((l) => ['ultra', 'wide', 'tele'].includes(l.kind));
  return lenses
    .filter((l) => !(hasSeparate && l.kind === 'virtual'))
    .map((l, i) => ({ l, i }))
    .sort((a, b) => ORDER[a.l.kind] - ORDER[b.l.kind] || a.i - b.i)
    .map(({ l }) => l);
}
