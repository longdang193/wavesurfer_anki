// _player.js (optimized; same behavior & public API)
// Fixes kept: robust URL cleaning, mobile gesture-safe playback, precise seeking,
// safe skipping, and boundary-cross fix for -3s/backward jumps.

import WaveSurfer from "./_7.10.1_wavesurfer.esm.min.js";
import RegionsPlugin from "./_7.10.1-regions.esm.min.js";

/* ------------------------------ Utilities ------------------------------ */

const $ = (id) => document.getElementById(id);

const rafThrottle = (fn) => {
  let rafId = 0;
  return (...args) => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => { rafId = 0; fn(...args); });
  };
};

const norm = (v) => (v == null ? "" : String(v).trim());

const parseTime = (raw) => {
  const s = norm(raw).toLowerCase();
  if (!s) return NaN;
  if (s.endsWith("s")) return parseFloat(s.slice(0, -1));
  if (s.includes(":")) {
    const p = s.split(":").map(Number);
    if (p.length === 2) return p[0] * 60 + p[1];
    if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  }
  return parseFloat(s);
};

const parsePauseMarks = (raw) => {
  const s = norm(raw);
  if (!s) return [];
  const out = [];
  const re = /(\d+(?:\.\d+)?)\s*s?/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    const v = parseFloat(m[1]);
    if (!Number.isNaN(v)) out.push(v);
  }
  return [...new Set(out)].filter((v) => v >= 0).sort((a, b) => a - b);
};

const nowMs = () => (performance?.now?.() ?? Date.now());

/* ------------------------------ Environment ------------------------------ */

const isAndroid = /Android/i.test(navigator.userAgent);
const isMobile  = matchMedia("(pointer:coarse)").matches;
const isNarrow  = matchMedia("(max-width: 768px)").matches;

/* ------------------------------ URL cleaning ------------------------------ */

