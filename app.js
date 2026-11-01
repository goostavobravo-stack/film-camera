import { CAMERAS } from './cameras.js';
import { FILMS, developFilm } from './films.js';
import { FilmPipeline, MAX_OUTPUT_SIZE, computeParams, formatDateStamp, loadLut } from './pipeline.js';
import { newSeed, rollFrame } from './random.js';
import { clearShots, deleteShot, loadShots, saveShot } from './store.js';

const MAX_FRAMES = 36;
const STORE_KEY = 'film-camera-v1';
const TORCH_WARMUP_MS = 450;
const demoMode = new URLSearchParams(location.search).has('demo');

const $ = (id) => document.getElementById(id);
const els = {
  video: $('video'),
  finder: $('finder'),
  msg: $('finder-msg'),
  flash: $('flash'),
  counter: $('counter'),
  wheelTens: $('wheel-tens'),
  wheelOnes: $('wheel-ones'),
  shutter: $('shutter'),
  rewind: $('rewind'),
  cameraSelect: $('camera-select'),
  filmSelect: $('film-select'),
  canister: $('canister'),
  canisterBrand: $('canister-brand'),
  canisterName: $('canister-name'),
  filmInfo: $('film-info'),
  camInfo: $('cam-info'),
  flashBtn: $('flash-btn'),
  dateBtn: $('date-btn'),
  controls: $('controls'),
  galleryBtn: $('gallery-btn'),
  galleryThumb: $('gallery-thumb'),
  galleryBadge: $('gallery-badge'),
  gallery: $('gallery'),
  galleryTitle: $('gallery-title'),
  galleryGrid: $('gallery-grid'),
  galleryEmpty: $('gallery-empty'),
  galleryClose: $('gallery-close'),
  gallerySaveAll: $('gallery-save-all'),
  viewer: $('viewer'),
  viewerStage: $('viewer-stage'),
  viewerTrack: $('viewer-track'),
  viewerSlides: [...document.querySelectorAll('#viewer-track img')],
  viewerPrev: $('viewer-prev'),
  viewerNext: $('viewer-next'),
  viewerPos: $('viewer-pos'),
  viewerCaption: $('viewer-caption'),
  viewerBack: $('viewer-back'),
  viewerDelete: $('viewer-delete'),
  viewerSave: $('viewer-save'),
  formatBtn: $('format-btn'),
  formatLabel: $('format-label'),
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
  flash: 'спалах',
};

const BRAND_SHORT = { Fujifilm: 'Fuji', Lomography: 'Lomo', CineStill: 'Cine' }; // щоб вміщалося на етикетці касети

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      flash: state.flash,
      date: state.date,
      digitalCount: state.digitalCount,
    }));
  } catch { /* приватний режим: працюємо без збереження */ }
}

const saved = readStore();
const state = {
  cameraId: CAMERAS.some((c) => c.id === saved.camera) ? saved.camera : CAMERAS[0].id,
  filmId: FILMS.some((f) => f.id === saved.film) ? saved.film : FILMS[0].id,
  aspect: saved.aspect === '1:1' ? '1:1' : '3:2',
  count: Number.isInteger(saved.count) ? Math.min(Math.max(saved.count, 0), MAX_FRAMES) : 0,
  flash: saved.flash === true,
  date: saved.date !== false, // штамп дати за замовчуванням увімкнений
  roll: [], // кадри поточної плівки (дублюються в IndexedDB): { id, n, name, blob, thumb, caption, digital, time }
  digitalCount: Number.isInteger(saved.digitalCount) ? saved.digitalCount : 0, // лічильник кадрів цифрової камери
  torch: false, // чи вміє поточна камера вмикати ліхтарик (iOS Safari не вміє)
  busy: false,
  last: null, // { blob, name }
};

const pipeline = new FilmPipeline(els.out);
const offscreen = document.createElement('canvas');
const currentCamera = () => CAMERAS.find((c) => c.id === state.cameraId);
const currentFilm = () => FILMS.find((f) => f.id === state.filmId);

