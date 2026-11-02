// Темна кімната: усе, що відбувається з плівкою після зйомки.
//   exposed   плівка знята (повна або відрізана), її ще не видно
//   develop   проявка: потрусити телефон, поки баночка не «вимиє» плівку
//   negatives негативи (помаранчева основа, інвертовані кольори)
//   positives негативи переведені в позитиви, їх можна переглянути й зберегти
// Екран камери (phase = 'shooting') сюди не потрапляє, окрім списку невиявлених кадрів (openLatent).

import { ShakeMeter, stageFor } from './shake.js';
import { renderNegative } from './negative.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const TITLES = { exposed: 'Плівку знято', develop: 'Проявка', negatives: 'Негативи', positives: 'Позитиви' };
/** Які кнопки нижньої панелі видно на кожному етапі. */
const BAR = { exposed: ['develop'], develop: [], negatives: ['convert'], positives: ['newroll', 'saveall'] };

/**
 * ctx: {
 *   state            спільний стан: { phase, endReason, roll, maxFrames }
 *   isActive()       чи вибрано режим «Темна кімната» (інакше кімнату не показуємо)
 *   setPhase(phase)  змінює етап і зберігає його
 *   saveFrame(frame) дописує кадр у сховище
 *   clearAll()       видаляє всі кадри зі сховища й зі стану
 *   onNewRoll()      повертає екран камери
 *   toast(text, ms)
 *   deliver(items)   віддає файли користувачу: [{ blob, name }]
 * }
 */
