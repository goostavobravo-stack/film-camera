// Барабан вибору: вертикальне колесо з «магнітним» зупиненням на пункті, як у механічних лічильниках.
// Прокручується пальцем або колесом миші, клацає при кожному пункті, клавіші ↑/↓ теж працюють.

import { haptic, tickSound } from './haptics.js';

export const DRUM_ITEM_PX = 28; // висота пункту; той самий розмір у CSS (--drum-item)

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Який пункт у центрі барабана при прокрутці scrollTop. */
export function drumIndexAt(scrollTop, count, item = DRUM_ITEM_PX) {
  return clamp(Math.round(scrollTop / item), 0, Math.max(0, count - 1));
}

/**
 * Вигляд пункту за зміщенням від центра (у пунктах): що далі від центра, то більше він «загинається»
 * за циліндр барабана (кут), менший і блідіший.
 */
export function drumItemLook(offset) {
  const a = clamp(offset, -2.2, 2.2);
  return {
    rotate: -a * 26,
    scale: 1 - Math.min(Math.abs(a), 2) * 0.08,
    opacity: Math.max(0.15, 1 - Math.abs(a) * 0.42),
  };
}

/**
 * @param {HTMLElement} root контейнер .drum
 * @param {{id: string, label: string}[]} items
 * @param {{index?: number, label?: string, onChange?: (item, index) => void}} opts
 */
export function createDrum(root, items, { index = 0, label = '', onChange } = {}) {
  root.classList.add('drum');
  root.tabIndex = 0;
  root.setAttribute('role', 'listbox');
  if (label) root.setAttribute('aria-label', label);

  const scroller = document.createElement('div');
  scroller.className = 'drum-scroll';
  const nodes = items.map((it, i) => {
    const d = document.createElement('div');
    d.className = 'drum-item';
    d.setAttribute('role', 'option');
    d.textContent = it.label;
    d.title = it.label;
    d.addEventListener('click', () => scrollToIndex(i, true));
    scroller.append(d);
    return d;
  });
  const band = document.createElement('div');
  band.className = 'drum-band';
  band.setAttribute('aria-hidden', 'true');
  root.replaceChildren(scroller, band);

  let current = clamp(index, 0, items.length - 1);
  let lastTick = current;
  let settleTimer = 0;
  let raf = 0;

  function paint() {
    raf = 0;
    const pos = scroller.scrollTop / DRUM_ITEM_PX;
    nodes.forEach((d, i) => {
      const look = drumItemLook(i - pos);
      d.style.transform = `perspective(170px) rotateX(${look.rotate.toFixed(1)}deg) scale(${look.scale.toFixed(3)})`;
      d.style.opacity = look.opacity.toFixed(2);
    });
    const idx = drumIndexAt(scroller.scrollTop, items.length);
    if (idx !== lastTick) {
      lastTick = idx;
      haptic('tick');
      tickSound('tick');
    }
  }

  function settle() {
    const idx = drumIndexAt(scroller.scrollTop, items.length);
    nodes.forEach((d, i) => d.setAttribute('aria-selected', String(i === idx)));
    if (idx !== current) {
      current = idx;
      if (onChange) onChange(items[idx], idx);
    }
  }

  function scrollToIndex(i, smooth) {
    scroller.scrollTo({ top: clamp(i, 0, items.length - 1) * DRUM_ITEM_PX, behavior: smooth ? 'smooth' : 'auto' });
  }

  scroller.addEventListener('scroll', () => {
    if (!raf) raf = requestAnimationFrame(paint);
    clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, 140);
  }, { passive: true });

  root.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') scrollToIndex(drumIndexAt(scroller.scrollTop, items.length) + 1, true);
    else if (e.key === 'ArrowUp') scrollToIndex(drumIndexAt(scroller.scrollTop, items.length) - 1, true);
    else return;
    e.preventDefault();
  });

  /** Ставить барабан у позицію без події onChange (для відновлення вибору). */
  function setIndex(i) {
    current = clamp(i, 0, items.length - 1);
    lastTick = current;
    scroller.scrollTop = current * DRUM_ITEM_PX;
    nodes.forEach((d, k) => d.setAttribute('aria-selected', String(k === current)));
    paint();
  }

  /** Після появи прихованого барабана на екрані прокрутка збивається: повертаємо її на місце. */
  function sync() {
    setIndex(current);
  }

  requestAnimationFrame(sync);
  return { setIndex, sync, get index() { return current; } };
}