// --- UI -----------------------------------------------------------------------

let toastTimer;
function toast(text, ms = 2400) {
  els.toast.textContent = text;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), ms);
}

function renderCounter() {
  const digital = currentCamera().digital;
  // на цифровій камері плівки немає: лічильник погашений, спуск не блокується
  const s = digital ? '--' : String(state.count).padStart(2, '0');
  els.wheelTens.textContent = s[0];
  els.wheelOnes.textContent = s[1];
  els.counter.classList.toggle('off', !!digital);
  els.counter.classList.toggle('end', !digital && state.count >= MAX_FRAMES);
  els.counter.setAttribute(
    'aria-label',
    digital ? 'Цифрова камера: плівка не використовується' : `Знято кадрів: ${state.count} з ${MAX_FRAMES}`,
  );
  els.shutter.setAttribute('aria-disabled', String(!digital && state.count >= MAX_FRAMES));
}

/** Плівки в списку групуються за брендами, камери йдуть списком. */
function fillCameraSelect() {
  els.cameraSelect.replaceChildren(
    ...CAMERAS.map((c) => new Option(c.name, c.id, false, c.id === state.cameraId)),
  );
}
function fillFilmSelect() {
  const groups = new Map();
  for (const f of FILMS) {
    if (!groups.has(f.brand)) groups.set(f.brand, []);
    groups.get(f.brand).push(f);
  }
  els.filmSelect.replaceChildren(
    ...[...groups].map(([brand, films]) => {
      const g = document.createElement('optgroup');
      g.label = brand;
      g.append(...films.map((f) => new Option(f.name, f.id, false, f.id === state.filmId)));
      return g;
    }),
  );
}

function renderSelection() {
  const film = currentFilm();
  const cam = currentCamera();
  els.controls.classList.toggle('digital', !!cam.digital);
  els.camInfo.textContent = `${cam.name} — ${cam.blurb}`;
  if (cam.digital) {
    els.filmInfo.textContent = `${cam.name}: цифровий сенсор, плівка не використовується`;
    return;
  }
  const [bg, fg] = film.label;
  els.canister.style.setProperty('--lbl-bg', bg);
  els.canister.style.setProperty('--lbl-fg', fg);
  els.canisterBrand.textContent = film.brand === 'Особливі' ? '' : BRAND_SHORT[film.brand] || film.brand;
  els.canisterName.textContent = film.iso === '?' || film.special === 'reel' ? film.name : `ISO ${film.iso}`;
  els.filmInfo.textContent = `${film.name} · ISO ${film.iso} — ${film.blurb}`;
  els.camInfo.textContent = `${cam.name} — ${cam.blurb}`;
}

function renderFlash() {
  els.flashBtn.setAttribute('aria-pressed', String(state.flash));
}

function renderDate() {
  els.dateBtn.setAttribute('aria-pressed', String(state.date));
}

els.dateBtn.addEventListener('click', () => {
  state.date = !state.date;
  writeStore();
  renderDate();
  toast(state.date ? 'Дата на кадрі: увімкнено' : 'Дата на кадрі: вимкнено');
});

function renderAspect() {
  els.formatLabel.textContent = state.aspect;
  updateFinder();
}

fillCameraSelect();
fillFilmSelect();
els.cameraSelect.addEventListener('change', () => {
  state.cameraId = els.cameraSelect.value;
  writeStore();
  renderSelection();
  renderCounter();
});
els.filmSelect.addEventListener('change', () => { state.filmId = els.filmSelect.value; writeStore(); renderSelection(); });

els.formatBtn.addEventListener('click', () => {
  state.aspect = state.aspect === '3:2' ? '1:1' : '3:2';
  writeStore();
  renderAspect();
});

els.flashBtn.addEventListener('click', () => {
  state.flash = !state.flash;
  writeStore();
  renderFlash();
  if (state.flash) {
    toast(
      state.torch
        ? 'Спалах увімкнено: підсвітка камери + ефект прямого світла'
        : 'Спалах імітується обробкою: браузер не керує ліхтариком цієї камери',
      3200,
    );
  } else {
    toast('Спалах вимкнено');
  }
});