export function createLab(ctx) {
  const { state, toast } = ctx;
  const $ = (id) => document.getElementById(id);
  const el = {
    lab: $('lab'),
    title: $('lab-title'),
    views: {
      exposed: $('lab-exposed'),
      develop: $('lab-develop'),
      negatives: $('lab-negatives'),
      positives: $('lab-positives'),
    },
    bar: $('lab-bar'),
    buttons: {
      develop: $('lab-btn-develop'),
      convert: $('lab-btn-convert'),
      newroll: $('lab-btn-newroll'),
      saveall: $('lab-btn-saveall'),
    },
    exposedTitle: $('exposed-title'),
    exposedText: $('exposed-text'),
    jar: $('jar'),
    gaugeFill: $('gauge-fill'),
    gaugePct: $('gauge-pct'),
    stage: $('stage-name'),
    hint: $('develop-hint'),
    shakeStart: $('shake-start'),
    negStrips: $('neg-strips'),
    posGrid: $('pos-grid'),
    latent: $('latent'),
    latentTitle: $('latent-title'),
    latentGrid: $('latent-grid'),
    latentEmpty: $('latent-empty'),
    latentClose: $('latent-close'),
    viewer: $('lab-viewer'),
    viewerStage: $('lab-viewer-stage'),
    viewerTrack: $('lab-viewer-track'),
    viewerSlides: [...document.querySelectorAll('#lab-viewer-track img')],
    viewerPrev: $('lab-viewer-prev'),
    viewerNext: $('lab-viewer-next'),
    viewerPos: $('lab-viewer-pos'),
    viewerCaption: $('lab-viewer-caption'),
    viewerBack: $('lab-viewer-back'),
    viewerSave: $('lab-viewer-save'),
  };

  // --- адреси blob-ів -------------------------------------------------------------
  const urls = new Map();
  function url(key, blob) {
    if (!urls.has(key)) urls.set(key, URL.createObjectURL(blob));
    return urls.get(key);
  }
  const frameUrl = (frame, field) => url(`${frame.id}:${field}`, frame[field]);
  function revokeAll() {
    urls.forEach((u) => URL.revokeObjectURL(u));
    urls.clear();
  }

  // --- вигляд за етапом -----------------------------------------------------------
  function render() {
    const phase = state.phase;
    // темна кімната видна, лише коли вибрано її режим і плівку вже знято
    el.lab.hidden = phase === 'shooting' || (ctx.isActive ? !ctx.isActive() : false);
    if (el.lab.hidden) return;
    el.title.textContent = phase === 'positives' ? `Позитиви · ${state.roll.length}` : TITLES[phase];
    Object.entries(el.views).forEach(([name, view]) => { view.hidden = name !== phase; });
    const visible = BAR[phase];
    Object.entries(el.buttons).forEach(([name, b]) => { b.hidden = !visible.includes(name); });
    el.bar.hidden = visible.length === 0;
    ({ exposed: renderExposed, develop: renderDevelop, negatives: renderNegatives, positives: renderPositives })[phase]();
  }

  function renderExposed() {
    const n = state.roll.length;
    el.exposedTitle.textContent = state.endReason === 'full' ? 'Плівка закінчилась' : 'Плівку відрізано';
    el.exposedText.textContent =
      `Знято кадрів: ${n} з ${state.maxFrames}. Нічого не видно: плівку ще треба проявити. ` +
      'Покладіть її в баночку й потрусіть телефон.';
  }

  // --- проявка трусінням -------------------------------------------------------
  let meter = null;
  let shaking = false;
  let finishing = false;
  let sensorSeen = false;
  let tilt = 0;
  let rafId = 0;
  let negPromise = null;
  let modeNote = ''; // пояснення, чому замість датчика пропонується палець

  const HINT_IDLE = 'Натисніть «Почати проявку», потім міцно потрусіть телефон, як баночку з проявником.';

  /** Негативні мініатюри для стрічки: рахуємо у фоні, поки користувач трусить. */
  function prepareNegatives() {
    if (!negPromise) {
      negPromise = (async () => {
        for (const f of state.roll) {
          if (f.thumbNeg) continue;
          f.thumbNeg = await renderNegative(f.thumbPos, { bw: f.bw, quality: 0.82 });
          ctx.saveFrame(f);
          await sleep(0);
        }
      })();
    }
    return negPromise;
  }

  function renderDevelop() {
    if (!meter) meter = new ShakeMeter();
    el.shakeStart.hidden = shaking;
    el.hint.textContent = shaking ? el.hint.textContent : HINT_IDLE;
    paint();
    prepareNegatives();
  }

  function paint() {
    const p = meter ? meter.progress : 0;
    el.gaugeFill.style.width = `${Math.round(p * 100)}%`;
    el.gaugePct.textContent = `${Math.round(p * 100)}%`;
    const stage = stageFor(p);
    el.stage.textContent = shaking ? stage.name : 'Баночка з проявником';
    if (shaking && !finishing) el.hint.textContent = modeNote ? `${stage.hint}. ${modeNote}` : stage.hint;
    el.jar.style.setProperty('--slosh', String(meter ? meter.intensity : 0));
    el.jar.style.transform = `rotate(${tilt.toFixed(1)}deg)`;
    if (meter && meter.done) finish();
  }

  function schedulePaint() {
    if (!rafId) {
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        paint();
      });
    }
  }

  function onMotion(e) {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null || !meter) return;
    sensorSeen = true;
    meter.push(a.x, a.y, a.z, e.timeStamp);
    tilt = tilt * 0.8 + clamp(a.x * 2.2, -20, 20) * 0.2;
    schedulePaint();
  }

  async function startShake() {
    if (shaking) return;
    shaking = true;
    sensorSeen = false;
    modeNote = '';
    el.shakeStart.hidden = true;
    let sensor = typeof DeviceMotionEvent !== 'undefined';
    // iOS 13+ віддає рух лише після явного дозволу з жесту користувача
    if (sensor && typeof DeviceMotionEvent.requestPermission === 'function') {
      try {
        sensor = (await DeviceMotionEvent.requestPermission()) === 'granted';
      } catch {
        sensor = false;
      }
    }
    if (sensor) {
      window.addEventListener('devicemotion', onMotion);
      setTimeout(() => {
        if (shaking && !sensorSeen) {
          modeNote = 'Датчик руху мовчить: проводьте пальцем по баночці вгору-вниз.';
          schedulePaint();
        }
      }, 2500);
    } else {
      modeNote = 'Датчики руху недоступні або заборонені: проводьте пальцем по баночці вгору-вниз.';
    }
    schedulePaint();
  }

  // резервний режим: пальцем (або мишею) по баночці
  let drag = null;
  el.jar.addEventListener('pointerdown', (e) => {
    if (!shaking) return;
    drag = { x: e.clientX, y: e.clientY };
    try {
      el.jar.setPointerCapture(e.pointerId);
    } catch { /* без захоплення вказівника рух усе одно рахується */ }
  });
  el.jar.addEventListener('pointermove', (e) => {
    if (!drag || !meter) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    meter.addDistance(Math.hypot(dx, dy));
    tilt = clamp(dx * 0.6, -18, 18);
    drag = { x: e.clientX, y: e.clientY };
    schedulePaint();
  });
  const endDrag = () => { drag = null; };
  el.jar.addEventListener('pointerup', endDrag);
  el.jar.addEventListener('pointercancel', endDrag);

  async function finish() {
    if (finishing) return;
    finishing = true;
    window.removeEventListener('devicemotion', onMotion);
    el.stage.textContent = 'Сушимо плівку…';
    el.hint.textContent = 'Плівка проявлена: розрізаємо на смужки';
    tilt = 0;
    await prepareNegatives();
    if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
    toast('Плівку проявлено');
    await sleep(600);
    shaking = false;
    finishing = false;
    meter = null;
    modeNote = '';
    ctx.setPhase('negatives');
  }

  el.shakeStart.addEventListener('click', startShake);

  // --- негативи ---------------------------------------------------------------
  function renderNegatives() {
    const roll = state.roll;
    const rows = [];
    for (let i = 0; i < roll.length; i += 3) rows.push(roll.slice(i, i + 3));
    el.negStrips.replaceChildren(
      ...rows.map((row) => {
        const strip = document.createElement('div');
        strip.className = 'strip';
        for (let i = 0; i < 3; i++) {
          const f = row[i];
          const cell = document.createElement(f ? 'button' : 'div');
          cell.className = 'neg-frame';
          if (f) {
            cell.type = 'button';
            cell.setAttribute('aria-label', `Негатив ${f.n}`);
            const img = document.createElement('img');
            img.src = frameUrl(f, f.converted ? 'thumbPos' : 'thumbNeg');
            img.alt = '';
            const code = document.createElement('span');
            code.className = 'keycode';
            code.textContent = `${f.n}A`;
            cell.append(img, code);
            cell.addEventListener('click', () => openViewer(f));
          }
          strip.append(cell);
        }
        return strip;
      }),
    );
    el.buttons.convert.disabled = false;
  }

  let converting = false;
  async function convertAll() {
    if (converting) return;
    converting = true;
    el.buttons.convert.disabled = true;
    const imgs = [...el.negStrips.querySelectorAll('.neg-frame img')];
    // інверсія по черзі: негатив темніє, світлішає і стає позитивом
    await Promise.all(
      state.roll.map(async (f, i) => {
        const img = imgs[i];
        if (!img) return;
        await sleep(i * 50);
        img.classList.add('inverting');
        await sleep(700);
        img.style.transition = 'none';
        img.src = frameUrl(f, 'thumbPos');
        img.classList.remove('inverting');
      }),
    );
    state.roll.forEach((f) => {
      f.converted = true;
      ctx.saveFrame(f);
    });
    if (navigator.vibrate) navigator.vibrate(40);
    toast('Негативи переведено в позитиви');
    await sleep(500);
    converting = false;
    ctx.setPhase('positives');
  }

  // --- позитиви ---------------------------------------------------------------
  function renderPositives() {
    el.posGrid.replaceChildren(
      ...state.roll.map((f) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('aria-label', `Кадр ${f.n}`);
        const img = document.createElement('img');
        img.src = frameUrl(f, 'thumbPos');
        img.alt = '';
        const num = document.createElement('span');
        num.className = 'num';
        num.textContent = String(f.n);
        b.append(img, num);
        b.addEventListener('click', () => openViewer(f));
        return b;
      }),
    );
  }

  async function newRoll() {
    const message =
      'Почати нову плівку? Усі кадри з цієї плівки буде видалено назавжди. ' +
      'Якщо вони ще потрібні, спершу натисніть «Зберегти все».';
    if (!confirm(message)) return;
    revokeAll();
    negPromise = null;
    meter = null;
    shaking = false;
    await ctx.clearAll();
    ctx.onNewRoll();
  }

  // --- перегляд кадру зі свайпом -------------------------------------------------
  // Свайп вліво веде до наступного кадру плівки, вправо до попереднього (порядок як у сітці).
  // Працює і для негативів, і для позитивів.

  let viewing = null;
  let viewToken = 0;
  let navigating = false;
  const isPositive = (f) => state.phase === 'positives' || f.converted;
  const viewIndex = () => state.roll.findIndex((f) => f.id === viewing.id);

  /** Зсув стрічки слайдів: dx пікселів від центрального положення. */
  function setTrack(dx, animate) {
    el.viewerTrack.classList.toggle('anim', animate);
    el.viewerTrack.style.transform = `translateX(calc(-100% + ${dx}px))`;
  }

  /** Позитив показуємо одразу; негатив спершу мініатюрою, потім повнорозмірним (його в сховищі немає, рахуємо на вимогу). */
  function slideSource(frame, img, token) {
    if (isPositive(frame)) {
      img.src = frameUrl(frame, 'positive');
      return;
    }
    const key = `${frame.id}:negfull`;
    img.src = urls.has(key) ? urls.get(key) : frameUrl(frame, 'thumbNeg');
    if (urls.has(key)) return;
    renderNegative(frame.positive, { bw: frame.bw })
      .then((blob) => {
        if (token === viewToken && viewing) img.src = url(key, blob);
      })
      .catch(() => {});
  }

  function revokeNegFull(keepKeys = new Set()) {
    for (const key of [...urls.keys()]) {
      if (key.endsWith(':negfull') && !keepKeys.has(key)) {
        URL.revokeObjectURL(urls.get(key));
        urls.delete(key);
      }
    }
  }

  /** Слайди: попередній, поточний, наступний. */
  function renderViewer() {
    const roll = state.roll;
    const i = viewIndex();
    const shots = [roll[i - 1], roll[i], roll[i + 1]];
    const token = ++viewToken;
    revokeNegFull(new Set(shots.filter(Boolean).map((f) => `${f.id}:negfull`)));
    el.viewerSlides.forEach((img, k) => {
      if (shots[k]) slideSource(shots[k], img, token);
      else img.removeAttribute('src');
    });
    const positive = isPositive(viewing);
    el.viewerSave.hidden = !positive;
    el.viewerCaption.textContent = positive ? viewing.caption || '' : `Негатив, кадр ${viewing.n}`;
    el.viewerPos.textContent = `${i + 1} / ${roll.length}`;
    el.viewerPrev.hidden = i <= 0;
    el.viewerNext.hidden = i >= roll.length - 1;
    setTrack(0, false);
  }

  function openViewer(frame) {
    viewing = frame;
    el.viewer.hidden = false;
    renderViewer();
  }

  function closeViewer() {
    revokeNegFull();
    viewToken++;
    viewing = null;
    el.viewer.hidden = true;
    el.viewerSlides.forEach((img) => img.removeAttribute('src'));
  }

  /** dir = 1: до наступного кадру, -1: до попереднього. Якщо далі нікуди, стрічка пружинить назад. */
  function go(dir) {
    if (!viewing || navigating) return;
    const roll = state.roll;
    const j = viewIndex() + dir;
    if (j < 0 || j >= roll.length) return setTrack(0, true);
    navigating = true;
    setTrack(-dir * el.viewerStage.clientWidth, true);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(fallback);
      el.viewerTrack.removeEventListener('transitionend', finish);
      viewing = roll[j];
      renderViewer();
      navigating = false;
    };
    const fallback = setTimeout(finish, 450); // якщо transitionend не спрацював
    el.viewerTrack.addEventListener('transitionend', finish);
  }

  let swipe = null;
  el.viewerStage.addEventListener('pointerdown', (e) => {
    if (navigating || e.target.closest('.viewer-nav')) return;
    swipe = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), dx: 0, horizontal: null };
  });
  el.viewerStage.addEventListener('pointermove', (e) => {
    if (!swipe || e.pointerId !== swipe.id) return;
    const dx = e.clientX - swipe.x;
    const dy = e.clientY - swipe.y;
    if (swipe.horizontal === null) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      swipe.horizontal = Math.abs(dx) > Math.abs(dy);
      if (swipe.horizontal) {
        try {
          el.viewerStage.setPointerCapture(e.pointerId);
        } catch { /* без захоплення свайп усе одно працює */ }
      }
    }
    if (!swipe.horizontal) return;
    const i = viewIndex();
    const atEdge = (dx > 0 && i <= 0) || (dx < 0 && i >= state.roll.length - 1);
    swipe.dx = atEdge ? dx * 0.3 : dx; // на краю стрічка пручається
    setTrack(swipe.dx, false);
  });
  function endSwipe(e) {
    if (!swipe || e.pointerId !== swipe.id) return;
    const s = swipe;
    swipe = null;
    if (!s.horizontal) return;
    const width = el.viewerStage.clientWidth;
    const speed = s.dx / Math.max(1, performance.now() - s.t); // px/мс
    const far = Math.abs(s.dx) > width * 0.2;
    const flick = Math.abs(speed) > 0.5 && Math.abs(s.dx) > 30;
    if (far || flick) go(s.dx < 0 ? 1 : -1);
    else setTrack(0, true);
  }
  el.viewerStage.addEventListener('pointerup', endSwipe);
  el.viewerStage.addEventListener('pointercancel', endSwipe);

  el.viewerPrev.addEventListener('click', () => go(-1));
  el.viewerNext.addEventListener('click', () => go(1));
  document.addEventListener('keydown', (e) => {
    if (el.viewer.hidden) return;
    if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === 'ArrowRight') go(1);
    else if (e.key === 'Escape') closeViewer();
  });
  el.viewerBack.addEventListener('click', closeViewer);
  el.viewerSave.addEventListener('click', () => {
    if (viewing && isPositive(viewing)) ctx.deliver([{ blob: viewing.positive, name: viewing.name }]);
  });

  // --- невиявлені кадри в камері -----------------------------------------------
  function openLatent() {
    const n = state.roll.length;
    el.latentTitle.textContent = n ? `Плівка в камері · ${n}` : 'Плівка в камері';
    el.latentEmpty.hidden = n > 0;
    el.latentGrid.replaceChildren(
      ...state.roll.map((f) => {
        const tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'tile';
        tile.setAttribute('aria-label', `Кадр ${f.n}, не проявлений`);
        tile.textContent = String(f.n);
        tile.addEventListener('click', () => toast('Кадр ще не проявлений: його видно лише після проявки плівки'));
        return tile;
      }),
    );
    el.latent.hidden = false;
  }
  el.latentClose.addEventListener('click', () => { el.latent.hidden = true; });

  // --- кнопки нижньої панелі -----------------------------------------------------
  el.buttons.develop.addEventListener('click', () => ctx.setPhase('develop'));
  el.buttons.convert.addEventListener('click', convertAll);
  el.buttons.newroll.addEventListener('click', newRoll);
  el.buttons.saveall.addEventListener('click', () => {
    ctx.deliver(state.roll.map((f) => ({ blob: f.positive, name: f.name })));
  });

  return { render, openLatent };
}
