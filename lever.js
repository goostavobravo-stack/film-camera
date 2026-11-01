// Важіль перемотки: потрібно протягнути ручку зліва направо до кінця. Механічний храповик клацає
// (і вібрує) через кожні 8 % ходу, на кінці важіль «падає» важким клацанням.

import { haptic, tickSound } from './haptics.js';

export const RATCHET_STEP = 0.08;
export const COMPLETE_AT = 0.92; // скільки ходу вважається «дотягнув»

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Скільки зубців храповика пройшла ручка між двома положеннями (0…1). */
export function ratchetTicks(prev, next, step = RATCHET_STEP) {
  return Math.abs(Math.floor(next / step) - Math.floor(prev / step));
}

/**
 * root: елемент .lever з дочірнім .lever-knob. onComplete викликається, коли ручку дотягнуто до кінця.
 * Ручка повертається на початок сама: важіль можна тягнути знову.
 */
export function createLever(root, { onComplete } = {}) {
  const knob = root.querySelector('.lever-knob');
  let progress = 0;
  let drag = null;
  let busy = false;

  const travel = () => Math.max(1, root.clientWidth - knob.offsetWidth - 8);

  function set(p, animate) {
    progress = clamp(p, 0, 1);
    root.style.setProperty('--p', progress.toFixed(3));
    knob.style.transition = animate ? 'transform 0.28s cubic-bezier(0.2, 0.9, 0.3, 1.15)' : 'none';
    knob.style.transform = `translateX(${(progress * travel()).toFixed(1)}px)`;
    root.setAttribute('aria-valuenow', String(Math.round(progress * 100)));
  }

  function moveTo(p) {
    const next = clamp(p, 0, 1);
    for (let i = ratchetTicks(progress, next); i > 0; i--) {
      haptic('tick');
      tickSound('ratchet');
    }
    set(next, false);
  }

  function finish() {
    if (busy) return;
    if (progress >= COMPLETE_AT) {
      busy = true;
      set(1, true);
      haptic('heavy');
      tickSound('thunk');
      if (onComplete) onComplete();
      setTimeout(() => {
        set(0, true);
        busy = false;
      }, 520);
    } else {
      set(0, true);
    }
    root.classList.remove('dragging');
  }

  knob.addEventListener('pointerdown', (e) => {
    if (busy) return;
    drag = { id: e.pointerId, x: e.clientX, p: progress };
    root.classList.add('dragging');
    try {
      knob.setPointerCapture(e.pointerId);
    } catch { /* без захоплення тягнеться в межах ручки */ }
    haptic('click');
    tickSound('ratchet');
  });
  knob.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    moveTo(drag.p + (e.clientX - drag.x) / travel());
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    finish();
  };
  knob.addEventListener('pointerup', end);
  knob.addEventListener('pointercancel', end);

  // клавіатура: → просуває важіль на чверть, ← повертає; дотягнув, спрацьовує
  root.addEventListener('keydown', (e) => {
    if (busy) return;
    if (e.key === 'ArrowRight') moveTo(progress + 0.25);
    else if (e.key === 'ArrowLeft') moveTo(progress - 0.25);
    else return;
    e.preventDefault();
    if (progress >= COMPLETE_AT) finish();
  });
  window.addEventListener('resize', () => set(progress, false));

  set(0, false);
  return { reset: () => set(0, true) };
}
