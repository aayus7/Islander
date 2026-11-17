// Islander Media Bridge — content script.
// Reads the real <video>/<audio> element on the page (exact time, length, play state)
// plus the page's media metadata, and reports it to the extension's background script.
// Also carries out play/pause/seek/next/prev commands coming back from the island.
(() => {
  if (window.__islandBridge) return;
  window.__islandBridge = true;

  const api = globalThis.browser ?? globalThis.chrome;
  const host = location.hostname.replace(/^www\./, "");

  const SITE_NAMES = {
    "music.youtube.com": "YouTube Music",
    "youtube.com": "YouTube",
    "youtube-nocookie.com": "YouTube",
    "twitch.tv": "Twitch",
    "kick.com": "Kick",
    "netflix.com": "Netflix",
    "primevideo.com": "Prime Video",
    "disneyplus.com": "Disney+",
    "max.com": "Max",
    "hulu.com": "Hulu",
    "crunchyroll.com": "Crunchyroll",
    "soundcloud.com": "SoundCloud",
    "open.spotify.com": "Spotify",
    "music.apple.com": "Apple Music",
    "deezer.com": "Deezer",
    "tidal.com": "TIDAL",
    "bandcamp.com": "Bandcamp",
    "vimeo.com": "Vimeo",
    "reddit.com": "Reddit",
    "x.com": "X",
    "twitter.com": "X",
    "tiktok.com": "TikTok",
    "instagram.com": "Instagram",
    "facebook.com": "Facebook",
  };
  const siteName = (() => {
    for (const [domain, name] of Object.entries(SITE_NAMES)) {
      if (host === domain || host.endsWith("." + domain)) return name;
    }
    const parts = host.split(".");
    const base = parts.length > 1 ? parts[parts.length - 2] : host;
    return base ? base[0].toUpperCase() + base.slice(1) : "Browser";
  })();
  const isYouTube = /(^|\.)youtube(-nocookie)?\.com$/.test(host);

  /* ---------- finding the player ---------- */

  let current = null; // the element we report
  let lastPlayed = null; // most recent element that started playing with sound

  const audibleEl = (e) => !e.muted && e.volume > 0;
  const area = (e) => (e.tagName === "VIDEO" ? e.clientWidth * e.clientHeight : 1);

  function allMedia() {
    const out = [...document.querySelectorAll("video, audio")];
    if (out.length) return out;
    // Some sites (e.g. Reddit) put the player inside shadow DOM.
    const walk = (root, depth) => {
      if (depth > 6) return;
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) {
          out.push(...el.shadowRoot.querySelectorAll("video, audio"));
          walk(el.shadowRoot, depth + 1);
        }
      }
    };
    walk(document, 0);
    return out;
  }

  function pick() {
    const els = allMedia();
    // 1. playing with sound (biggest wins — main video over little previews)
    const loud = els.filter((e) => !e.paused && !e.ended && audibleEl(e));
    if (loud.length) return (lastPlayed = loud.sort((a, b) => area(b) - area(a))[0]);
    // 2. the last thing that played with sound (so pausing keeps it on the island)
    if (lastPlayed && lastPlayed.isConnected) return lastPlayed;
    // 3. a paused player that has been started before (e.g. a tab you paused earlier)
    const resumable = els.filter((e) => e.paused && e.currentTime > 0 && !e.ended && audibleEl(e) && (e.duration || 0) > 1);
    if (resumable.length) return resumable.sort((a, b) => area(b) - area(a))[0];
    // Silent autoplay previews (hover previews, muted feeds) are ignored.
    return null;
  }

  /* ---------- metadata ---------- */

  function cleanTitle(t) {
    return (t || "")
      .replace(/^\(\d+\+?\)\s*/, "") // "(3) " notification counts
      .replace(/\s*[-–|]\s*(YouTube|YouTube Music|Twitch|SoundCloud|Netflix|Vimeo)\s*$/i, "")
      .trim();
  }

  function biggestArtwork(list) {
    let best = "", bestSize = -1;
    for (const a of list || []) {
      const size = Math.max(0, ...String(a.sizes || "").split(/\s+/).map((s) => parseInt(s, 10) || 0));
      if (a.src && size >= bestSize) {
        best = a.src;
        bestSize = size;
      }
    }
    return best;
  }

  function youTubeId() {
    try {
      const u = new URL(location.href);
      if (u.searchParams.get("v")) return u.searchParams.get("v");
      const m = u.pathname.match(/\/(?:shorts|embed|live)\/([\w-]{6,})/);
      return m ? m[1] : "";
    } catch {
      return "";
    }
  }

  function meta(el) {
    let title = "", artist = "", album = "", art = "", artFallback = "";
    try {
      const md = navigator.mediaSession && navigator.mediaSession.metadata;
      if (md) {
        title = md.title || "";
        artist = md.artist || "";
        album = md.album || "";
        art = biggestArtwork(md.artwork);
      }
    } catch {}

    if (isYouTube) {
      if (!title) title = document.querySelector("ytd-watch-metadata h1, h1.ytd-watch-metadata")?.textContent?.trim() || "";
      if (!artist) artist = document.querySelector("ytd-watch-metadata ytd-channel-name a, #owner #channel-name a")?.textContent?.trim() || "";
      // Highest-res YouTube thumbnail, no letterbox bars (falls back if a video has none).
      const id = youTubeId();
      if (id) {
        art = `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;
        artFallback = `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
      }
      if (document.querySelector("#movie_player.ad-showing")) {
        title = "Advertisement";
        artist = siteName;
      }
    }

    if (!title) title = cleanTitle(document.title);
    if (!art) art = document.querySelector('meta[property="og:image"], meta[name="twitter:image"]')?.content || "";
    if (!art && el.tagName === "VIDEO" && el.poster) art = el.poster;
    if (art) {
      try {
        art = new URL(art, location.href).href;
      } catch {}
    }
    return { title, artist, album, art, artFallback };
  }

  function favicon() {
    const links = [...document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="shortcut icon"]')];
    // Prefer the biggest declared icon (sharpest in a round badge).
    let best = "", bestSize = -1;
    for (const l of links) {
      const size = Math.max(0, ...String(l.getAttribute("sizes") || "").split(/\s+/).map((s) => parseInt(s, 10) || 0));
      const score = l.rel.includes("apple-touch-icon") ? 180 : size;
      if (l.href && score >= bestSize) {
        best = l.href;
        bestSize = score;
      }
    }
    return best || `${location.origin}/favicon.ico`;
  }

  /* ---------- transport buttons for sites that have them ---------- */

  const visible = (b) => b && b.offsetParent !== null && b.getAttribute("aria-disabled") !== "true" && !b.disabled;
  const NEXT = [".ytp-next-button", "ytmusic-player-bar .next-button", ".skipControl__next", '[data-testid="control-button-skip-forward"]'];
  const PREV = ["ytmusic-player-bar .previous-button", ".skipControl__previous", '[data-testid="control-button-skip-back"]'];
  const findBtn = (sels) => sels.map((s) => document.querySelector(s)).find(visible) || null;

  /* ---------- reporting ---------- */

  /** Live streams: infinite duration, or the site's own live indicators (YouTube, Twitch). */
  const shown = (n) => {
    if (!n) return false;
    const cs = getComputedStyle(n);
    return cs.display !== "none" && cs.visibility !== "hidden";
  };
  function isLive(el) {
    if (el.duration === Infinity) return true;
    const host = location.hostname;
    if (host.endsWith("youtube.com")) {
      const p = el.closest(".html5-video-player") || document.querySelector(".html5-video-player");
      if (p) {
        // The time display switches to "LIVE" mode, and the red LIVE badge appears
        // (it's marked [disabled] when you're *at* the live edge, so don't exclude that).
        if (p.querySelector(".ytp-time-display.ytp-live")) return true;
        if (shown(p.querySelector(".ytp-live-badge"))) return true;
        if (p.classList.contains("ytp-live")) return true;
      }
      // Watch-page microformat: live now = a live broadcast without an end date.
      const lb = document.querySelector('meta[itemprop="isLiveBroadcast"]');
      if (lb && /true/i.test(lb.content) && !document.querySelector('meta[itemprop="endDate"]') && location.pathname.startsWith("/watch")) return true;
    }
    if (host.endsWith("twitch.tv") && document.querySelector('.live-indicator-container, [data-a-target="player-state-live"], .tw-channel-status-text-indicator')) return true;
    return false;
  }

  function snapshot() {
    const el = (current = pick());
    if (!el) return null;
    const m = meta(el);
    const live = isLive(el);
    const duration = !live && Number.isFinite(el.duration) ? el.duration : 0;
    return {
      live,
      title: m.title,
      artist: m.artist,
      album: m.album,
      artworkUrl: m.art,
      artworkFallback: m.artFallback,
      iconUrl: favicon(),
      siteName,
      playing: !el.paused && !el.ended,
      position: el.currentTime || 0,
      duration,
      rate: el.playbackRate || 1,
      sampledAt: Date.now(),
      canSeek: duration > 0 && el.seekable && el.seekable.length > 0,
      canNext: !!findBtn(NEXT),
      canPrev: true,
    };
  }

  let lastSig = "";
  let lastSent = 0;
  let dead = false;

  function report(force) {
    if (dead) return;
    const s = snapshot();
    // Position isn't part of the signature: the island extrapolates it. We resend
    // on seeks and every few seconds while playing to correct any drift.
    const sig = s ? JSON.stringify({ ...s, position: 0, sampledAt: 0 }) : "none";
    if (!force && sig === lastSig) return;
    lastSig = sig;
    lastSent = Date.now();
    try {
      const p = api.runtime.sendMessage({ type: "media", state: s });
      if (p && p.catch) p.catch(() => {});
    } catch {
      dead = true; // extension was reloaded/removed; this page's copy is orphaned
    }
  }

  let pending = 0;
  const reportSoon = (force) => {
    clearTimeout(pending);
    pending = setTimeout(() => report(force), 60);
  };

  const EVENTS = ["play", "playing", "pause", "ended", "seeked", "ratechange", "durationchange", "loadedmetadata", "emptied", "volumechange"];
  for (const t of EVENTS) {
    document.addEventListener(
      t,
      (e) => {
        const el = e.target;
        if (!(el instanceof HTMLMediaElement)) return;
        if ((t === "play" || t === "playing") && audibleEl(el)) lastPlayed = el;
        if (t === "volumechange" && !el.paused && audibleEl(el)) lastPlayed = el;
        reportSoon(t === "seeked" || t === "play" || t === "pause" || t === "ratechange");
      },
      true,
    );
  }

  // Safety net: metadata changes (SPA navigation), shadow-DOM players, and drift.
  setInterval(() => {
    const playing = current && !current.paused;
    report(playing && Date.now() - lastSent > 5000);
  }, 1000);

  addEventListener("pagehide", () => {
    try {
      api.runtime.sendMessage({ type: "media", state: null });
    } catch {}
  });

  /* ---------- commands from the island ---------- */

  api.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "cmd") return;
    const el = current || pick();
    if (!el) return;
    switch (msg.action) {
      case "toggle":
        if (el.paused) el.play().catch(() => {});
        else el.pause();
        break;
      case "seek":
        if (typeof msg.value === "number" && Number.isFinite(el.duration)) el.currentTime = Math.max(0, Math.min(msg.value, el.duration));
        break;
      case "next": {
        const b = findBtn(NEXT);
        if (b) b.click();
        break;
      }
      case "prev": {
        const b = findBtn(PREV);
        if (el.currentTime > 3 || !b) el.currentTime = 0;
        else b.click();
        break;
      }
    }
    setTimeout(() => report(true), 150);
  });

  report(true);
})();