els.rewind.addEventListener('click', () => {
  if (state.count === 0 && state.digitalCount === 0 && state.roll.length === 0) return toast('Плівка вже на початку');
  const message = state.roll.length
    ? `Перемотати плівку? Усі кадри в стрічці (${state.roll.length}) буде видалено назавжди. Якщо вони ще потрібні, спершу натисніть «Зберегти все».`
    : 'Перемотати плівку? Лічильник скинеться на 0.';
  if ((state.roll.length || state.count < MAX_FRAMES) && !confirm(message)) return;
  const removed = state.roll.length;
  state.count = 0;
  state.digitalCount = 0;
  writeStore();
  renderCounter();
  clearRoll();
  els.rewind.classList.add('spin');
  setTimeout(() => els.rewind.classList.remove('spin'), 500);
  toast(removed ? 'Плівку перемотано, стрічку очищено' : 'Плівку перемотано');
});

// --- камера -------------------------------------------------------------------

let stream = null;
let startToken = 0;

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
    ctx.beginPath();
    ctx.arc(w * 0.3, h * 0.5, 38, 0, Math.PI * 2);
    ctx.fillStyle = '#d9a283'; // скін-тон
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

const videoTrack = () => (stream && stream.getVideoTracks()[0]) || null;

function detectTorch() {
  const track = videoTrack();
  const caps = track && track.getCapabilities ? track.getCapabilities() : {};
  state.torch = !!caps.torch;
}

async function setTorch(on) {
  const track = videoTrack();
  if (!track) return false;
  try {
    await track.applyConstraints({ advanced: [{ torch: on }] });
    return true;
  } catch {
    return false;
  }
}

function openStream() {
  if (demoMode) return Promise.resolve(createDemoStream());
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return Promise.reject(Object.assign(new Error('mediaDevices'), { name: 'NotSupportedError' }));
  }
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false,
  });
}

