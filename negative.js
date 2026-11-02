// Негатив: із готового «позитивного» кадру виходить зображення на плівці.
// Кольорова плівка має оранжеву основу (маску), чорно-біла майже нейтральну: тіні на негативі світлі,
// світла темні, кольори інвертовані. Формула: негатив = основа × (1 − щільність × позитив).

/** Оранжева маска кольорового негатива (R, G, B у частках 0–1). */
export const COLOR_BASE = [0.93, 0.62, 0.38];
/** Основа чорно-білого негатива: майже прозора, з легкою теплотою. */
export const BW_BASE = [0.82, 0.8, 0.77];
/** Наскільки темніє негатив у світлах: 1 = до чорного, менше = плівка ніколи не стає суцільно чорною. */
export const DENSITY = 0.86;

/** Перетворює RGBA-пікселі (Uint8ClampedArray) у негатив на місці. Альфа не змінюється. */
export function negativePixels(data, bw = false) {
  const base = bw ? BW_BASE : COLOR_BASE;
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      data[i + c] = Math.round(255 * base[c] * (1 - DENSITY * (data[i + c] / 255)));
    }
  }
  return data;
}

/** Робить JPEG-негатив із JPEG-позитива (браузер: createImageBitmap + canvas). */
export async function renderNegative(blob, { bw = false, quality = 0.88 } = {}) {
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  if (bmp.close) bmp.close();
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  negativePixels(img.data, bw);
  ctx.putImageData(img, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob не вдався'))), 'image/jpeg', quality);
  });
}
