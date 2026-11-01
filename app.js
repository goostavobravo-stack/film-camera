import { CAMERAS } from './cameras.js';
import { FILMS } from './films.js';
import { FilmPipeline, MAX_OUTPUT_SIZE, computeParams, loadLut } from './pipeline.js';
import { newSeed, rollFrame } from './random.js';

const MAX_FRAMES = 36;
const STORE_KEY = 'film-camera-v1';
const demoMode = new URLSearchParams(location.search).has('demo');

const $ = (id) => document.getElementById(id);
const els = {
  video: $('video'),
  finder: $('finder'),
  msg: $('finder-msg'),
  flash: $('flash'),
  counter: $('counter'),
  counterValue: $('counter-value'),
  shutter: $('shutter'),
  rewind: $('rewind'),
  cameraSelect: $('camera-select'),
  filmSelect: $('film-select'),
  aspectBtns: [...document.querySelectorAll('[data-aspect]')],
  print: $('print'),
  out: $('out'),
  caption: $('print-caption'),
  save: $('save'),
  close: $('close'),
  toast: $('toast'),
};

const EVENT_NAMES = {
  lightLeak: 'світлова протічка',
  dust: 'пил і подряпини',
  overexpose: 'засвіт',
  softFocus: "м'який фокус",
};

// --- налаштування -----------------------------------------------------------

function readStore() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
  } catch {
    return {};
  }
}
function writeStore() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      camera: state.cameraId,
      film: state.filmId,
      aspect: state.aspect,
      count: state.count,
    }));
  } catch { /* приватний режим: працюємо без збереження */ }
}

const saved = readStore();
const state = {
  cameraId: CAMERAS.some((c) => c.id === saved.camera) ? saved.camera : CAMERAS[0].id,
  filmId: FILMS.some((f) => f.id === saved.film) ? saved.film : FILMS[0].id,
  aspect: saved.aspect === '1:1' ? '1:1' : '3:2',
  count: Number.isInteger(saved.count) ? Math.min(Math.max(saved.count, 0), MAX_FRAMES) : 0,
  busy: false,
  last: null, // { blob, name }
};

const pipeline = new FilmPipeline(els.out);
const offscreen = document.createElement('canvas');

// --- UI -----------------------------------------------------------------------

let toastTimer;
function toast(text) {
  els.toast.textContent = text;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2400);
}

function renderCounter() {
  els.counterValue.textContent = String(state.count).padStart(2, '0');
  els.counter.classList.toggle('end', state.count >= MAX_FRAMES);
  els.counter.setAttribute('aria-label', `Знято кадрів: ${state.count} з ${MAX_FRAMES}`);
  els.shutter.setAttribute('aria-disabled', String(state.count >= MAX_FRAMES));
}

function fillSelect(select, items, current) {
  select.replaceChildren(...items.map((it) => new Option(it.name, it.id, false, it.id === current)));
}

function renderAspect() {
  els.aspectBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.aspect === state.aspect)));
  updateFinder();
}

fillSelect(els.cameraSelect, CAMERAS, state.cameraId);
fillSelect(els.filmSelect, FILMS, state.filmId);
els.cameraSelect.addEventListener('change', () => { state.cameraId = els.cameraSelect.value; writeStore(); });
els.filmSelect.addEventListener('change', () => { state.filmId = els.filmSelect.value; writeStore(); });
els.aspectBtns.forEach((b) => b.addEventListener('click', () => {
  state.aspect = b.dataset.aspect;
  writeStore();
  renderAspect();
}));

els.rewind.addEventListener('click', () => {
  if (state.count === 0) return toast('Плівка вже на початку');
  if (state.count < MAX_FRAMES && !confirm('Перемотати плівку? Лічильник скинеться на 0.')) return;
  state.count = 0;
  writeStore();
  renderCounter();
  els.rewind.classList.add('spin');
  setTimeout(() => els.rewind.classList.remove('spin'), 500);
  toast('Плівку перемотано');
});

// --- камера -------------------------------------------------------------------

let stream = null;

function showMsg(text, retry) {
  els.msg.textContent = text;
  els.msg.hidden = false;
  els.msg.disabled = !retry;
}
function hideMsg() {
  els.msg.hidden = true;
}