async function startCamera() {
  const token = ++startToken; // новіший запуск скасовує попередній
  stopCamera();
  showMsg('Запуск камери…', false);
  try {
    const s = await openStream();
    if (token !== startToken) {
      s.getTracks().forEach((t) => t.stop());
      return;
    }
    stream = s;
    detectTorch();
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
// Потік не зупиняємо, коли сторінка ховається (листок «Поділитися», перемикання застосунків):
// новий getUserMedia змушує iOS питати дозвіл знову. Перезапуск лише якщо систему вбила потік.
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !pipeline.supported) return;
  const track = videoTrack();
  if (!track || track.readyState !== 'live') startCamera();
  else if (els.video.paused) els.video.play().catch(() => {});
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
  if (!currentCamera().digital && state.count >= MAX_FRAMES) return toast('Плівка закінчилась');
  if (!pipeline.supported) return toast('WebGL недоступний на цьому пристрої');
  if (!els.video.videoWidth) return toast('Камера ще не готова');

  state.busy = true;
  let torchOn = false;
  let torchFired = false;
  try {
    // справжній спалах: вмикаємо ліхтарик і чекаємо, поки камера підлаштує експозицію
    if (state.flash && state.torch) {
      torchOn = await setTorch(true);
      if (torchOn) await sleep(TORCH_WARMUP_MS);
      torchFired = torchOn;
    }

    clickSound();
    if (navigator.vibrate) navigator.vibrate(12);
    els.flash.classList.remove('go', 'strong');
    void els.flash.offsetWidth;
    els.flash.classList.add('go');
    if (state.flash) els.flash.classList.add('strong');

    const camera = currentCamera();
    const film = camera.digital ? camera.look : currentFilm(); // цифрова камера має власний «look» замість плівки
    const g = cropGeometry();

    offscreen.width = g.w;
    offscreen.height = g.h;
    offscreen.getContext('2d').drawImage(els.video, g.sx, g.sy, g.sw, g.sh, 0, 0, g.w, g.h);
    if (torchOn) setTorch(false);
    torchOn = false;

    const seed = newSeed();
    const frame = rollFrame(seed, { flash: state.flash, leakMul: camera.leakMul, digital: camera.digital });
    // якщо ліхтарик справді світив, імітації потрібно менше
    if (torchFired) frame.flash *= 0.5;

    const dev = developFilm(film, seed);
    const lut = await loadLut(dev.film.lut);
    // що малюється поверх кадру: перфорація й ремджет від плівки, дата від камери
    const overlay = state.date || dev.overlay
      ? { ...dev.overlay, ...(state.date ? { dateStamp: formatDateStamp(new Date()) } : null) }
      : null;
    const params = computeParams(camera, dev.film, frame, lut, overlay);
    pipeline.render(offscreen, params);
    const blob = await pipeline.toBlob('image/jpeg', 0.92);
    const thumb = await makeThumb(els.out);

    // цифрові кадри мають окремий лічильник, плівку вони не витрачають
    let n;
    if (camera.digital) n = state.digitalCount += 1;
    else n = state.count += 1;
    writeStore();
    renderCounter();

    const name = `film-${stamp(new Date())}-${String(n).padStart(2, '0')}.jpg`;
    state.last = { blob, name };
    const shot = { n, camera: camera.id, film: dev.film.id, developed: dev.info, frame, params };
    window.filmDebug = { ...window.filmDebug, last: shot, pipeline };
    console.log(`[кадр ${shot.n}] ${camera.id} + ${dev.film.id}`, frame, dev.info || '');

    const notes = frame.events.map((e) => EVENT_NAMES[e]).filter(Boolean);
    els.caption.textContent =
      (camera.digital
        ? `Кадр ${n} · ${camera.name} · цифровий сенсор, ${film.name}`
        : `Кадр ${n} з ${MAX_FRAMES} · ${camera.name} · ${film.name}`) +
      (dev.info ? ` (${dev.info.text})` : '') +
      (notes.length ? ` · ${notes.join(', ')}` : '');
    addToRoll({
      id: `${Date.now()}-${n}`,
      n,
      name,
      blob,
      thumb,
      caption: els.caption.textContent,
      digital: !!camera.digital,
      time: Date.now(),
    });
    els.print.hidden = false;
    if (!camera.digital && state.count >= MAX_FRAMES) toast('Плівка закінчилась');
  } catch (err) {
    console.error(err);
    toast('Не вдалося проявити кадр');
  } finally {
    if (torchOn) setTorch(false);
    state.busy = false;
  }
}

els.shutter.addEventListener('click', shoot);

// --- збереження ---------------------------------------------------------------

function download({ blob, name }) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Віддає кадри користувачу: листок «Поділитися» з усіма файлами, а якщо його немає, звичайні завантаження. */
async function deliver(items) {
  if (!items.length) return;
  const files = items.map((it) => new File([it.blob], it.name, { type: 'image/jpeg' }));
  if (navigator.canShare && navigator.canShare({ files })) {
    try {
      await navigator.share({ files });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      console.warn('share не вдався, завантажуємо файли:', err);
    }
  }
  for (let i = 0; i < items.length; i++) {
    download(items[i]);
    if (i < items.length - 1) await sleep(300); // браузери не люблять купу завантажень одночасно
  }
  if (items.length > 1) toast(`Завантажено файлів: ${items.length}`);
}

const saveLast = () => (state.last ? deliver([state.last]) : undefined);

els.save.addEventListener('click', saveLast);
els.close.addEventListener('click', () => { els.print.hidden = true; });

// --- стрічка фото -------------------------------------------------------------

const objectUrls = new Map(); // id → { thumb, full }
let viewing = null;

function urlsOf(id) {
  if (!objectUrls.has(id)) objectUrls.set(id, {});
  return objectUrls.get(id);
}
function thumbUrl(shot) {
  const u = urlsOf(shot.id);
  if (!u.thumb) u.thumb = URL.createObjectURL(shot.thumb || shot.blob);
  return u.thumb;
}
function forgetUrls(id) {
  const u = objectUrls.get(id);
  if (!u) return;
  if (u.thumb) URL.revokeObjectURL(u.thumb);
  if (u.full) URL.revokeObjectURL(u.full);
  objectUrls.delete(id);
}