const cleanAudioUrl = (raw) =>
  norm(raw)
    .replace(/^\[sound:/i, "")
    .replace(/\]$/, "")
    .replace(/^['"]|['"]$/g, "")
    .trim();

const isLikelyAudio = (url) => /\.(mp3|m4a|aac|wav|ogg|oga|flac|webm)$/i.test(url);

/* ------------------------------ Main ------------------------------ */

export default function initPlayer(userCfg = {}) {
  // Inputs (Anki substitutes in the card template)
  const audioUrlRaw = norm(userCfg.wave);
  if (!audioUrlRaw) { console.warn("[player] Missing {{wave}} value"); return; }

  const audioUrl = cleanAudioUrl(audioUrlRaw);
  if (!audioUrl)  { console.error("[player] Cleaned audio URL is empty. Raw:", audioUrlRaw); return; }
  if (!isLikelyAudio(audioUrl)) { console.warn("[player] URL may not be audio:", audioUrl); }

  const start01 = parseTime(userCfg.start01);
  const end01   = parseTime(userCfg.end01);
  const start02 = parseTime(userCfg.start02);

  const timeStart  = Number.isNaN(start01) ? 0 : start01;
  const timeEndRaw = !Number.isNaN(end01) ? end01 : (!Number.isNaN(start02) ? start02 : null);

  const pauseMarksRequested = parsePauseMarks(userCfg.pauseMarks);
  const ENABLE_PAUSE_MARKS = pauseMarksRequested.length > 0;

  // DOM
  const wfContainer     = $("waveform");
  const timestampEl     = $("timestamp");
  const playPauseBtn    = $("playPauseButton");
  const prevMarkBtn     = $("prevMarkButton");
  const stopBtn         = $("stopButton");
  const skipBackwardBtn = $("skipBackwardButton");
  const resetRegionBtn  = $("resetRegionButton");
  if (!wfContainer) { console.warn("[player] #waveform not found"); return; }

  // Tunables
  const CLICK_GRACE_SEC     = 0.03;   // forward grace after user taps
  const DESKTOP_SUPPRESS_MS = 140;    // pause-scheduler suppression after tap
  const MOBILE_SUPPRESS_MS  = 220;
  const EPS_END             = 0.02;   // park 20ms before region end
  const MOBILE_EPS          = 0.06;   // timeupdate tolerance on mobile
  const NUDGE_BEFORE        = 0.006;  // land just before a boundary
  const CATCH_EPS           = 0.025;  // consider "at boundary" within 25ms

  // State
  const S = {
    ws: null, regions: null, region: null, duration: 0,
    rate: 1,
    pixelRatio: Math.min((window.devicePixelRatio || 1), (isNarrow ? 1 : 1.5)),
    pauseMarks: [], nextPauseIdx: 0,
    timer: null, parkedAtEnd: false, isResetting: false,

    userSeeking: false,
    suppressPausesUntil: 0,
    wantAutoPlayOnClick: false,
  };

  /* ------------------------------ Small helpers ------------------------------ */

  const clearTimer = () => { if (S.timer) { clearTimeout(S.timer); S.timer = null; } };

  const regionEnd = () => (S.region?.end ?? S.duration);

  const safeRegionEnd = (dur) =>
    (timeEndRaw !== null && timeEndRaw < dur) ? timeEndRaw : dur;

  const playSafe = (ws) => {
    const p = ws.play?.();
    if (p && p.catch) p.catch(() => {});
  };

  // Prefer direct currentTime on mobile; fall back to WS APIs
  const setPlayhead = (t) => {
    const ws = S.ws; if (!ws) return;
    const media = ws.getMediaElement?.();

    if (media && isMobile) {
      try { media.currentTime = t; return; } catch {}
    }
    if (media && typeof media.fastSeek === "function") {
      try { media.fastSeek(t); return; } catch {}
    }
    if (typeof ws.setTime === "function") { ws.setTime(t); return; }
    ws.seekTo(S.duration ? t / S.duration : 0);
  };

  const pauseThenSnap = (t) => {
    const ws = S.ws; if (!ws) return;
    clearTimer();
    if (ws.isPlaying()) {
      ws.pause();
      requestAnimationFrame(() => setPlayhead(t));
    } else {
      setPlayhead(t);
    }
  };

  const parkAtEnd = () => {
    const ws = S.ws; if (!ws) return;
    const en = regionEnd();
    const safe = Math.max((S.region?.start ?? 0), en - EPS_END);
    ws.pause();
    requestAnimationFrame(() => {
      pauseThenSnap(safe);
      S.parkedAtEnd = true;
      setNextPauseIdxFrom(en, true); // strictly GT from end
      clearTimer();
    });
  };

  /* -------- Binary searches for marks (shared + compact) -------- */
  // mode: 'gt' -> first > t, 'gte' -> first >= t
  const firstMark = (arr, t, mode) => {
    let lo = 0, hi = arr.length, eps = 1e-9;
    const cmp = mode === "gt"
      ? (x, y) => x > y + eps
      : (x, y) => x >= y - eps;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cmp(arr[mid], t)) hi = mid; else lo = mid + 1;
    }
    return lo;
  };

  // Next mark strictly > (t + grace) OR inclusive >= t
  const setNextPauseIdxFrom = (t, strictlyGT = false, graceSec = 0) => {
    const arr = S.pauseMarks;
    if (!arr.length) { S.nextPauseIdx = 0; return; }
    const target = strictlyGT ? t : (t + (graceSec || 0));
    S.nextPauseIdx = firstMark(arr, target, strictlyGT ? "gt" : "gt");
  };
  const setNextPauseIdxFromInclusive = (t) => {
    const arr = S.pauseMarks;
    if (!arr.length) { S.nextPauseIdx = 0; return; }
    S.nextPauseIdx = firstMark(arr, t, "gte");
  };

  const filterPauseMarksToRegion = () => {
    if (!ENABLE_PAUSE_MARKS || !S.region) { S.pauseMarks = []; S.nextPauseIdx = 0; return; }
    const st = S.region.start ?? 0;
    const en = S.region.end ?? S.duration;
    S.pauseMarks = pauseMarksRequested.filter((v) => (v >= st && v <= en));
    setNextPauseIdxFrom(S.ws?.getCurrentTime?.() ?? st, true);
  };

  // Schedule only *future* pauses; honors suppression window
  const scheduleNextPause = () => {
    if (!ENABLE_PAUSE_MARKS) return;
    clearTimer();

    const ws = S.ws; if (!ws || !ws.isPlaying() || S.parkedAtEnd) return;
    if (!S.pauseMarks.length || S.nextPauseIdx >= S.pauseMarks.length) return;

    const msLeft = S.suppressPausesUntil - nowMs();
    if (msLeft > 0) { S.timer = setTimeout(scheduleNextPause, msLeft + 10); return; }

    const now = ws.getCurrentTime();
    const target = S.pauseMarks[S.nextPauseIdx];
    const end = regionEnd();
    if (target > end) return;

    if (target <= now + 1e-6) { S.nextPauseIdx++; scheduleNextPause(); return; }

    const delayMs = Math.max(((target - now) / (Math.abs(S.rate) || 1)) * 1000, 20);
    S.timer = setTimeout(() => {
      if (nowMs() < S.suppressPausesUntil || !ws.isPlaying()) { scheduleNextPause(); return; }
      const nudge = isMobile ? NUDGE_BEFORE : 0;
      pauseThenSnap(Math.max(0, target - nudge));
      S.nextPauseIdx++;
      clearTimer();
    }, delayMs);
  };

  const goToStart = (shouldPlayAfter = false) => {
    const st = S.region?.start ?? 0;
    pauseThenSnap(st);
    S.parkedAtEnd = false;
    setNextPauseIdxFrom(st, true);
    if (shouldPlayAfter) requestAnimationFrame(() => playSafe(S.ws));
  };

  const prevTarget = (t) => {
    if (!S.region) return 0;
    const st = S.region.start ?? 0;
    const arr = S.pauseMarks; if (!arr.length) return st;
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < t - 1e-6) lo = mid + 1; else hi = mid; }
    const idx = lo - 1;
    return (idx >= 0) ? arr[idx] : st;
  };

  const jumpPrevAndPlay = () => {
    const ws = S.ws; if (!ws) return;
    const base = S.parkedAtEnd ? regionEnd() : ws.getCurrentTime();
    const target = prevTarget(base);
    if (ws.isPlaying()) {
      setPlayhead(target);
      S.parkedAtEnd = false;
      setNextPauseIdxFromInclusive(target);
      clearTimer();
      scheduleNextPause();
    } else {
      pauseThenSnap(target);
      S.parkedAtEnd = false;
      setNextPauseIdxFromInclusive(target);
      requestAnimationFrame(() => playSafe(ws));
      scheduleNextPause();
    }
  };

  // Safe programmatic skip that keeps pause scheduling in sync + boundary-cross fix
  const skipBy = (deltaSec) => {
    const ws = S.ws; if (!ws) return;
    const st = S.region?.start ?? 0;
    const en = regionEnd();
    const cur = ws.getCurrentTime();

    let t = cur + deltaSec;

    // clamp to region
    if (t < st) t = st;
    if (t > en) t = Math.max(st, en - 0.001);

    // boundary handling when jumping BACKWARD across segments
    const arr = S.pauseMarks;
    if (arr.length && deltaSec < 0) {
      const i = firstMark(arr, t, "gte");
      if (i < arr.length) {
        const boundary = arr[i];
        if (t >= boundary - CATCH_EPS) t = Math.min(boundary - NUDGE_BEFORE, Math.max(st, t));
        if (t >= boundary) t = Math.max(st, boundary - NUDGE_BEFORE);
      }
    }

    // Apply the seek
    if (ws.isPlaying()) {
      setPlayhead(t);
      S.parkedAtEnd = false;
      deltaSec < 0 ? setNextPauseIdxFromInclusive(t)
                   : setNextPauseIdxFrom(t, true, CLICK_GRACE_SEC);
      clearTimer();
      if (ENABLE_PAUSE_MARKS) scheduleNextPause();
    } else {
      pauseThenSnap(t);
      S.parkedAtEnd = false;
      deltaSec < 0 ? setNextPauseIdxFromInclusive(t)
                   : setNextPauseIdxFrom(t, true, CLICK_GRACE_SEC);
      clearTimer();
    }
  };

  const jumpBack3s = () => skipBy(-3);

  /* ------------------------------ Create WaveSurfer ------------------------------ */

  const createWaveSurfer = (url) => {
    if (!wfContainer) return;

    if (S.ws) {
      try { S.ws.unAll(); S.ws.destroy(); } catch {}
      S.ws = null; S.regions = null; S.region = null; S.duration = 0; window.currentWaveSurfer = null;
    }

    const ws = WaveSurfer.create({
      container: "#waveform",
      backend: "MediaElement",
      url, // already cleaned
      autoplay: false,
      height: isNarrow ? 64 : 60,
      waveColor: "#c5c5c5",
      progressColor: "orangered",
      cursorColor: "transparent",
      pixelRatio: S.pixelRatio,
      normalize: false,
      minPxPerSec: 20,
      interact: true,
      autoCenter: false,
    });

    ws.on("error", (e) => { console.error("[player] WaveSurfer error:", e); });

    const regions = ws.registerPlugin(RegionsPlugin.create({ dragSelection: false }));
    S.ws = ws; S.regions = regions; window.currentWaveSurfer = ws;

    const media = ws.getMediaElement?.();
    if (media) {
      media.setAttribute?.("playsinline", "playsinline");
      media.setAttribute?.("webkit-playsinline", "webkit-playsinline");
      try { media.preload = "auto"; } catch {}
      media.addEventListener?.("error", () => {
        const err = media.error;
        console.error("[player] MediaElement error", err?.code, err);
      });
    }

    ws.once("ready", () => {
      S.duration = ws.getDuration(); S.rate = 1;
      ws.setPlaybackRate(1, true);
      const m = ws.getMediaElement?.();
      if (m) { m.preservesPitch = m.mozPreservesPitch = m.webkitPreservesPitch = true; }

      S.region = regions.addRegion({
        id: "region", start: timeStart, end: safeRegionEnd(S.duration),
        color: "hsla(400,100%,30%,0.18)", drag: true, resize: true,
      });

      S.parkedAtEnd = false;
      filterPauseMarksToRegion();
      goToStart(false);
      sizeStickyPlayer();
    });

    regions.on("region-updated", () => {
      S.parkedAtEnd = false;
      filterPauseMarksToRegion();
      if (ws.isPlaying()) scheduleNextPause();
    });

    const updateTimestamp = rafThrottle((t) => {
      if (timestampEl) timestampEl.textContent = `Current Time: ${t.toFixed(2)}s`;
    });

    // Timeupdate: pause-at-marks with suppression + safe end parking
    ws.on("timeupdate", (t) => {
      updateTimestamp(t);
      if (!S.region) return;
      const en = regionEnd();

      if (ENABLE_PAUSE_MARKS && ws.isPlaying() && nowMs() >= S.suppressPausesUntil) {
        if (S.pauseMarks.length && S.nextPauseIdx < S.pauseMarks.length) {
          const target = S.pauseMarks[S.nextPauseIdx];
          if (target <= en && target >= t) {
            const EPS = isMobile ? MOBILE_EPS : Math.max(0.02, 0.005 * Math.abs(S.rate || 1));
            if (t + EPS >= target) {
              const nudge = isMobile ? NUDGE_BEFORE : 0;
              pauseThenSnap(Math.max(0, target - nudge));
              S.nextPauseIdx++;
              S.parkedAtEnd = false;
              return;
            }
          }
        }
      }

      if (ws.isPlaying() && t >= en - 0.004) parkAtEnd();
    });

    // Interaction: mark user seek + intent to autoplay, add suppression and mobile-safe play()
    ws.on("interaction", () => {
      if (!S.region) return;
      S.userSeeking = true;
      S.wantAutoPlayOnClick = true;
      S.parkedAtEnd = false;
      clearTimer();
      S.suppressPausesUntil = nowMs() + (isMobile ? MOBILE_SUPPRESS_MS : DESKTOP_SUPPRESS_MS);

      // Start playback *immediately* inside the gesture on mobile/Android
      if (!S.ws.isPlaying()) playSafe(S.ws);
    });

    // Seek: clamp, position, reschedule, optionally autoplay
    ws.on("seek", (p) => {
      const clickedTime = p * S.duration;
      const st = S.region?.start ?? 0;
      const en = regionEnd();

      if (S.userSeeking) {
        let t = clickedTime;
        if (t < st) t = st;
        if (t > en) t = Math.max(st, en - 0.001);

        setPlayhead(t);
        setNextPauseIdxFrom(t, true, CLICK_GRACE_SEC);

        if (S.wantAutoPlayOnClick) {
          playSafe(ws);
          S.wantAutoPlayOnClick = false;
        }

        clearTimer();
        if (ENABLE_PAUSE_MARKS) scheduleNextPause();

        S.userSeeking = false;
        return;
      }

      // programmatic seeks
      S.parkedAtEnd = (Math.abs(clickedTime - en) < 0.003);
      setNextPauseIdxFrom(clickedTime, true);
      clearTimer();
      if (ENABLE_PAUSE_MARKS && ws.isPlaying() && !S.parkedAtEnd) scheduleNextPause();
    });

    ws.on("play", () => {
      if (S.isResetting) { ws.pause(); return; }
      const st = S.region?.start ?? 0;
      const en = regionEnd();
      const t  = ws.getCurrentTime();
      if (S.parkedAtEnd || t < st || t >= en) {
        pauseThenSnap(st);
        S.parkedAtEnd = false;
        setNextPauseIdxFrom(st, true);
        requestAnimationFrame(() => playSafe(ws));
        scheduleNextPause();
      } else {
        setNextPauseIdxFrom(t, true);
        if (ENABLE_PAUSE_MARKS) scheduleNextPause();
      }
    });

    ws.on("pause", () => { clearTimer(); });
  };

  /* ------------------------------ Controls (public API) ------------------------------ */

  function playPause() {
    const ws = S.ws; if (!ws) return;
    if (ws.isPlaying()) { ws.pause(); return; }

    const r = S.region;
    if (r) {
      const t  = ws.getCurrentTime();
      const st = r.start ?? 0;
      const en = r.end ?? S.duration;

      if (S.parkedAtEnd || t < st || t >= en) {
        pauseThenSnap(st);
        S.parkedAtEnd = false;
        setNextPauseIdxFrom(st, true);
        requestAnimationFrame(() => playSafe(ws));
        scheduleNextPause();
        return;
      } else {
        setNextPauseIdxFrom(t, true);
      }
    }

    requestAnimationFrame(() => playSafe(ws));
    scheduleNextPause();
  }

  function stopPlayback() {
    if (!S.ws) return;
    S.ws.stop();
    S.parkedAtEnd = false;
    setNextPauseIdxFrom(S.region ? S.region.start : 0, true);
    clearTimer();
  }

  function resetRegion() {
    if (!S.ws || !S.regions) return;
    S.isResetting = true;
    if (S.ws.isPlaying()) S.ws.pause();
    clearTimer();
    S.regions.clearRegions();

    S.region = S.regions.addRegion({
      id: "region", start: timeStart, end: safeRegionEnd(S.duration),
      color: "hsla(400,100%,30%,0.18)", drag: true, resize: true,
    });

    S.parkedAtEnd = false;
    filterPauseMarksToRegion();
    goToStart(false);
    setTimeout(() => { S.isResetting = false; }, 0);
  }

  function setSpeed(s) {
    const ws = S.ws; if (!ws) return;
    S.rate = s;
    ws.setPlaybackRate(s, true);
    const m = ws.getMediaElement?.(); if (m) { m.preservesPitch = m.mozPreservesPitch = m.webkitPreservesPitch = true; }
    if (ws.isPlaying() && !S.parkedAtEnd) { clearTimer(); scheduleNextPause(); }
  }

  function loadNewAudio(newUrl) {
    const cleaned = cleanAudioUrl(newUrl);
    if (!cleaned) { console.error("[player] loadNewAudio got empty URL from:", newUrl); return; }
    createWaveSurfer(cleaned);
  }

  // Expose for buttons (unchanged API)
  window.playPause = playPause;
  window.stopPlayback = stopPlayback;
  window.resetRegion = resetRegion;
  window.setSpeed = setSpeed;
  window.loadNewAudio = loadNewAudio;

  /* ------------------------------ Sticky sizing ------------------------------ */

  const sizeStickyPlayer = rafThrottle(() => {
    const el = $("playerContainer");
    if (!el) return;
    document.documentElement.style.setProperty("--player-height", (el.offsetHeight || 0) + "px");
  });
  addEventListener("resize", sizeStickyPlayer, { passive: true });
  addEventListener("orientationchange", sizeStickyPlayer, { passive: true });

  /* ------------------------------ Init ------------------------------ */

  const boot = () => createWaveSurfer(audioUrl);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

  /* ------------------------------ Keyboard ------------------------------ */

  if (window._waveDetachKeys) { try { window._waveDetachKeys(); } catch {} window._waveDetachKeys = null; }

  const keyHandler = (e) => {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    const ws = S.ws; if (!ws) return;

    switch ((e.key || "").toLowerCase()) {
      case "g": e.preventDefault(); skipBy(-3); break;
      case "h": e.preventDefault(); jumpPrevAndPlay(); break;
      case "j": e.preventDefault(); playPause(); break;
      case "k": e.preventDefault(); skipBy(+0.5); break;
      case "l":
      case "p": e.preventDefault(); skipBy(-100); break;
    }
  };

  document.addEventListener("keydown", keyHandler, { passive: false });
  window._waveDetachKeys = () => { document.removeEventListener("keydown", keyHandler); };

  /* ------------------------------ Buttons ------------------------------ */

  playPauseBtn    && playPauseBtn.addEventListener("click", () => { playPause(); });
  prevMarkBtn     && prevMarkBtn.addEventListener("click",  () => { jumpPrevAndPlay(); });
  stopBtn         && stopBtn.addEventListener("click",      () => { stopPlayback(); });
  skipBackwardBtn && skipBackwardBtn.addEventListener("click", () => { skipBy(-3); });
  resetRegionBtn  && resetRegionBtn.addEventListener("click",  () => { resetRegion(); });
}
