// Sound (WebAudio synth, no files), haptics (best effort) and screen flash.
//
// Haptics on iPhone: iOS Safari has no Vibration API (navigator.vibrate is undefined).
// Safari 17.4+ plays a system haptic when an <input type="checkbox" switch> is toggled,
// and clicking its label from script used to trigger that too. According to the
// ios-haptics project this was patched in iOS 26.5, so on current iOS it may do nothing.
// We therefore always pair it with sound + a visual flash. Android uses navigator.vibrate.

export type Cue = 'enterLong' | 'enterShort' | 'win' | 'loss' | 'liquidation' | 'denied';

let ctx: AudioContext | null = null;

/** Must be called from a user gesture once (iOS unlocks audio only then). */
export function unlockAudio(): void {
  try {
    if (!ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    ctx = null;
  }
}

function tone(freq: number, start: number, dur: number, type: OscillatorType, gain: number, slideTo?: number): void {
  if (!ctx) return;
  const t = ctx.currentTime + start;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise(start: number, dur: number, gain: number): void {
  if (!ctx) return;
  const len = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = 900;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(f).connect(g).connect(ctx.destination);
  src.start(ctx.currentTime + start);
}

export function playSound(cue: Cue): void {
  if (!ctx || ctx.state !== 'running') return;
  switch (cue) {
    case 'enterLong':
      tone(520, 0, 0.09, 'triangle', 0.25, 780);
      break;
    case 'enterShort':
      tone(520, 0, 0.09, 'triangle', 0.25, 340);
      break;
    case 'win':
      [660, 880, 1320].forEach((f, i) => tone(f, i * 0.07, 0.16, 'triangle', 0.22));
      break;
    case 'loss':
      tone(330, 0, 0.18, 'sawtooth', 0.09, 250);
      tone(250, 0.16, 0.28, 'sawtooth', 0.09, 160);
      break;
    case 'liquidation':
      noise(0, 0.6, 0.6);
      tone(180, 0, 0.7, 'sawtooth', 0.16, 40);
      tone(90, 0.05, 0.8, 'square', 0.08, 30);
      break;
    case 'denied':
      tone(200, 0, 0.08, 'square', 0.08);
      tone(200, 0.11, 0.08, 'square', 0.08);
      break;
  }
}

const PATTERNS: Record<Cue, number[]> = {
  enterLong: [12],
  enterShort: [12],
  win: [15, 60, 15],
  loss: [40],
  liquidation: [80, 50, 80, 50, 160],
  denied: [20, 40, 20],
};

function switchTick(): void {
  try {
    const label = document.createElement('label');
    label.ariaHidden = 'true';
    label.style.display = 'none';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    label.appendChild(input);
    document.head.appendChild(label);
    label.click();
    label.remove();
  } catch {
    /* not supported: sound + flash cover it */
  }
}

export const hasVibration = (): boolean => typeof navigator.vibrate === 'function';

export function haptic(cue: Cue): void {
  if (hasVibration()) {
    navigator.vibrate(PATTERNS[cue]);
    return;
  }
  // iOS best effort: one tick per pulse in the pattern
  const pulses = Math.ceil(PATTERNS[cue].length / 2);
  for (let i = 0; i < pulses; i++) setTimeout(switchTick, i * 110);
}

/** Short full-screen flash; also the visible stand-in for haptics. */
export function flash(kind: 'up' | 'down' | 'neutral' | 'liq'): void {
  const el = document.getElementById('flash');
  if (!el) return;
  el.className = '';
  void el.offsetWidth; // restart animation
  el.className = `flash-${kind}`;
}