/** Мініатюра останнього кадру з лічильником на кнопці камери. */
function renderRollButton() {
  const last = state.roll[state.roll.length - 1];
  els.galleryBtn.classList.toggle('empty', !last);
  els.galleryThumb.style.backgroundImage = last ? `url("${thumbUrl(last)}")` : '';
  els.galleryBadge.hidden = !last;
  els.galleryBadge.textContent = String(state.roll.length);
  els.galleryBtn.setAttribute('aria-label', last ? `Стрічка фото: ${state.roll.length}` : 'Стрічка фото');
}

function renderGallery() {
  const count = state.roll.length;
  els.galleryTitle.textContent = count ? `Стрічка · ${count}` : 'Стрічка';
  els.galleryEmpty.hidden = count > 0;
  els.gallerySaveAll.disabled = count === 0;
  els.galleryGrid.replaceChildren(
    ...[...state.roll].reverse().map((shot) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-label', `Кадр ${shot.n}`);
      const img = document.createElement('img');
      img.src = thumbUrl(shot);
      img.alt = '';
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = String(shot.n);
      b.append(img, num);
      b.addEventListener('click', () => openViewer(shot));
      return b;
    }),
  );
}

function addToRoll(shot) {
  state.roll.push(shot);
  saveShot(shot); // у фоні: якщо IndexedDB недоступний, кадр лишається лише в пам'яті
  renderRollButton();
  if (!els.gallery.hidden) renderGallery();
}

function clearRoll() {
  [...objectUrls.keys()].forEach(forgetUrls);
  state.roll = [];
  state.last = null;
  clearShots();
  closeViewer();
  renderRollButton();
  renderGallery();
}

async function makeThumb(canvas) {
  const k = 360 / Math.max(canvas.width, canvas.height);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(canvas.width * k));
  c.height = Math.max(1, Math.round(canvas.height * k));
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  return new Promise((resolve) => c.toBlob((b) => resolve(b), 'image/jpeg', 0.8));
}

// --- перегляд кадру зі свайпом ----------------------------------------------------
// Порядок як у сітці: найновіший перший. Свайп вліво веде до старішого кадру, вправо до новішого.

const viewOrder = () => [...state.roll].reverse();
const viewIndex = () => viewOrder().findIndex((s) => s.id === viewing.id);

function fullUrl(shot) {
  const u = urlsOf(shot.id);
  if (!u.full) u.full = URL.createObjectURL(shot.blob);
  return u.full;
}

/** Зсув стрічки слайдів: dx пікселів від центрального положення. */
function setTrack(dx, animate) {
  els.viewerTrack.classList.toggle('anim', animate);
  els.viewerTrack.style.transform = `translateX(calc(-100% + ${dx}px))`;
}

/** Слайди: новіший, поточний, старіший. Повнорозмірні адреси інших кадрів звільняємо. */
function renderViewer() {
  const order = viewOrder();
  const i = viewIndex();
  const shots = [order[i - 1], order[i], order[i + 1]];
  const keep = new Set(shots.filter(Boolean).map((s) => s.id));
  for (const [id, u] of objectUrls) {
    if (u.full && !keep.has(id)) {
      URL.revokeObjectURL(u.full);
      u.full = null;
    }
  }
  els.viewerSlides.forEach((img, k) => {
    if (shots[k]) img.src = fullUrl(shots[k]);
    else img.removeAttribute('src');
  });
  els.viewerCaption.textContent = viewing.caption || '';
  els.viewerPos.textContent = `${i + 1} / ${order.length}`;
  els.viewerPrev.hidden = i <= 0;
  els.viewerNext.hidden = i >= order.length - 1;
  setTrack(0, false);
}

function openViewer(shot) {
  viewing = shot;
  els.viewer.hidden = false;
  renderViewer();
}

