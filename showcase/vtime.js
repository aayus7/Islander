// Virtual time for frame-exact capture. Installed before the app loads: timers,
// requestAnimationFrame, performance.now, Date and CSS/Web animations all follow a clock
// that only moves when the recorder calls __vt.advance(ms). Each captured frame is
// therefore exactly 1/fps later than the previous one, however slow rendering is.
(() => {
  const realSetTimeout = window.setTimeout.bind(window);
  const RealDate = Date;
  const START = +new RealDate(window.__VT_START || "2026-11-19T09:41:00");
  let now = 0;
  let seq = 0;
  const timers = new Map(); // id -> {at, fn, args, every}
  let rafs = [];

  window.setTimeout = (fn, ms = 0, ...args) => {
    const id = ++seq;
    timers.set(id, { at: now + Math.max(0, +ms || 0), fn, args, every: 0, order: id });
    return id;
  };
  window.setInterval = (fn, ms = 0, ...args) => {
    const id = ++seq;
    const every = Math.max(1, +ms || 0);
    timers.set(id, { at: now + every, fn, args, every, order: id });
    return id;
  };
  window.clearTimeout = window.clearInterval = (id) => void timers.delete(id);
  window.requestAnimationFrame = (fn) => {
    const id = ++seq;
    rafs.push({ id, fn });
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    rafs = rafs.filter((r) => r.id !== id);
  };
  performance.now = () => now;
  function VDate(...a) {
    if (!new.target) return new RealDate(START + now).toString();
    return a.length ? new RealDate(...a) : new RealDate(START + now);
  }
  VDate.prototype = RealDate.prototype;
  VDate.now = () => START + now;
  VDate.parse = RealDate.parse;
  VDate.UTC = RealDate.UTC;
  window.Date = VDate;

  const born = new WeakMap();
  function syncAnimations() {
    for (const a of document.getAnimations()) {
      if (a.timeline !== document.timeline) continue; // scroll-driven: leave alone
      if (!born.has(a)) {
        born.set(a, now - (a.currentTime || 0) / (a.playbackRate || 1));
        if (a.playState === "running") a.pause();
      }
      if (a.playState === "finished") continue;
      const local = (now - born.get(a)) * (a.playbackRate || 1);
      const end = a.effect ? a.effect.getComputedTiming().endTime : Infinity;
      if (Number.isFinite(end) && local >= end) {
        try { a.finish(); } catch { /* infinite */ }
      } else {
        if (a.playState === "running") a.pause();
        a.currentTime = Math.max(0, local);
      }
    }
  }

  function runTimersUntil(t) {
    for (;;) {
      let next = null;
      for (const [id, tm] of timers) if (tm.at <= t && (!next || tm.at < next[1].at || (tm.at === next[1].at && tm.order < next[1].order))) next = [id, tm];
      if (!next) break;
      const [id, tm] = next;
      now = Math.max(now, tm.at);
      if (tm.every) { tm.at += tm.every; tm.order = ++seq; } else timers.delete(id);
      try { typeof tm.fn === "function" ? tm.fn(...tm.args) : (0, eval)(tm.fn); } catch (e) { console.error(e); }
    }
  }

  const flush = () => new Promise((r) => realSetTimeout(r, 0));
  // <video> runs on the real clock: hold each one and seek it to virtual time every frame.
  const vborn = new WeakMap();
  async function syncVideos() {
    const waits = [];
    for (const v of document.querySelectorAll("video")) {
      if (!vborn.has(v)) {
        vborn.set(v, now);
        v.pause();
        v.addEventListener("play", () => v.pause());
      }
      if (!(v.duration > 0)) continue;
      let t = (now - vborn.get(v)) / 1000;
      t = v.loop ? t % v.duration : Math.min(t, v.duration - 0.001);
      if (Math.abs(v.currentTime - t) < 0.001) continue;
      waits.push(new Promise((r) => {
        const done = () => r();
        v.addEventListener("seeked", done, { once: true });
        realSetTimeout(done, 300);
      }));
      v.currentTime = t;
      if (!v.loop && t >= v.duration - 0.002) v.dispatchEvent(new Event("ended"));
    }
    await Promise.all(waits);
  }
  window.__vt = {
    now: () => now,
    async advance(ms) {
      const target = now + ms;
      runTimersUntil(target);
      now = target;
      await flush(); // let React (MessageChannel) commit what the timers scheduled
      const batch = rafs;
      rafs = [];
      for (const r of batch) {
        try { r.fn(now); } catch (e) { console.error(e); }
      }
      await flush();
      syncAnimations();
      await syncVideos();
      return now;
    },
  };
})();
