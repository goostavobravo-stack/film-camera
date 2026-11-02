// Проявка трусінням: акселерометр (devicemotion) або перетягування пальцем перетворюються на прогрес 0…1.

/** Етапи проявки за прогресом: просто підписи, хімія тут умовна. */
export const STAGES = [
  { from: 0, name: 'Проявник', hint: 'Плівка в проявнику: трусіть баночку' },
  { from: 0.4, name: 'Зупинка', hint: 'Зупиняємо проявлення: ще трошки' },
  { from: 0.55, name: 'Фіксаж', hint: 'Фіксуємо зображення: не зупиняйтесь' },
  { from: 0.8, name: 'Промивка', hint: 'Промиваємо плівку: майже готово' },
];

export function stageFor(progress) {
  let stage = STAGES[0];
  for (const s of STAGES) if (progress >= s.from) stage = s;
  return stage;
}

/**
 * Міряє «роботу» трусіння: різкі зміни модуля прискорення. Спокійне тримання телефона
 * (тремтіння руки, ходьба) нічого не дає, енергійне трусіння заповнює шкалу секунд за 10–15.
 */
export class ShakeMeter {
  constructor({ threshold = 1.2, cap = 15, need = 1800 } = {}) {
    this.threshold = threshold;
    this.cap = cap;
    this.need = need;
    this.work = 0;
    this.intensity = 0; // згладжена інтенсивність 0…1 для анімації
    this.prev = null;
    this.prevT = null;
  }

  /** Нове значення акселерометра в м/с² (разом із гравітацією), t у мілісекундах. Повертає приріст. */
  push(x, y, z, t = 0) {
    const m = Math.hypot(x, y, z);
    let gain = 0;
    if (this.prev !== null) {
      const dt = this.prevT !== null && t > this.prevT ? Math.min(t - this.prevT, 50) : 16.7;
      const k = dt / 16.7; // щоб частота датчика (60, 120, 200 Гц) не впливала на швидкість проявки
      const jerk = Math.abs(m - this.prev) / k;
      gain = Math.max(0, Math.min(jerk, this.cap) - this.threshold) * k;
    }
    this.prev = m;
    this.prevT = t;
    return this.#add(gain);
  }

  /** Резервний режим без датчиків: пальцем по баночці, px — пройдена відстань. */
  addDistance(px) {
    return this.#add(Math.max(0, px) * 0.2);
  }

  #add(gain) {
    this.work = Math.min(this.need, this.work + gain);
    this.intensity = this.intensity * 0.85 + Math.min(1, gain / 6) * 0.15;
    return gain;
  }

  get progress() {
    return this.work / this.need;
  }

  get done() {
    return this.work >= this.need;
  }
}