function closeViewer() {
  objectUrls.forEach((u) => {
    if (u.full) {
      URL.revokeObjectURL(u.full);
      u.full = null;
    }
  });
  viewing = null;
  els.viewer.hidden = true;
  els.viewerSlides.forEach((img) => img.removeAttribute('src'));
}

let navigating = false;

/** dir = 1: до старішого кадру, -1: до новішого. Якщо далі нікуди, стрічка пружинить назад. */
function go(dir) {
  if (!viewing || navigating) return;
  const order = viewOrder();
  const j = viewIndex() + dir;
  if (j < 0 || j >= order.length) return setTrack(0, true);
  navigating = true;
  setTrack(-dir * els.viewerStage.clientWidth, true);
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(fallback);
    els.viewerTrack.removeEventListener('transitionend', finish);
    viewing = order[j];
    renderViewer();
    navigating = false;
  };
  const fallback = setTimeout(finish, 450); // якщо transitionend не спрацював
  els.viewerTrack.addEventListener('transitionend', finish);
}

let swipe = null;

els.viewerStage.addEventListener('pointerdown', (e) => {
  if (navigating || e.target.closest('.viewer-nav')) return;
  swipe = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), dx: 0, horizontal: null };
});

els.viewerStage.addEventListener('pointermove', (e) => {
  if (!swipe || e.pointerId !== swipe.id) return;
  const dx = e.clientX - swipe.x;
  const dy = e.clientY - swipe.y;
  if (swipe.horizontal === null) {
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
    swipe.horizontal = Math.abs(dx) > Math.abs(dy);
    if (swipe.horizontal) {
      try {
        els.viewerStage.setPointerCapture(e.pointerId);
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
  const width = els.viewerStage.clientWidth;
  const speed = s.dx / Math.max(1, performance.now() - s.t); // px/мс
  const far = Math.abs(s.dx) > width * 0.2;
  const flick = Math.abs(speed) > 0.5 && Math.abs(s.dx) > 30;
  if (far || flick) go(s.dx < 0 ? 1 : -1);
  else setTrack(0, true);
}
els.viewerStage.addEventListener('pointerup', endSwipe);
els.viewerStage.addEventListener('pointercancel', endSwipe);

els.viewerPrev.addEventListener('click', () => go(-1));
els.viewerNext.addEventListener('click', () => go(1));
document.addEventListener('keydown', (e) => {
  if (els.viewer.hidden) return;
  if (e.key === 'ArrowLeft') go(-1);
  else if (e.key === 'ArrowRight') go(1);
  else if (e.key === 'Escape') closeViewer();
});

els.galleryBtn.addEventListener('click', () => {
  renderGallery();
  els.gallery.hidden = false;
});
els.galleryClose.addEventListener('click', () => { els.gallery.hidden = true; });
els.gallerySaveAll.addEventListener('click', () => deliver(state.roll));
els.viewerBack.addEventListener('click', closeViewer);
els.viewerSave.addEventListener('click', () => (viewing ? deliver([viewing]) : undefined));
els.viewerDelete.addEventListener('click', () => {
  if (!viewing || navigating || !confirm('Видалити цей кадр?')) return;
  const { id, name } = viewing;
  const order = viewOrder();
  const i = viewIndex();
  const next = order[i + 1] || order[i - 1]; // після видалення показуємо сусідній кадр
  state.roll = state.roll.filter((s) => s.id !== id);
  if (state.last && state.last.name === name) state.last = null;
  forgetUrls(id);
  deleteShot(id);
  renderRollButton();
  renderGallery();
  if (next) {
    viewing = next;
    renderViewer();
  } else {
    closeViewer();
  }
});

loadShots().then((shots) => {
  if (!shots.length) return;
  state.roll = shots;
  renderRollButton();
});

// --- старт --------------------------------------------------------------------

renderCounter();
renderSelection();
renderFlash();
renderDate();
renderAspect();
if (!pipeline.supported) {
  showMsg('Цей браузер не підтримує WebGL, тож проявити кадр неможливо.', false);
} else {
  startCamera();
}
