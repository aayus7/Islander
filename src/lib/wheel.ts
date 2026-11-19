// Wheel gestures: mouse wheels and touchpads both arrive as "wheel" events, but very
// differently. A mouse sends one big step per notch. A touchpad sends dozens of tiny
// events per two-finger swipe, and keeps sending them for a second after the fingers
// lift (momentum). Everything in the island that reacts to the wheel asks this module
// what it's looking at, so one swipe acts once instead of once every few events.

export interface Gesture {
  /** Increases with every new gesture. */
  id: number;
  /** A touchpad (or a smooth high-resolution wheel), not a notched mouse wheel. */
  touchpad: boolean;
  /** Distance travelled this gesture, in CSS px. */
  sx: number;
  sy: number;
  /** This event's movement, in CSS px. */
  dx: number;
  dy: number;
  /** Something already acted on this gesture (a tab switch): don't act again. */
  used: boolean;
  /** A list scrolled during this gesture: it's a scroll, not a tab switch. */
  list: boolean;
  /** Time of the latest event (ms). */
  last: number;
  /** Smallest movement seen since `used` was set (to spot a fresh swipe during momentum). */
  low: number;
  /** When it was used (ms). */
  usedAt: number;
}

/** Silence that ends a gesture. Momentum events arrive every frame, so this is plenty. */
const GAP = 170;
/** After a swipe changes tabs, momentum can't start another swipe for this long. */
const SETTLE = 450;

let current: Gesture | null = null;
let nextId = 1;
const seen = new WeakMap<object, Gesture>();
let now = () => performance.now();

/** Tests can drive the clock. */
export function _setClock(fn: () => number) {
  now = fn;
  current = null;
}

type WheelLike = Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode"> & { wheelDeltaX?: number; wheelDeltaY?: number };

/**
 * True for events that come from a touchpad or a free-spinning/high-resolution wheel.
 * Chromium (WebView2) reports a notched mouse wheel with wheelDelta in steps of 120;
 * touchpads report the pixel movement instead, which almost never lands on 120.
 */
export function looksLikeTouchpad(ev: WheelLike): boolean {
  const e = ((ev as { nativeEvent?: WheelLike }).nativeEvent ?? ev) as WheelLike;
  if (e.deltaMode !== 0) return false; // lines/pages: a classic wheel
  if (e.deltaX !== 0 && e.deltaY !== 0) return true; // diagonal: only fingers do that
  const wd = e.wheelDeltaY || e.wheelDeltaX;
  if (wd !== undefined && wd !== 0) return wd % 120 !== 0;
  const d = Math.abs(e.deltaY) || Math.abs(e.deltaX);
  return d < 40 || !Number.isInteger(d);
}

/** The gesture this event belongs to (call as often as you like for the same event). */
export function gestureOf(e: WheelLike): Gesture {
  const key = (e as { nativeEvent?: object }).nativeEvent ?? (e as object);
  const known = seen.get(key);
  if (known) return known;
  const t = now();
  const unit = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? 300 : 1;
  const dx = e.deltaX * unit;
  const dy = e.deltaY * unit;
  const mag = Math.hypot(dx, dy);
  let g = current;
  const fresh = !g || t - g.last > GAP;
  // During momentum the movement only shrinks. If it suddenly grows again after we
  // already acted, the fingers are back on the pad: that's a new swipe.
  const reswipe = !!g && !fresh && g.touchpad && g.used && t - g.usedAt > SETTLE && g.low < 4 && mag > Math.max(12, g.low * 4);
  if (!g || fresh || reswipe) {
    g = { id: nextId++, touchpad: false, sx: 0, sy: 0, dx: 0, dy: 0, used: false, list: false, last: t, low: Infinity, usedAt: 0 };
    current = g;
  }
  if (looksLikeTouchpad(e)) g.touchpad = true;
  g.last = t;
  g.dx = dx;
  g.dy = dy;
  g.sx += dx;
  g.sy += dy;
  if (g.used) g.low = Math.min(g.low, mag);
  seen.set(key, g);
  return g;
}

/** A list scrolled with this event: the rest of the gesture belongs to scrolling. */
export function markScrolled(e: WheelLike) {
  gestureOf(e).list = true;
}

/** Touchpad: how far a swipe must travel sideways to change tabs (a deliberate swipe, not a nudge). */
export const SWIPE_PX = 110;

/**
 * Should this event change the island's tab? Returns -1, +1 or 0. Call it from every
 * place that switches tabs; it marks the gesture used so a swipe changes tabs once.
 *
 * Mouse wheel: the first notch of a spin changes tabs (either direction of the wheel).
 * Touchpad: a sideways two-finger swipe changes tabs; scrolling up and down never does,
 * so brushing the pad while reading can't flip you to another tab.
 */
export function tabStep(e: WheelLike): -1 | 0 | 1 {
  const g = gestureOf(e);
  if (g.used || g.list) return 0;
  if (g.touchpad) {
    if (Math.abs(g.sx) < SWIPE_PX || Math.abs(g.sx) < Math.abs(g.sy) * 1.4) return 0;
    g.used = true;
    g.usedAt = now();
    g.low = Infinity;
    return g.sx > 0 ? 1 : -1;
  }
  const d = Math.abs(g.dx) > Math.abs(g.dy) ? g.dx : g.dy;
  if (Math.abs(d) < 4) return 0;
  g.used = true;
  return d > 0 ? 1 : -1;
}
