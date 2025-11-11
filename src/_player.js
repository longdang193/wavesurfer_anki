// _player.js (optimized + Android pause-mark unstick kept) — with 1-decimal timestamp (no "s")
// Public API unchanged: window.playPause, window.stopPlayback, window.resetRegion,
// window.setSpeed, window.loadNewAudio

import WaveSurfer from "./_7.10.1_wavesurfer.esm.min.js";
import RegionsPlugin from "./_7.10.1-regions.esm.min.js";

/* ------------------------------ Utilities ------------------------------ */

const $ = (id) => document.getElementById(id);

function rafThrottle(fn) {
  let rafId = 0;
  return function throttled(...args) {
    if (rafId) return;
    rafId = requestAnimationFrame(() => { rafId = 0; fn(...args); });
  };
}

const norm = (v) => (v == null ? "" : String(v).trim());

function parseTime(raw) {
  const s = norm(raw).toLowerCase();
  if (!s) return NaN;
  if (s.endsWith("s")) return parseFloat(s.slice(0, -1));
  if (s.includes(":")) {
    const p = s.split(":").map(Number);
    return p.length === 2 ? p[0] * 60 + p[1] :
           p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] :
           NaN;
  }
  return parseFloat(s);
}

const RE_MARKS = /(\d+(?:\.\d+)?)\s*s?/gi;
function parsePauseMarks(raw) {
  const s = norm(raw);
  if (!s) return [];
  const out = [];
  let m; RE_MARKS.lastIndex = 0;
  while ((m = RE_MARKS.exec(s)) !== null) {
    const v = parseFloat(m[1]);
    if (!Number.isNaN(v)) out.push(v);
  }
  if (!out.length) return out;
  out.sort((a, b) => a - b);
  // unique in-place
  let w = 1;
  for (let i = 1; i < out.length; i++) if (out[i] !== out[i - 1]) out[w++] = out[i];
  out.length = w;
  return out;
}

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
  /* ---------- Inputs ---------- */
  const audioUrlRaw = norm(userCfg.wave);
  if (!audioUrlRaw) { console.warn("[player] Missing {{wave}} value"); return; }

  const audioUrl = cleanAudioUrl(audioUrlRaw);
  if (!audioUrl)  { console.error("[player] Cleaned audio URL is empty. Raw:", audioUrlRaw); return; }
  if (!isLikelyAudio(audioUrl)) { console.warn("[player] URL may not be audio:", audioUrl); }

  const tStart01 = parseTime(userCfg.start01);
  const tEnd01   = parseTime(userCfg.end01);
  const tStart02 = parseTime(userCfg.start02);

  const timeStart  = Number.isNaN(tStart01) ? 0 : tStart01;
  const timeEndRaw = !Number.isNaN(tEnd01) ? tEnd01 : (!Number.isNaN(tStart02) ? tStart02 : null);

  const pauseMarksRequested = parsePauseMarks(userCfg.pauseMarks);
  const ENABLE_PAUSE_MARKS = pauseMarksRequested.length > 0;

  /* ---------- DOM ---------- */
  const wfContainer     = $("waveform");
  const timestampEl     = $("timestamp");
  const playPauseBtn    = $("playPauseButton");
  const prevMarkBtn     = $("prevMarkButton");
  const stopBtn         = $("stopButton");
  const skipBackwardBtn = $("skipBackwardButton");
  const resetRegionBtn  = $("resetRegionButton");
  if (!wfContainer) { console.warn("[player] #waveform not found"); return; }

  /* ---------- Tunables (kept) ---------- */
  const CLICK_GRACE_SEC     = 0.03;
  const DESKTOP_SUPPRESS_MS = 140;
  const MOBILE_SUPPRESS_MS  = 220;
  const EPS_END             = 0.02;
  const MOBILE_EPS          = 0.06;
  const NUDGE_BEFORE        = 0.006;
  const NUDGE_AFTER         = 0.015; // resume just after a mark on Android
  const CATCH_EPS           = 0.025;

  /* ---------- State ---------- */
  const S = {
    ws: null, regions: null, region: null,
    duration: 0, rate: 1,
    pixelRatio: Math.min((window.devicePixelRatio || 1), (isNarrow ? 1 : 1.5)),

    pauseMarks: [], nextPauseIdx: 0,

    timer: 0, parkedAtEnd: false, isResetting: false,
    userSeeking: false, wantAutoPlayOnClick: false,
    suppressPausesUntil: 0,

    // Android unstick
    pausedAtMark: false,
    lastPausedMark: null,
  };

  /* ---------- Small helpers ---------- */

  function clearTimer() {
    if (S.timer) { clearTimeout(S.timer); S.timer = 0; }
  }

  const regionEnd = () => (S.region?.end ?? S.duration);

  const safeRegionEnd = (dur) => (timeEndRaw !== null && timeEndRaw < dur) ? timeEndRaw : dur;

  function playSafe(ws) {
    const p = ws.play?.();
    if (p && p.catch) p.catch(() => {});
  }

  function setPlayhead(t) {
    const ws = S.ws; if (!ws) return;
    const media = ws.getMediaElement?.();
    if (media && isMobile) {
      try {
        media.currentTime = t;
        void media.currentTime; // micro-flush on some Android builds
        return;
      } catch {}
    }
    if (media && typeof media.fastSeek === "function") {
      try { media.fastSeek(t); return; } catch {}
    }
    if (typeof ws.setTime === "function") { ws.setTime(t); return; }
    ws.seekTo(S.duration ? t / S.duration : 0);
  }

  function pauseThenSnap(t) {
    const ws = S.ws; if (!ws) return;
    clearTimer();
    if (ws.isPlaying()) {
      ws.pause();
      requestAnimationFrame(() => setPlayhead(t));
    } else {
      setPlayhead(t);
    }
  }

  function resetMarkFlags() {
    S.pausedAtMark = false;
    S.lastPausedMark = null;
  }

  /* ---------- Mark search ---------- */

  // mode: 'gt' first > t, 'gte' first >= t
  function firstMark(arr, t, mode) {
    let lo = 0, hi = arr.length;
    const eps = 1e-9;
    const cmp = mode === "gt"
      ? (x, y) => x > y + eps
      : (x, y) => x >= y - eps;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cmp(arr[mid], t)) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  function setNextPauseIdxFrom(t, strictlyGT = true, graceSec = 0) {
    const arr = S.pauseMarks;
    if (!arr.length) { S.nextPauseIdx = 0; return; }
    const target = strictlyGT ? t : (t + (graceSec || 0));
    S.nextPauseIdx = firstMark(arr, target, "gt");
  }

  function setNextPauseIdxFromInclusive(t) {
    const arr = S.pauseMarks;
    if (!arr.length) { S.nextPauseIdx = 0; return; }
    S.nextPauseIdx = firstMark(arr, t, "gte");
  }

  function filterPauseMarksToRegion() {
    if (!ENABLE_PAUSE_MARKS || !S.region) { S.pauseMarks = []; S.nextPauseIdx = 0; return; }
    const st = S.region.start ?? 0;
    const en = S.region.end ?? S.duration;
    // slice in one pass (array is sorted)
    const src = pauseMarksRequested;
    let i = 0, j = src.length - 1;
    while (i <= j && src[i] < st) i++;
    while (j >= i && src[j] > en) j--;
    S.pauseMarks = i <= j ? src.slice(i, j + 1) : [];
    setNextPauseIdxFrom(S.ws?.getCurrentTime?.() ?? st, true);
  }

  /* ---------- Pause scheduler ---------- */

  function scheduleNextPause() {
    if (!ENABLE_PAUSE_MARKS) return;
    clearTimer();

    const ws = S.ws; if (!ws || !ws.isPlaying() || S.parkedAtEnd) return;
    if (!S.pauseMarks.length || S.nextPauseIdx >= S.pauseMarks.length) return;

    const msLeft = S.suppressPausesUntil - nowMs();
    if (msLeft > 0) { S.timer = setTimeout(scheduleNextPause, msLeft + 10); return; }

    const now = ws.getCurrentTime();
    const end = regionEnd();
    let target = S.pauseMarks[S.nextPauseIdx];
    if (target > end) return;

    // if current time already beyond target (race), advance index
    if (target <= now + 1e-6) {
      S.nextPauseIdx++;
      if (S.nextPauseIdx < S.pauseMarks.length) scheduleNextPause();
      return;
    }

    const delayMs = Math.max(((target - now) / (Math.abs(S.rate) || 1)) * 1000, 20);
    S.timer = setTimeout(() => {
      if (nowMs() < S.suppressPausesUntil || !ws.isPlaying()) { scheduleNextPause(); return; }
      const nudge = isMobile ? NUDGE_BEFORE : 0;
      // mark-caused pause (for Android resume unstick)
      S.pausedAtMark = true;
      S.lastPausedMark = target;
      pauseThenSnap(Math.max(0, target - nudge));
      S.nextPauseIdx++;
      clearTimer();
    }, delayMs);
  }

  function goToStart(shouldPlayAfter = false) {
    const st = S.region?.start ?? 0;
    pauseThenSnap(st);
    S.parkedAtEnd = false;
    resetMarkFlags();
    setNextPauseIdxFrom(st, true);
    if (shouldPlayAfter) requestAnimationFrame(() => playSafe(S.ws));
  }

  function prevTarget(t) {
    if (!S.region) return 0;
    const st = S.region.start ?? 0;
    const arr = S.pauseMarks; if (!arr.length) return st;
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < t - 1e-6) lo = mid + 1; else hi = mid;
    }
    const idx = lo - 1;
    return (idx >= 0) ? arr[idx] : st;
  }

  function jumpPrevAndPlay() {
    const ws = S.ws; if (!ws) return;
    const base = S.parkedAtEnd ? regionEnd() : ws.getCurrentTime();
    const target = prevTarget(base);
    if (ws.isPlaying()) {
      setPlayhead(target);
      S.parkedAtEnd = false;
      resetMarkFlags();
      setNextPauseIdxFromInclusive(target);
      clearTimer();
      scheduleNextPause();
    } else {
      pauseThenSnap(target);
      S.parkedAtEnd = false;
      resetMarkFlags();
      setNextPauseIdxFromInclusive(target);
      requestAnimationFrame(() => playSafe(ws));
      scheduleNextPause();
    }
  }

  function skipBy(deltaSec) {
    const ws = S.ws; if (!ws) return;
    const st = S.region?.start ?? 0;
    const en = regionEnd();
    const cur = ws.getCurrentTime();

    let t = cur + deltaSec;

    // clamp to region
    if (t < st) t = st;
    if (t > en) t = Math.max(st, en - 0.001);

    // backward boundary handling
    const arr = S.pauseMarks;
    if (arr.length && deltaSec < 0) {
      const i = firstMark(arr, t, "gte");
      if (i < arr.length) {
        const boundary = arr[i];
        if (t >= boundary - CATCH_EPS) t = Math.min(boundary - NUDGE_BEFORE, Math.max(st, t));
        if (t >= boundary) t = Math.max(st, boundary - NUDGE_BEFORE);
      }
    }

    if (ws.isPlaying()) {
      setPlayhead(t);
      S.parkedAtEnd = false;
      resetMarkFlags();
      deltaSec < 0 ? setNextPauseIdxFromInclusive(t)
                   : setNextPauseIdxFrom(t, false, CLICK_GRACE_SEC);
      clearTimer();
      if (ENABLE_PAUSE_MARKS) scheduleNextPause();
    } else {
      pauseThenSnap(t);
      S.parkedAtEnd = false;
      resetMarkFlags();
      deltaSec < 0 ? setNextPauseIdxFromInclusive(t)
                   : setNextPauseIdxFrom(t, false, CLICK_GRACE_SEC);
      clearTimer();
    }
  }

  const jumpBack3s = () => skipBy(-3);

  /* ---------- Create WaveSurfer ---------- */

  function createWaveSurfer(url) {
    if (!wfContainer) return;

    if (S.ws) {
      try { S.ws.unAll(); S.ws.destroy(); } catch {}
      S.ws = null; S.regions = null; S.region = null; S.duration = 0; window.currentWaveSurfer = null;
    }

    const ws = WaveSurfer.create({
      container: "#waveform",
      backend: "MediaElement",
      url,
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
      resetMarkFlags();
      filterPauseMarksToRegion();
      goToStart(false);
      sizeStickyPlayer();
    });

    regions.on("region-updated", () => {
      S.parkedAtEnd = false;
      resetMarkFlags();
      filterPauseMarksToRegion();
      if (ws.isPlaying()) scheduleNextPause();
    });

    // === Timestamp: 1 digit after dot, no trailing "s" ===
    const updateTimestamp = rafThrottle((t) => {
      if (!timestampEl) return;
      const oneDec = (Math.round(t * 10) / 10).toFixed(1); // e.g., "12.3"
      timestampEl.textContent = oneDec;
    });

    // timeupdate: mark pauses + end parking
    ws.on("timeupdate", (t) => {
      updateTimestamp(t);
      if (!S.region) return;
      const en = regionEnd();

      if (ENABLE_PAUSE_MARKS && ws.isPlaying() && nowMs() >= S.suppressPausesUntil) {
        const arr = S.pauseMarks;
        const idx = S.nextPauseIdx;
        if (arr.length && idx < arr.length) {
          const target = arr[idx];
          if (target <= en && target >= t) {
            const EPS = isMobile ? MOBILE_EPS : Math.max(0.02, 0.005 * Math.abs(S.rate || 1));
            if (t + EPS >= target) {
              const nudge = isMobile ? NUDGE_BEFORE : 0;
              S.pausedAtMark = true;
              S.lastPausedMark = target;
              pauseThenSnap(Math.max(0, target - nudge));
              S.nextPauseIdx++;
              S.parkedAtEnd = false;
              return;
            }
          }
        }
      }

      if (ws.isPlaying() && t >= en - 0.004) {
        // park slightly before end to make replay reliable
        const safe = Math.max((S.region?.start ?? 0), en - EPS_END);
        ws.pause();
        requestAnimationFrame(() => {
          pauseThenSnap(safe);
          S.parkedAtEnd = true;
          resetMarkFlags();
          setNextPauseIdxFrom(en, true);
          clearTimer();
        });
      }
    });

    // user interaction: mark intent, suppression, gesture-started play
    ws.on("interaction", () => {
      if (!S.region) return;
      S.userSeeking = true;
      S.wantAutoPlayOnClick = true;
      S.parkedAtEnd = false;
      resetMarkFlags();
      clearTimer();
      S.suppressPausesUntil = nowMs() + (isMobile ? MOBILE_SUPPRESS_MS : DESKTOP_SUPPRESS_MS);
      if (!ws.isPlaying()) playSafe(ws);
    });

    // seek handler
    ws.on("seek", (p) => {
      const clickedTime = p * S.duration;
      const st = S.region?.start ?? 0;
      const en = regionEnd();

      if (S.userSeeking) {
        let t = clickedTime;
        if (t < st) t = st;
        if (t > en) t = Math.max(st, en - 0.001);

        setPlayhead(t);
        setNextPauseIdxFrom(t, false, CLICK_GRACE_SEC);

        if (S.wantAutoPlayOnClick) {
          playSafe(ws);
          S.wantAutoPlayOnClick = false;
        }

        clearTimer();
        if (ENABLE_PAUSE_MARKS) scheduleNextPause();

        S.userSeeking = false;
        return;
      }

      // programmatic seek
      S.parkedAtEnd = (Math.abs(clickedTime - en) < 0.003);
      resetMarkFlags();
      setNextPauseIdxFrom(clickedTime, true);
      clearTimer();
      if (ENABLE_PAUSE_MARKS && ws.isPlaying() && !S.parkedAtEnd) scheduleNextPause();
    });

    // on play: unstick after mark
    function resumePastMarkIfNeeded() {
      if (!S.pausedAtMark) return false;
      const st = S.region?.start ?? 0;
      const en = regionEnd();
      const after = Math.min(en - 0.001, Math.max(st, (S.lastPausedMark ?? 0) + NUDGE_AFTER));
      pauseThenSnap(after);
      resetMarkFlags();
      S.suppressPausesUntil = nowMs() + (isMobile ? MOBILE_SUPPRESS_MS : DESKTOP_SUPPRESS_MS);
      setNextPauseIdxFrom(after, false, CLICK_GRACE_SEC);
      return true;
    }

    ws.on("play", () => {
      if (S.isResetting) { ws.pause(); return; }

      const unstuck = resumePastMarkIfNeeded();
      const st = S.region?.start ?? 0;
      const en = regionEnd();
      const t  = ws.getCurrentTime();

      if (S.parkedAtEnd || t < st || t >= en) {
        pauseThenSnap(st);
        S.parkedAtEnd = false;
        resetMarkFlags();
        setNextPauseIdxFrom(st, true);
        requestAnimationFrame(() => playSafe(ws));
        scheduleNextPause();
      } else {
        if (!unstuck) setNextPauseIdxFrom(t, false, CLICK_GRACE_SEC);
        if (ENABLE_PAUSE_MARKS) scheduleNextPause();
      }
    });

    ws.on("pause", clearTimer);
  }

  /* ---------- Controls (public API) ---------- */

  function playPause() {
    const ws = S.ws; if (!ws) return;
    if (ws.isPlaying()) { ws.pause(); return; }

    const r = S.region;
    if (r) {
      // unstick if the last pause was a mark
      if (S.pausedAtMark && S.lastPausedMark != null) {
        const en = regionEnd();
        const st = r.start ?? 0;
        const after = Math.min(en - 0.001, Math.max(st, S.lastPausedMark + NUDGE_AFTER));
        pauseThenSnap(after);
        resetMarkFlags();
        S.suppressPausesUntil = nowMs() + (isMobile ? MOBILE_SUPPRESS_MS : DESKTOP_SUPPRESS_MS);
        setNextPauseIdxFrom(after, false, CLICK_GRACE_SEC);
        requestAnimationFrame(() => playSafe(ws));
        scheduleNextPause();
        return;
      }

      const t  = ws.getCurrentTime();
      const st = r.start ?? 0;
      const en = r.end ?? S.duration;

      if (S.parkedAtEnd || t < st || t >= en) {
        pauseThenSnap(st);
        S.parkedAtEnd = false;
        resetMarkFlags();
        setNextPauseIdxFrom(st, true);
        requestAnimationFrame(() => playSafe(ws));
        scheduleNextPause();
        return;
      } else {
        setNextPauseIdxFrom(t, false, CLICK_GRACE_SEC);
      }
    }

    S.suppressPausesUntil = nowMs() + (isMobile ? MOBILE_SUPPRESS_MS : DESKTOP_SUPPRESS_MS);
    requestAnimationFrame(() => playSafe(ws));
    scheduleNextPause();
  }

  function stopPlayback() {
    if (!S.ws) return;
    S.ws.stop();
    S.parkedAtEnd = false;
    resetMarkFlags();
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
    resetMarkFlags();
    filterPauseMarksToRegion();
    goToStart(false);
    setTimeout(() => { S.isResetting = false; }, 0);
  }

  function setSpeed(s) {
    const ws = S.ws; if (!ws) return;
    S.rate = s;
    ws.setPlaybackRate(s, true);
    const m = ws.getMediaElement?.();
    if (m) { m.preservesPitch = m.mozPreservesPitch = m.webkitPreservesPitch = true; }
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

  /* ---------- Sticky sizing ---------- */

  const sizeStickyPlayer = rafThrottle(() => {
    const el = $("playerContainer");
    if (!el) return;
    document.documentElement.style.setProperty("--player-height", (el.offsetHeight || 0) + "px");
  });
  addEventListener("resize", sizeStickyPlayer, { passive: true });
  addEventListener("orientationchange", sizeStickyPlayer, { passive: true });

  /* ---------- Init ---------- */

  const boot = () => createWaveSurfer(audioUrl);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

  /* ---------- Keyboard ---------- */

  if (window._waveDetachKeys) { try { window._waveDetachKeys(); } catch {} window._waveDetachKeys = null; }

  function keyHandler(e) {
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
  }

  document.addEventListener("keydown", keyHandler, { passive: false });
  window._waveDetachKeys = () => { document.removeEventListener("keydown", keyHandler); };

  /* ---------- Buttons ---------- */

  if (playPauseBtn)    playPauseBtn.addEventListener("click", playPause);
  if (prevMarkBtn)     prevMarkBtn.addEventListener("click", jumpPrevAndPlay);
  if (stopBtn)         stopBtn.addEventListener("click", stopPlayback);
  if (skipBackwardBtn) skipBackwardBtn.addEventListener("click", () => skipBy(-3));
  if (resetRegionBtn)  resetRegionBtn.addEventListener("click", resetRegion);
}
