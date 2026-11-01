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

  // скло видошукача: сталий для кожної камери відтінок, випуклість (бочка), затемнення й м'якість країв
  const glass = glassFor(camera.id);
  params.wb = params.wb.map((m, i) => m * glass.tint[i]);
  params.barrel += glass.bulge;
  params.vignetteStrength = Math.min(1, params.vignetteStrength + glass.shade);
  params.blurEdge = Math.max(params.blurEdge, glass.edge);
  return params;
}

/**
 * Скло видошукача кожної камери. Усе сталі константи, без випадковості, ефект ніжний:
 *   tint   множник кольору в лінійному світлі (скло й покриття лінз трохи фарбують картинку)
 *   bulge  випуклість: додаткова бочкоподібна дисторсія превʼю
 *   shade  додаткове затемнення країв (товщина скла, призма)
 *   edge   м'якість країв (заломлення на краю лінзи, 0–1 як edgeSoftness)
 *   gloss  сила відблиску на склі (0–1)
 *   coat   колір відблиску просвітленого покриття (rgba)
 */
export const GLASS = {
  leica: { tint: [1.0, 0.985, 0.955], bulge: 0.02, shade: 0.05, edge: 0.04, gloss: 0.1, coat: 'rgba(200,110,230,0.13)' },
  'leica-q3': { tint: [0.975, 0.99, 1.0], bulge: 0.012, shade: 0.04, edge: 0.02, gloss: 0.06, coat: 'rgba(110,220,255,0.09)' },
  'contax-t2': { tint: [0.97, 1.0, 0.97], bulge: 0.035, shade: 0.07, edge: 0.05, gloss: 0.11, coat: 'rgba(110,235,160,0.13)' },
  'canon-ae1': { tint: [1.0, 1.0, 0.97], bulge: 0.025, shade: 0.09, edge: 0.05, gloss: 0.07, coat: 'rgba(255,255,255,0.05)' },
  'olympus-mju2': { tint: [0.955, 0.985, 1.025], bulge: 0.05, shade: 0.08, edge: 0.07, gloss: 0.13, coat: 'rgba(110,165,255,0.15)' },
  'yashica-t4': { tint: [0.96, 1.0, 0.98], bulge: 0.045, shade: 0.08, edge: 0.07, gloss: 0.12, coat: 'rgba(100,225,205,0.13)' },
  'zenit-e': { tint: [1.0, 0.985, 0.925], bulge: 0.03, shade: 0.11, edge: 0.08, gloss: 0.06, coat: 'rgba(255,200,90,0.11)' },
  'lomo-lca': { tint: [0.98, 1.0, 0.955], bulge: 0.05, shade: 0.09, edge: 0.08, gloss: 0.1, coat: 'rgba(255,170,120,0.11)' },
  holga: { tint: [0.96, 1.0, 0.915], bulge: 0.07, shade: 0.12, edge: 0.12, gloss: 0.15, coat: 'rgba(255,240,140,0.11)' },
  diana: { tint: [1.0, 0.95, 0.935], bulge: 0.07, shade: 0.12, edge: 0.12, gloss: 0.15, coat: 'rgba(255,150,150,0.11)' },
};
const NO_GLASS = { tint: [1, 1, 1], bulge: 0, shade: 0, edge: 0, gloss: 0, coat: 'rgba(0,0,0,0)' };

export const glassFor = (cameraId) => GLASS[cameraId] || NO_GLASS;

/** CSS-змінні для шару відблисків на склі видошукача. */
export function glassStyle(cameraId) {
  const g = glassFor(cameraId);
  return { '--gloss': String(g.gloss), '--gloss2': String(+(g.gloss * 0.55).toFixed(3)), '--coat': g.coat, '--shade': String(g.shade) };
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

/** Розмітка видошукача камери плюс шар відблисків скла поверх усього. */
export function finderHtml(camera) {
  return `${finderMarkup(camera.finder)}<div class="vf-glass"></div>`;
}
