// Externalized version of your inline script.
// IMPORTANT: Anki does NOT substitute {{fields}} inside files,
// so we accept values via initPlayer(config) from the template.

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

const ensurePreservePitch = (ws, on = true) => {
  const media = ws?.getMediaElement?.();
  if (!media) return;
  media.preservesPitch = on;
  media.mozPreservesPitch = on;
  media.webkitPreservesPitch = on;
};

const norm = (v) => (v == null ? "" : String(v).trim());

const parseTime = (raw) => {
  const s = norm(raw).toLowerCase();
  if (!s) return NaN;
  if (s.endsWith('s')) return parseFloat(s.slice(0, -1));
  if (s.includes(':')) {
    const p = s.split(':').map(Number);
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

/* ------------------------------ Main ------------------------------ */

export default function initPlayer(userCfg = {}) {
  // Read values passed from the card template
  const audioUrlRaw = norm(userCfg.wave);
  if (!audioUrlRaw) {
    console.warn("[player] Missing {{wave}} value");
    return;
  }

  // Field parsing & defaults
  const start01 = parseTime(userCfg.start01);
  const end01   = parseTime(userCfg.end01);
  const start02 = parseTime(userCfg.start02);

  const timeStart  = Number.isNaN(start01) ? 0 : start01;
  const timeEndRaw = !Number.isNaN(end01) ? end01 : (!Number.isNaN(start02) ? start02 : null);

  const pauseMarksRequested = parsePauseMarks(userCfg.pauseMarks);
  const ENABLE_PAUSE_MARKS = pauseMarksRequested.length > 0;

  /* ------------------------------ DOM ------------------------------ */

  const wfContainer     = $('waveform');
  const timestampEl     = $('timestamp');
  const playPauseBtn    = $('playPauseButton');
  const prevMarkBtn     = $('prevMarkButton');
  const stopBtn         = $('stopButton');
  const skipBackwardBtn = $('skipBackwardButton');
  const resetRegionBtn  = $('resetRegionButton');

  if (!wfContainer) {
    console.warn("[player] #waveform element not found.");
    return;
  }

  /* ------------------------------ State ------------------------------ */

  const S = {
    ws: null, regions: null, region: null, duration: 0,
    rate: 1,
    pixelRatio: Math.min((window.devicePixelRatio || 1),
                         (matchMedia('(max-width: 768px)').matches ? 1 : 1.5)),
    pauseMarks: [], nextPauseIdx: 0,
    timer: null, parkedAtEnd: false, isResetting: false
  };

  /* ------------------------------ Helpers ------------------------------ */

  const clearTimer = () => { if (S.timer) { clearTimeout(S.timer); S.timer = null; } };

  const safeRegionEnd = (dur) => (timeEndRaw !== null && timeEndRaw < dur) ? timeEndRaw : dur;

  const regionEnd = () => (S.region?.end ?? S.duration);

  const setNextPauseIdxFrom = (t) => {
    const arr = S.pauseMarks;
    if (!arr.length) { S.nextPauseIdx = 0; return; }
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] > t + 1e-6) hi = mid; else lo = mid + 1;
    }
    S.nextPauseIdx = lo;
  };

  const filterPauseMarksToRegion = () => {
    if (!ENABLE_PAUSE_MARKS) { S.pauseMarks = []; S.nextPauseIdx = 0; return; }
    if (!S.region) { S.pauseMarks = []; S.nextPauseIdx = 0; return; }
    const st = S.region.start ?? 0;
    const en = S.region.end ?? S.duration;
    S.pauseMarks = pauseMarksRequested.filter((v) => (v >= st && v <= en));
    setNextPauseIdxFrom(S.ws?.getCurrentTime?.() ?? st);
  };

  const EPS_END = 0.02; // park 20ms before end

  function playNextFrame(ws) {
    requestAnimationFrame(() => {
      const p = ws.play?.();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    });
  }

  function pauseThenSnap(target) {
    const ws = S.ws; if (!ws) return;
    clearTimer();
    const snap = () => {
      const media = ws.getMediaElement?.();
      if (media && typeof media.fastSeek === 'function') {
        try { media.fastSeek(target); return; } catch (_) {}
      }
      if (typeof ws.setTime === 'function') ws.setTime(target);
      else ws.seekTo(target / S.duration);
    };
    if (ws.isPlaying()) { ws.pause(); requestAnimationFrame(snap); } else { snap(); }
  }

  function parkAtEnd() {
    const ws = S.ws; if (!ws) return;
    const en = regionEnd();
    const safe = Math.max((S.region?.start ?? 0), en - EPS_END);
    ws.pause();
    requestAnimationFrame(() => {
      pauseThenSnap(safe);
      S.parkedAtEnd = true;
      setNextPauseIdxFrom(en);
      clearTimer();
    });
  }

  const scheduleNextPause = () => {
    if (!ENABLE_PAUSE_MARKS) return;
    clearTimer();
    const ws = S.ws; if (!ws || !ws.isPlaying() || S.parkedAtEnd) return;
    if (!S.pauseMarks.length || S.nextPauseIdx >= S.pauseMarks.length) return;

    const now = ws.getCurrentTime();
    const target = S.pauseMarks[S.nextPauseIdx];
    const end = regionEnd();
    if (target > end) return;

    if (now >= target - 1e-6) { S.nextPauseIdx++; scheduleNextPause(); return; }

    const delayMs = Math.max(((target - now) / (Math.abs(S.rate) || 1)) * 1000, 20);
    S.timer = setTimeout(() => {
      if (!ws.isPlaying()) return;
      pauseThenSnap(target);
      S.nextPauseIdx++;
      clearTimer();
    }, delayMs);
  };

  function goToStart(shouldPlayAfter = false) {
    const ws = S.ws; if (!ws) return;
    const st = S.region?.start ?? 0;
    if (ws.isPlaying()) {
      pauseThenSnap(st);
      if (shouldPlayAfter) playNextFrame(ws);
    } else {
      const media = ws.getMediaElement?.();
      if (media && typeof media.fastSeek === 'function') { try { media.fastSeek(st); } catch(_) {} }
      else if (typeof ws.setTime === 'function') ws.setTime(st);
      else ws.seekTo(st / S.duration);
    }
    S.parkedAtEnd = false;
    setNextPauseIdxFrom(st);
  }

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
    pauseThenSnap(target);
    S.parkedAtEnd = false;
    setNextPauseIdxFrom(target);
    playNextFrame(ws);
    scheduleNextPause();
  };

  /* ------------------------------ Create WaveSurfer ------------------------------ */

  function createWaveSurfer(url) {
    if (!wfContainer) return;

    if (S.ws) { try { S.ws.unAll(); S.ws.destroy(); } catch {} S.ws = null; S.regions = null; S.region = null; S.duration = 0; window.currentWaveSurfer = null; }

    const ws = WaveSurfer.create({
      container: '#waveform',
      backend: 'MediaElement',
      url: String(url).replace('[sound:', '').replace('}', '').trim(),
      autoplay: false,
      height: matchMedia('(max-width: 768px)').matches ? 64 : 60,
      waveColor: '#c5c5c5',
      progressColor: 'orangered',
      cursorColor: 'transparent',
      pixelRatio: S.pixelRatio,
      normalize: false,
      minPxPerSec: 20,
      interact: true,
      autoCenter: false
    });

    const regions = ws.registerPlugin(RegionsPlugin.create({ dragSelection: false }));

    S.ws = ws; S.regions = regions; window.currentWaveSurfer = ws;

    /* iOS hints */
    const media = ws.getMediaElement?.();
    if (media) { try { media.setAttribute('playsinline', 'playsinline'); media.setAttribute('webkit-playsinline', 'webkit-playsinline'); media.preload = 'auto'; } catch {} }

    ws.once('ready', () => {
      S.duration = ws.getDuration(); S.rate = 1;
      ws.setPlaybackRate(1, true); ensurePreservePitch(ws, true);

      S.region = regions.addRegion({
        id: 'region', start: timeStart, end: safeRegionEnd(S.duration),
        color: 'hsla(400,100%,30%,0.18)', drag: true, resize: true
      });

      S.parkedAtEnd = false;
      filterPauseMarksToRegion();
      goToStart(false); // quiet
      sizeStickyPlayer();
    });

    regions.on('region-updated', () => {
      S.parkedAtEnd = false;
      filterPauseMarksToRegion();
      if (ws.isPlaying()) scheduleNextPause();
    });

    const updateTimestamp = rafThrottle((t) => { if (timestampEl) timestampEl.textContent = `Current Time: ${t.toFixed(2)}s`; });

    // Frame-driven pause at marks (mobile-safe) + safe parking at end
    ws.on('timeupdate', (t) => {
      updateTimestamp(t);
      if (!S.region) return;

      const en = regionEnd();

      if (ENABLE_PAUSE_MARKS && ws.isPlaying() && S.pauseMarks.length && S.nextPauseIdx < S.pauseMarks.length) {
        const target = S.pauseMarks[S.nextPauseIdx];
        if (target <= en) {
          const EPS = Math.max(0.02, 0.005 * Math.abs(S.rate || 1));
          if (t + EPS >= target) {
            pauseThenSnap(target);
            S.nextPauseIdx++;
            S.parkedAtEnd = false;
            return; // don't also clamp to end now
          }
        }
      }

      // Park slightly before the end to avoid "ended" state + distortion
      if (ws.isPlaying() && t >= en - 0.004) {
        parkAtEnd();
      }
    });

    ws.on('interaction', () => {
      if (!S.region) { playNextFrame(ws); return; }

      const t  = ws.getCurrentTime();
      const st = S.region.start ?? 0;
      const en = regionEnd();

      if (S.parkedAtEnd) {
        // Always restart from start on interaction when parked
        pauseThenSnap(st);
        S.parkedAtEnd = false;
        setNextPauseIdxFrom(st);
        playNextFrame(ws);
        scheduleNextPause();
        return;
      }

      if (t < st || t > en) { pauseThenSnap(st); setNextPauseIdxFrom(st); }
      else { setNextPauseIdxFrom(t); }

      playNextFrame(ws);
      scheduleNextPause();
    });

    ws.on('seek', (p) => {
      const t = p * S.duration;
      const en = regionEnd();
      S.parkedAtEnd = (Math.abs(t - en) < 0.003);
      setNextPauseIdxFrom(t);
      clearTimer();
      if (ENABLE_PAUSE_MARKS && ws.isPlaying() && !S.parkedAtEnd) scheduleNextPause();
    });

    ws.on('play', () => {
      if (S.isResetting) { ws.pause(); return; }
      const st = S.region?.start ?? 0;
      const en = regionEnd();
      const t  = ws.getCurrentTime();
      if (S.parkedAtEnd || t < st || t >= en) {
        pauseThenSnap(st);
        S.parkedAtEnd = false;
        setNextPauseIdxFrom(st);
        playNextFrame(ws);
        scheduleNextPause();
      } else {
        setNextPauseIdxFrom(t);
        if (ENABLE_PAUSE_MARKS) scheduleNextPause();
      }
    });

    ws.on('pause', () => { clearTimer(); });
  }

  /* ------------------------------ Controls ------------------------------ */

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
        setNextPauseIdxFrom(st);
        playNextFrame(ws);
        scheduleNextPause();
        return;
      } else {
        setNextPauseIdxFrom(t);
      }
    }

    playNextFrame(ws);
    scheduleNextPause();
  }

  function stopPlayback() {
    if (!S.ws) return;
    S.ws.stop();
    S.parkedAtEnd = false;
    setNextPauseIdxFrom(S.region ? S.region.start : 0);
    clearTimer();
  }

  function resetRegion() {
    if (!S.ws || !S.regions) return;
    S.isResetting = true;
    if (S.ws.isPlaying()) S.ws.pause();
    clearTimer();
    S.regions.clearRegions();

    S.region = S.regions.addRegion({
      id: 'region', start: timeStart, end: safeRegionEnd(S.duration),
      color: 'hsla(400,100%,30%,0.18)', drag: true, resize: true
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
    ensurePreservePitch(ws, true);
    if (ws.isPlaying() && !S.parkedAtEnd) { clearTimer(); scheduleNextPause(); }
  }

  function loadNewAudio(newUrl) {
    const cleanUrl = String(newUrl).replace('[sound:', '').replace('}', '').trim();
    createWaveSurfer(cleanUrl);
  }

  // Expose for your buttons
  window.playPause = playPause;
  window.stopPlayback = stopPlayback;
  window.resetRegion = resetRegion;
  window.setSpeed = setSpeed;
  window.loadNewAudio = loadNewAudio;

  /* ------------------------------ Sticky sizing ------------------------------ */

  const sizeStickyPlayer = rafThrottle(() => {
    const el = document.getElementById('playerContainer');
    if (!el) return;
    const h = el.offsetHeight || 0;
    document.documentElement.style.setProperty('--player-height', h + 'px');
  });
  window.addEventListener('resize', sizeStickyPlayer, { passive: true });
  window.addEventListener('orientationchange', sizeStickyPlayer, { passive: true });

  /* ------------------------------ Init ------------------------------ */
  const audioUrl = audioUrlRaw;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => createWaveSurfer(audioUrl), { once: true });
  } else {
    createWaveSurfer(audioUrl);
  }

  /* ------------------------------ Keyboard ------------------------------ */

  if (window._waveDetachKeys) { try { window._waveDetachKeys(); } catch {} window._waveDetachKeys = null; }

  const keyHandler = (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const ws = S.ws; if (!ws) return;

    const k = (e.key || '').toLowerCase();
    switch (k) {
      case 'g': e.preventDefault(); ws.skip(-3); break;
      case 'h': e.preventDefault(); jumpPrevAndPlay(); break;
      case 'j': e.preventDefault(); playPause(); break;
      case 'k': e.preventDefault(); ws.skip(0.5); break;
      case 'l':
      case 'p': e.preventDefault(); ws.skip(-100); break;
    }
  };

  document.addEventListener('keydown', keyHandler, { passive: false });
  window._waveDetachKeys = () => { document.removeEventListener('keydown', keyHandler); };

  /* ------------------------------ Buttons ------------------------------ */

  if (playPauseBtn) playPauseBtn.addEventListener('click', (e) => { e.preventDefault(); playPause(); }, { passive: true });
  if (prevMarkBtn)  prevMarkBtn.addEventListener('click',  (e) => { e.preventDefault(); jumpPrevAndPlay(); }, { passive: true });
  if (stopBtn)      stopBtn.addEventListener('click',      (e) => { e.preventDefault(); stopPlayback(); }, { passive: true });
  if (skipBackwardBtn) skipBackwardBtn.addEventListener('click', (e) => {
    e.preventDefault(); const ws = S.ws; if (ws) ws.skip(-3);
  }, { passive: true });
  if (resetRegionBtn) resetRegionBtn.addEventListener('click', (e) => { e.preventDefault(); resetRegion(); }, { passive: true });
}
