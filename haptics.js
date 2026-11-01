// Механічний відгук: вібрація й клацання.
//
// Android (Chrome): navigator.vibrate. iOS Safari цього API не має. Там працює обхідний шлях: від iOS 17.4
// перемикач <input type="checkbox" switch> дає легкий хаптик, коли його перемкнути з жесту користувача.
// Це неофіційний трюк, тож на iPhone відгук не гарантований (залежить від версії системи й того, чи подія
// сталась усередині жесту). Звук працює скрізь.

const PATTERNS = { tick: 6, click: 14, heavy: [28, 22, 36] };

let iosSwitch = null;
function iosHaptic() {
  if (!iosSwitch) {
    const label = document.createElement('label');
    label.setAttribute('aria-hidden', 'true');
    label.style.cssText = 'position:fixed;left:-100px;top:-100px;width:1px;height:1px;opacity:0;pointer-events:none';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    label.append(input);
    document.body.append(label);
    iosSwitch = label;
  }
  iosSwitch.click();
}

/** kind: 'tick' (крок барабана), 'click' (початок руху), 'heavy' (механізм дійшов до кінця). */
export function haptic(kind = 'tick') {
  const pattern = PATTERNS[kind] ?? PATTERNS.tick;
  try {
    if (navigator.vibrate && navigator.vibrate(pattern)) return;
  } catch { /* продовжуємо обхідним шляхом */ }
  try {
    iosHaptic();
    if (kind === 'heavy') {
      setTimeout(iosHaptic, 60);
      setTimeout(iosHaptic, 130);
    }
  } catch { /* без хаптика */ }
}

let audio = null;

/** Коротке механічне клацання: 'tick' (барабан), 'ratchet' (храповик важеля), 'thunk' (кінець ходу). */
export function tickSound(kind = 'tick') {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = audio;
    if (ctx.state === 'suspended') ctx.resume();
    const spec = {
      tick: { ms: 7, freq: 3400, type: 'highpass', gain: 0.18 },
      ratchet: { ms: 10, freq: 2300, type: 'bandpass', gain: 0.26 },
      thunk: { ms: 70, freq: 260, type: 'lowpass', gain: 0.55 },
    }[kind] || { ms: 7, freq: 3000, type: 'highpass', gain: 0.18 };
    const len = Math.max(1, Math.floor((ctx.sampleRate * spec.ms) / 1000));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = spec.type;
    filter.frequency.value = spec.freq;
    const gain = ctx.createGain();
    gain.gain.value = spec.gain;
    src.connect(filter).connect(gain).connect(ctx.destination);
    src.start();
  } catch { /* без звуку */ }
}