function describeError(err) {
  switch (err && err.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Немає доступу до камери. Дозвольте його в налаштуваннях браузера й торкніться, щоб повторити.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Камеру не знайдено. Торкніться, щоб повторити.';
    case 'NotSupportedError':
      return 'Камера працює тільки на сторінках HTTPS.';
    default:
      return `Не вдалося запустити камеру${err && err.message ? `: ${err.message}` : ''}. Торкніться, щоб повторити.`;
  }
}

/** Тестова картинка для ?demo: дає змогу перевірити пайплайн без камери. */
function createDemoStream() {
  const cv = document.createElement('canvas');
  cv.width = 1280;
  cv.height = 720;
  const ctx = cv.getContext('2d');
  const draw = (t) => {
    const w = cv.width;
    const h = cv.height;
    const sky = ctx.createLinearGradient(0, 0, 0, h * 0.65);
    sky.addColorStop(0, '#3b6fb5');
    sky.addColorStop(1, '#f3c98b');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);
    const sx = w * (0.7 + 0.03 * Math.sin(t / 1500));
    const sun = ctx.createRadialGradient(sx, h * 0.3, 0, sx, h * 0.3, 60);
    sun.addColorStop(0, '#fff');
    sun.addColorStop(0.6, '#fff6d8');
    sun.addColorStop(1, 'rgba(255,240,200,0)');
    ctx.fillStyle = sun;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#4a6a3a';
    ctx.beginPath();
    ctx.moveTo(0, h * 0.7);
    for (let x = 0; x <= w; x += 40) ctx.lineTo(x, h * (0.62 + 0.06 * Math.sin(x / 130)));
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.fill();
    ctx.fillStyle = '#2f4a2a';
    ctx.fillRect(0, h * 0.8, w, h * 0.2);
    const swatches = ['#d6402d', '#e8a33d', '#4aa36b', '#2f8fd1', '#8a5bb8', '#f0ece0', '#808080', '#151515'];
    swatches.forEach((c, i) => {
      ctx.fillStyle = c;
      ctx.fillRect(w * 0.05 + i * 54, h * 0.83, 46, 46);
    });
    ctx.fillStyle = '#f4efe2'; // скін-тон
    ctx.beginPath();
    ctx.arc(w * 0.3, h * 0.5, 38, 0, Math.PI * 2);
    ctx.fillStyle = '#d9a283';
    ctx.fill();
    ctx.strokeStyle = '#fff'; // тонкі лінії для різкості й аберації
    ctx.lineWidth = 2;
    for (let i = 0; i < 12; i++) {
      ctx.beginPath();
      ctx.moveTo(10, 10 + i * 6);
      ctx.lineTo(w - 10, 10 + i * 6);
      ctx.globalAlpha = i % 2 ? 0.2 : 0.5;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
  return cv.captureStream(30);
}

let startToken = 0;

async function startCamera() {
  const token = ++startToken; // новіший запуск скасовує попередній
  stopCamera();
  showMsg('Запуск камери…', false);
  try {
    let s;
    if (demoMode) {
      s = createDemoStream();
    } else {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw Object.assign(new Error('mediaDevices'), { name: 'NotSupportedError' });
      }
      s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
    }
    if (token !== startToken) {
      s.getTracks().forEach((t) => t.stop());
      return;
    }
    stream = s;
    els.video.srcObject = s;
    await els.video.play();
    if (token !== startToken) return;
    hideMsg();
    updateFinder();
  } catch (err) {
    if (token !== startToken) return;
    console.warn('Камера:', err);
    showMsg(describeError(err), true);
  }
}

function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  els.video.srcObject = null;
}

els.msg.addEventListener('click', startCamera);
els.video.addEventListener('loadedmetadata', updateFinder);
els.video.addEventListener('resize', updateFinder);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    startToken++;
    stopCamera();
  } else if (pipeline.supported) {
    startCamera();
  }
});

// --- геометрія кадру ----------------------------------------------------------

/** Співвідношення сторін кадру. Орієнтація слідує за відео: на портретному телефоні 3:2 стає 2:3. */
function frameAspect() {
  if (state.aspect === '1:1') return 1;
  const portrait = els.video.videoHeight > els.video.videoWidth;
  return portrait ? 2 / 3 : 3 / 2;
}

