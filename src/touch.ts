// Gesture handling for the trade zone.
// One finger down = hold (top half long, bottom half short), lift = close.
// A second finger within PINCH_GRACE_MS of the first turns the gesture into a pinch
// (the just-opened trade is voided). Any other extra finger is ignored.

import type { Side } from './trading';

export const PINCH_GRACE_MS = 180;

export interface GestureHandlers {
  /** Returns false when no trade could be opened (e.g. offline). */
  holdStart: (side: Side) => boolean;
  holdEnd: () => void;
  holdVoid: () => void;
  pinchStart: () => void;
  pinch: (scale: number) => void;
  pinchEnd: (scale: number) => void;
  /** A short touch that did not open a trade and did not move (grid mode). */
  tap?: (x: number, y: number) => void;
}

const TAP_SLOP_PX = 12;

type Mode = 'idle' | 'hold' | 'blocked' | 'pinch' | 'drain';

export class Gestures {
  private pts = new Map<number, { x: number; y: number }>();
  private mode: Mode = 'idle';
  private primary = -1;
  private holdAt = 0;
  private pinchIds: [number, number] = [-1, -1];
  private startDist = 1;
  private scale = 1;
  private downAt = { x: 0, y: 0 };
  private moved = false;

  constructor(
    private readonly zone: HTMLElement,
    private readonly h: GestureHandlers,
  ) {
    zone.addEventListener('pointerdown', this.down, { passive: false });
    zone.addEventListener('pointermove', this.move, { passive: false });
    zone.addEventListener('pointerup', this.up);
    zone.addEventListener('pointercancel', this.up);
    // touchstart preventDefault suppresses iOS callout, magnifier, text selection and double-tap zoom
    zone.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    zone.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  }

  /** Side for a viewport y coordinate: above the visible midline = long. */
  sideAt(y: number): Side {
    const mid = this.zone.querySelector('.midline')?.getBoundingClientRect();
    const r = this.zone.getBoundingClientRect();
    const split = mid ? mid.top : r.top + r.height / 2;
    return y < split ? 'long' : 'short';
  }

  get holding(): boolean {
    return this.mode === 'hold';
  }

  /** External close (liquidation, disconnect): ignore the rest of this touch. */
  release(): void {
    if (this.mode === 'hold') this.mode = this.pts.size ? 'drain' : 'idle';
  }

  private dist(): number {
    const a = this.pts.get(this.pinchIds[0]);
    const b = this.pts.get(this.pinchIds[1]);
    if (!a || !b) return this.startDist;
    return Math.hypot(a.x - b.x, a.y - b.y) || 1;
  }

  private down = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    this.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try {
      this.zone.setPointerCapture(e.pointerId);
    } catch {
      /* not capturable */
    }

    if (this.pts.size === 1 && this.mode === 'idle') {
      this.primary = e.pointerId;
      this.holdAt = performance.now();
      this.downAt = { x: e.clientX, y: e.clientY };
      this.moved = false;
      this.mode = this.h.holdStart(this.sideAt(e.clientY)) ? 'hold' : 'blocked';
      return;
    }
    const early = performance.now() - this.holdAt < PINCH_GRACE_MS;
    if (this.pts.size === 2 && early && (this.mode === 'hold' || this.mode === 'blocked')) {
      if (this.mode === 'hold') this.h.holdVoid();
      this.mode = 'pinch';
      this.pinchIds = [this.primary, e.pointerId];
      this.startDist = this.dist();
      this.scale = 1;
      this.h.pinchStart();
    }
    // otherwise: extra finger, ignored
  };

  private move = (e: PointerEvent): void => {
    const p = this.pts.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;
    if (e.pointerId === this.primary && Math.hypot(p.x - this.downAt.x, p.y - this.downAt.y) > TAP_SLOP_PX) {
      this.moved = true;
    }
    if (this.mode === 'pinch' && this.pinchIds.includes(e.pointerId)) {
      this.scale = this.dist() / this.startDist;
      this.h.pinch(this.scale);
    }
  };

  private up = (e: PointerEvent): void => {
    if (!this.pts.has(e.pointerId)) return;
    this.pts.delete(e.pointerId);
    if (this.mode === 'hold' && e.pointerId === this.primary) {
      this.mode = 'drain';
      this.h.holdEnd();
    } else if (this.mode === 'pinch' && this.pinchIds.includes(e.pointerId)) {
      this.mode = 'drain';
      this.h.pinchEnd(this.scale);
    } else if (this.mode === 'blocked' && e.pointerId === this.primary) {
      this.mode = 'drain';
      if (!this.moved && this.pts.size === 0) this.h.tap?.(e.clientX, e.clientY);
    }
    if (this.pts.size === 0) this.mode = 'idle';
  };
}

/** Block page-level zoom, double-tap zoom, context menus and rubber-band scrolling. */
export function lockPageGestures(): void {
  const stop = (e: Event) => e.preventDefault();
  for (const ev of ['gesturestart', 'gesturechange', 'gestureend', 'dblclick', 'contextmenu', 'selectstart']) {
    document.addEventListener(ev, stop, { passive: false });
  }
  document.addEventListener(
    'touchmove',
    (e) => {
      const t = e.target as Element | null;
      if (!t?.closest('.scroll')) e.preventDefault();
    },
    { passive: false },
  );
}
