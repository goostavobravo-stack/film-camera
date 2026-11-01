// Модель плівкового зерна.
//
// Що відомо про зерно і як воно втілене тут:
//
// 1. Структура. Зерно (срібло в ч/б, барвникові хмарки в кольорі) не є білим шумом: це дрібні грудочки
//    розміром у кілька мікрон, тож у шумі майже немає найвищих частот (грудочки мають розмір) і майже немає
//    найнижчих (немає великих плям). Спектр смуговий. Тут шум генерується з гаусового, згладжується
//    (грудочки) і з нього віднімається сильніше розмите (немає плям): buildGrainTexture.
// 2. Колір. У кольорової плівки три шари барвників зернять незалежно, тож зерно трохи кольорове; у ч/б одне
//    срібло, зерно нейтральне. Текстура має чотири незалежні поля: R, G, B і спільне.
// 3. Розмір. Росте з чутливістю (ISO): великі кристали галогеніду срібла ловлять більше світла.
//    Відносно кадру він сталий: ті самі грудочки на великому й малому знімку займають ту саму частку ширини
//    (GRAIN_REF_WIDTH). На великому негативі (середній формат, 120) ті самі зерна займають меншу частку кадру,
//    тож Holga й Diana зернять дрібніше за 35 мм.
// 4. Тони. Зерно видно найбільше в тінях і півтонах. Воно додається до сигналу ДО характеристичної кривої
//    плівки, тож пологі ділянки кривої (чорне, що притисло ногу, і плече світел) самі стискають його.
//    Додатково в тінях його більше (фотонний шум), у чистих світлах менше.
// 5. Експозиція. Недоекспонована плівка зернить сильніше, переекспонована (в межах широти) дрібніше:
//    приблизно ×1.19 на кожен стоп недоекспозиції.
// 6. Стан плівки. Просрочка, проявка з підтяжкою, кінострічка в дешевих камерах дають більше зерна
//    (див. films.js, `developFilm`).
// 7. Час. На знімку зерно нерухоме. У видошукачі (де «плівки» немає, лише її імітація) воно мерехтить, як у кіно.
// 8. Цифровий сенсор має шум, а не зерно: на рівні окремих пікселів, без грудочок (`grainClump: 0`).

import { createRng } from './random.js';

export const GRAIN_TEX_SIZE = 256;
/** Ширина кадру в пікселях, при якій grainSize = 1 дає зернину завширшки 1 піксель. */
export const GRAIN_REF_WIDTH = 1500;
/** Одне σ шуму в байтах текстури (128 ± 40·σ). Шейдер знає це число. */
export const GRAIN_TEX_SIGMA = 40;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function gaussianKernel(sigma) {
  const r = Math.ceil(sigma * 3);
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
    sum += k[i + r];
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

/** Розмиття по колу в обидва боки: текстура склеюється без швів. */
function blurWrapped(src, size, sigma) {
  const k = gaussianKernel(sigma);
  const r = (k.length - 1) / 2;
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += src[y * size + ((x + i + size) % size)] * k[i + r];
      tmp[y * size + x] = s;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += tmp[((y + i + size) % size) * size + x] * k[i + r];
      out[y * size + x] = s;
    }
  }
  return out;
}

/**
 * Текстура зерна RGBA (size×size), чотири незалежні поля одиничної дисперсії, у байтах: 128 + 40·значення.
 * Детермінована: той самий seed дає ту саму текстуру.
 */
export function buildGrainTexture(size = GRAIN_TEX_SIZE, seed = 1991) {
  const rng = createRng(seed);
  const out = new Uint8Array(size * size * 4);
  const n = size * size;
  for (let ch = 0; ch < 4; ch++) {
    const white = new Float32Array(n);
    for (let i = 0; i < n; i += 2) {
      // Бокс–Мюллер: два гаусових числа з двох рівномірних
      const u = Math.max(rng.next(), 1e-9);
      const v = rng.next();
      const m = Math.sqrt(-2 * Math.log(u));
      white[i] = m * Math.cos(2 * Math.PI * v);
      if (i + 1 < n) white[i + 1] = m * Math.sin(2 * Math.PI * v);
    }
    const soft = blurWrapped(white, size, 0.8); // грудочки
    const low = blurWrapped(white, size, 3.0); // великі плями, які треба прибрати
    const g = new Float32Array(n);
    let mean = 0;
    for (let i = 0; i < n; i++) {
      g[i] = soft[i] - low[i];
      mean += g[i];
    }
    mean /= n;
    let varSum = 0;
    for (let i = 0; i < n; i++) varSum += (g[i] - mean) ** 2;
    const std = Math.sqrt(varSum / n) || 1;
    for (let i = 0; i < n; i++) out[i * 4 + ch] = clamp(Math.round(128 + ((g[i] - mean) / std) * GRAIN_TEX_SIGMA), 0, 255);
  }
  return out;
}

/** Експозиція → множник зерна: недоекспозиція (EV < 0) його збільшує, переекспозиція зменшує. */
export function exposureGrainMul(ev) {
  return 2 ** (-0.25 * clamp(ev, -2, 2));
}

/** Камери на великому негативі (середній формат, 120) зернять дрібніше за 35 мм. */
export function formatGrain(camera) {
  return camera.format === 'medium' ? { size: 0.6, amount: 0.85 } : { size: 1, amount: 1 };
}
