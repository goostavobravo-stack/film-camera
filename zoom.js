// Збільшення телеоб'єктива. Назва пристрою («Back Telephoto Camera») каже, що це телеоб'єктив, але не скільки в
// нього разів: 2×, 2.5×, 3×, 4× чи 5× залежить від моделі iPhone. Тож порівнюємо два кадри однієї сцени: основної
// камери й телеоб'єктива. Кадр телеоб'єктива дорівнює центральній частині кадра основної камери в 1/f від розміру.
// Для кожного кандидата f беремо цю частину кадра основної камери й шукаємо, при якому f вона найкраще збігається
// з кадром телеоб'єктива (нормована взаємна кореляція, з невеликим зсувом на паралакс і тремтіння рук).

export const TELE_CANDIDATES = [2, 2.5, 3, 4, 5, 8];
/** Нижче цього збігу результату не віримо (рівна стіна, темрява, сильний рух сцени) і лишаємо припущення. */
export const MIN_CONFIDENCE = 0.5;

/** Нормована взаємна кореляція двох масивів однакової довжини, −1…1 (0, якщо один із них рівний). */
export function ncc(a, b) {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    sab += x * y;
    saa += x * x;
    sbb += y * y;
  }
  const den = Math.sqrt(saa * sbb);
  return den < 1e-9 ? 0 : sab / den;
}

function bilinear(gray, w, h, x, y) {
  const cx = Math.min(w - 1, Math.max(0, x));
  const cy = Math.min(h - 1, Math.max(0, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  return (
    gray[y0 * w + x0] * (1 - fx) * (1 - fy) +
    gray[y0 * w + x1] * fx * (1 - fy) +
    gray[y1 * w + x0] * (1 - fx) * fy +
    gray[y1 * w + x1] * fx * fy
  );
}

/**
 * Центральна частина зображення w×h у 1/factor від розміру, масштабована до size×size.
 * dx, dy: зсув у пікселях результату (шукаємо збіг при невеликому зміщенні).
 */
export function sampleCrop(gray, w, h, factor, size, dx = 0, dy = 0) {
  const cw = w / factor;
  const ch = h / factor;
  const out = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = w / 2 + ((i + 0.5 + dx) / size - 0.5) * cw;
      const y = h / 2 + ((j + 0.5 + dy) / size - 0.5) * ch;
      out[j * size + i] = bilinear(gray, w, h, x - 0.5, y - 0.5);
    }
  }
  return out;
}

/**
 * Скільки разів телеоб'єктив збільшує порівняно з основною камерою.
 * @param {ArrayLike<number>} mainGray сірий кадр основної камери, w×h
 * @param {ArrayLike<number>} teleGray сірий кадр телеоб'єктива, того ж розміру w×h
 * @returns {{factor: number, score: number, scores: number[]}} factor з кандидатів, score збігу 0…1
 */
export function estimateZoom(mainGray, teleGray, w, h, { candidates = TELE_CANDIDATES, size = 40, shift = 2 } = {}) {
  const tele = sampleCrop(teleGray, w, h, 1, size);
  const scores = candidates.map((f) => {
    let best = -1;
    for (let dy = -shift; dy <= shift; dy++) {
      for (let dx = -shift; dx <= shift; dx++) {
        best = Math.max(best, ncc(sampleCrop(mainGray, w, h, f, size, dx, dy), tele));
      }
    }
    return best;
  });
  let k = 0;
  scores.forEach((s, i) => {
    if (s > scores[k]) k = i;
  });
  return { factor: candidates[k], score: scores[k], scores };
}

/** Підпис для кнопки: 3 → «3×», 2.5 → «2.5×». */
export const zoomLabel = (factor) => `${Number.isInteger(factor) ? factor : factor.toFixed(1)}×`;

/**
 * Початкове припущення про збільшення телеоб'єктива, поки його не виміряно. Телефони з 5× (Pro 16 і новіші)
 * мають великий екран; решта з телеоб'єктивом дає 3×. Розмір екрана лише підказка: після першого перемикання
 * застосунок вимірює справжнє збільшення.
 */
export function guessTeleFactor(screenW = 0, screenH = 0) {
  const w = Math.min(screenW, screenH);
  const h = Math.max(screenW, screenH);
  if ((w === 402 && h === 874) || (w === 440 && h === 956)) return 5;
  return 3;
}