function updateFinder() {
  els.finder.style.setProperty('--ar', String(frameAspect()));
}

/** Центральний кроп відео під формат кадру та розмір виводу. */
function cropGeometry() {
  const vw = els.video.videoWidth;
  const vh = els.video.videoHeight;
  const ar = frameAspect();
  let sw = vw;
  let sh = vw / ar;
  if (sh > vh) {
    sh = vh;
    sw = vh * ar;
  }
  const scale = Math.min(1, MAX_OUTPUT_SIZE / Math.max(sw, sh));
  return {
    sx: (vw - sw) / 2,
    sy: (vh - sh) / 2,
    sw,
    sh,
    w: Math.max(1, Math.round(sw * scale)),
    h: Math.max(1, Math.round(sh * scale)),
  };
}

// --- спуск --------------------------------------------------------------------

let audioCtx = null;
function clickSound() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = audioCtx;
    const len = Math.floor(ctx.sampleRate * 0.05);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
    [0, 0.07].forEach((delay, k) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = k ? 900 : 2200;
      const gain = ctx.createGain();
      gain.gain.value = 0.5;
      src.connect(filter).connect(gain).connect(ctx.destination);
      src.start(ctx.currentTime + delay);
    });
  } catch { /* без звуку */ }
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function shoot() {
  if (state.busy) return;
  if (state.count >= MAX_FRAMES) return toast('Плівка закінчилась');
  if (!pipeline.supported) return toast('WebGL недоступний на цьому пристрої');
  if (!els.video.videoWidth) return toast('Камера ще не готова');

  state.busy = true;
  clickSound();
  if (navigator.vibrate) navigator.vibrate(12);
  els.flash.classList.remove('go');
  void els.flash.offsetWidth;
  els.flash.classList.add('go');

  try {
    const camera = CAMERAS.find((c) => c.id === state.cameraId);
    const film = FILMS.find((f) => f.id === state.filmId);
    const g = cropGeometry();

    offscreen.width = g.w;
    offscreen.height = g.h;
    offscreen.getContext('2d').drawImage(els.video, g.sx, g.sy, g.sw, g.sh, 0, 0, g.w, g.h);

    const frame = rollFrame(newSeed());
    const lut = await loadLut(film.lut);
    const params = computeParams(camera, film, frame, lut);
    pipeline.render(offscreen, params);
    const blob = await pipeline.toBlob('image/jpeg', 0.92);

    state.count += 1;
    writeStore();
    renderCounter();

    const name = `film-${stamp(new Date())}-${String(state.count).padStart(2, '0')}.jpg`;
    state.last = { blob, name };
    const shot = { n: state.count, camera: camera.id, film: film.id, frame, params };
    window.filmDebug = { ...window.filmDebug, last: shot, pipeline };
    console.log(`[кадр ${shot.n}] ${camera.id} + ${film.id}`, frame);

    const notes = frame.events.map((e) => EVENT_NAMES[e]).filter(Boolean);
    els.caption.textContent =
      `Кадр ${state.count} з ${MAX_FRAMES} · ${camera.name} · ${film.name}` +
      (notes.length ? ` · ${notes.join(', ')}` : '');
    els.print.hidden = false;
    if (state.count >= MAX_FRAMES) toast('Плівка закінчилась');
  } catch (err) {
    console.error(err);
    toast('Не вдалося проявити кадр');
  } finally {
    state.busy = false;
  }
}

els.shutter.addEventListener('click', shoot);

// --- збереження ---------------------------------------------------------------

async function saveLast() {
  const last = state.last;
  if (!last) return;
  const file = new File([last.blob], last.name, { type: 'image/jpeg' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      console.warn('share не вдався, завантажуємо файл:', err);
    }
  }
  const url = URL.createObjectURL(last.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = last.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

els.save.addEventListener('click', saveLast);
els.close.addEventListener('click', () => { els.print.hidden = true; });

// --- старт --------------------------------------------------------------------

renderCounter();
renderAspect();
if (!pipeline.supported) {
  showMsg('Цей браузер не підтримує WebGL, тож проявити кадр неможливо.', false);
} else {
  startCamera();
}
