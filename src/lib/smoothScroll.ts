// Smooth, eased mouse-wheel scrolling for every scrollable list in the island
// (Clipboard, Shelf, Wi-Fi, Weather, AI answers…), like macOS/iOS instead of
// Windows' jumpy 100-px steps. Vertical wheels also glide horizontal strips.
// Trackpads (small, fine-grained deltas) are left to the browser — they're
// already smooth and adding easing would only make them feel laggy.

interface Anim {
  x: number;
  y: number;
  raf: number;
  last: number;
}
const anims = new WeakMap<HTMLElement, Anim>();

function scrollable(el: HTMLElement, axis: "x" | "y"): boolean {
  const cs = getComputedStyle(el);
  return axis === "y"
    ? /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1
    : /(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1;
}

function glide(el: HTMLElement, dx: number, dy: number) {
  let a = anims.get(el);
  if (!a) {
    a = { x: el.scrollLeft, y: el.scrollTop, raf: 0, last: 0 };
    anims.set(el, a);
  }
  if (!a.raf) {
    // Start from where the list really is (it may have been dragged or jumped).
    a.x = el.scrollLeft;
    a.y = el.scrollTop;
  }
  a.x = Math.max(0, Math.min(el.scrollWidth - el.clientWidth, a.x + dx));
  a.y = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, a.y + dy));
  if (a.raf) return;
  a.last = performance.now();
  const step = (now: number) => {
    const anim = a!;
    const dt = Math.min(0.05, (now - anim.last) / 1000);
    anim.last = now;
    const k = 1 - Math.exp(-dt * 13); // ease-out, ~150 ms to settle
    const nx = el.scrollLeft + (anim.x - el.scrollLeft) * k;
    const ny = el.scrollTop + (anim.y - el.scrollTop) * k;
    el.scrollLeft = nx;
    el.scrollTop = ny;
    if (Math.abs(anim.x - nx) < 0.5 && Math.abs(anim.y - ny) < 0.5) {
      el.scrollLeft = anim.x;
      el.scrollTop = anim.y;
      anim.raf = 0;
      return;
    }
    anim.raf = requestAnimationFrame(step);
  };
  a.raf = requestAnimationFrame(step);
}

/** Is a smooth scroll still running for this element? (Used to keep tab switching out of the way.) */
export function isGliding(el: HTMLElement): boolean {
  return !!anims.get(el)?.raf;
}

/**
 * Pages can reserve a strip at their top where the wheel changes tabs instead of
 * scrolling (Weather's big temperature): set `data-tab-zone="<px>"` on the page.
 */
export function inTabZone(target: EventTarget | null, clientY: number): boolean {
  const el = (target as HTMLElement | null)?.closest?.("[data-tab-zone]") as HTMLElement | null;
  if (!el) return false;
  const px = Number(el.dataset.tabZone) || 0;
  return clientY < el.getBoundingClientRect().top + px;
}

export function installSmoothScroll(root: Window = window) {
  const onWheel = (e: WheelEvent) => {
    // Ctrl = zoom; Shift = "change tabs" in the island.
    if (e.ctrlKey || e.shiftKey || e.defaultPrevented) return;
    // The tab dock never scrolls anything.
    if ((e.target as HTMLElement)?.closest?.(".dock-wrap")) return;
    if (inTabZone(e.target, e.clientY)) {
      e.preventDefault(); // no native scroll either: this wheel is for tabs
      (e as WheelEvent & { islandTabZone?: boolean }).islandTabZone = true;
      return;
    }
    const unit = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? 300 : 1;
    let dx = e.deltaX * unit;
    let dy = e.deltaY * unit;
    // Trackpad: fine-grained deltas — leave it native.
    const coarse = e.deltaMode !== 0 || Math.abs(dy) >= 50 || Math.abs(dx) >= 50;
    if (!coarse) return;
    const vertical = Math.abs(dy) >= Math.abs(dx);
    // A vertical wheel over a horizontal strip (hourly forecast) inside a vertical
    // page scrolls the page; the strip only takes it when nothing above scrolls.
    let fallbackX: HTMLElement | null = null;
    let el = e.target as HTMLElement | null;
    while (el && el !== document.body) {
      if (vertical && scrollable(el, "y")) {
        const room = dy > 0 ? el.scrollHeight - el.clientHeight - el.scrollTop : el.scrollTop;
        const a = anims.get(el);
        const pending = a?.raf ? a.y - el.scrollTop : 0;
        const left = dy > 0 ? room - pending : room + pending;
        if (left > 1) {
          e.preventDefault();
          glide(el, 0, dy);
          return;
        }
      }
      if (scrollable(el, "x")) {
        const d = vertical ? dy : dx;
        const room = d > 0 ? el.scrollWidth - el.clientWidth - el.scrollLeft : el.scrollLeft;
        if (room > 1) {
          if (!vertical) {
            e.preventDefault();
            glide(el, dx, 0);
            return;
          }
          fallbackX ??= el;
        }
      }
      el = el.parentElement;
    }
    if (fallbackX) {
      e.preventDefault();
      glide(fallbackX, dy, 0);
    }
  };
  root.addEventListener("wheel", onWheel, { passive: false, capture: true });
  return () => root.removeEventListener("wheel", onWheel, { capture: true });
}
