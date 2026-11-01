// Видошукачі камер і параметри живого превʼю.
// Превʼю: кадр з камери проходить той самий пайплайн (лінза камери + плівка), але без випадкових подій
// (протічок, пилу, засвіту): вони виникають лише на знімку. Розмітка видошукача залежить від типу камери.

import { computeParams } from './pipeline.js';
import { developFilm } from './films.js';
import { NEUTRAL_FRAME, hashSeed } from './random.js';

/** Превʼю менше за готовий кадр, тож зерно в ньому слабшає, щоб не було «піску». */
export const PREVIEW_GRAIN = 0.65;

/**
 * Параметри шейдерів для живого превʼю.
 * Для «Просрочки» й «Намотки» вигляд залежить від seed: оновлюйте його після кожного знімка.
 */
export function buildPreviewParams(camera, film, seed, { flash = false } = {}) {
  const dev = developFilm(camera.digital ? camera.look : film, seed);
  const frame = { ...NEUTRAL_FRAME, seed: hashSeed(seed), flash: flash ? 1 : 0 };
  const params = computeParams(camera, dev.film, frame, null, null);
  params.grainAmount *= PREVIEW_GRAIN;
  return params;
}

/**
 * Розмітка видошукача (HTML усередині контейнера .vf, усе в відсотках від кадру):
 *   rangefinder  дальномір (Leica M): яскрава рамка, жовта пляма дальноміра
 *   slr          дзеркалка (Canon AE-1, Зеніт): матове скло, розщеплений круг, шкала витримки
 *   compact      компакт (mju-II, T4, Contax T2): кути, рамка автофокуса, діоди
 *   zone         зональний фокус (Lomo LC-A): шкала дистанцій
 *   toy          пластикова камера (Holga, Diana): тьмяна рамка, темні кути
 *   evf          електронний видошукач цифрової камери (Leica Q3): сітка й рядок параметрів
 */
export const FINDERS = {
  rangefinder: `
    <div class="vf-frame" style="inset:8% 7%"></div>
    <div class="vf-patch"></div>
    <i class="vf-tag" style="left:8.5%;bottom:9.5%">35</i>
    <i class="vf-tag" style="right:8.5%;bottom:9.5%">0.7 m</i>`,
  slr: `
    <div class="vf-ground"></div>
    <div class="vf-prism"></div>
    <div class="vf-split"></div>
    <div class="vf-scale"><b></b></div>
    <div class="vf-mask"></div>`,
  compact: `
    <div class="vf-tunnel"></div>
    <div class="vf-corners" style="inset:9% 7%"></div>
    <div class="vf-af"></div>
    <div class="vf-leds"><b class="green"></b><b class="red"></b></div>`,
  zone: `
    <div class="vf-frame" style="inset:7% 6% 15% 6%"></div>
    <div class="vf-zones"><span>0.8</span><span>1.5</span><span>3</span><span>∞</span></div>
    <div class="vf-tunnel"></div>`,
  toy: `
    <div class="vf-toy"></div>
    <div class="vf-frame faint" style="inset:5%"></div>`,
  evf: `
    <div class="vf-grid"></div>
    <div class="vf-af evf"></div>
    <div class="vf-info"><span>28</span><span>f/1.7</span><span>1/500</span><span>ISO 100</span></div>`,
};

/** HTML видошукача для типу камери; невідомий тип дає порожній видошукач. */
export function finderMarkup(type) {
  return FINDERS[type] || '';
}
