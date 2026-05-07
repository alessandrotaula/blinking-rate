import {
  FaceLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.9/vision_bundle.mjs";

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.9/wasm";

const BLINK_HIGH = 0.55;
const BLINK_LOW = 0.25;
const MIN_BLINK_GAP_MS = 120;
const RATE_WINDOW_MS = 60_000;
const SAMPLE_INTERVAL_MS = 500;
const NO_BLINK_ALERT_MS = 90 * 1000;
const NO_BLINK_ALERT_GRACE_MS = 30 * 1000;
const VAR_WINDOW_SAMPLES = 30;
const CHART_WINDOW_MS = 120_000;
const UI_ROLLING_MS = 5 * 60_000;
const BLINK_RETENTION_MS = 5 * 60_000;
const FACE_LOST_MS = 1500;
const FACE_BACK_MS = 500;
const TICK_INTERVAL_MS = 40;
const SESSIONS_KEY = "blinkSessions.v1";
const MAX_STORED_SESSIONS = 200;
const BASELINES_KEY = "blinkBaselines.v1";
const EVENTS_KEY = "blinkCalendarEvents.v1";
const COG_TICK_MS = 2000;
const LIVE_REPORT_INTERVAL_MS = 10 * 60 * 1000;

const EVENT_CLASSES = [
  { id: "business_call", label: "Business call" },
  { id: "chill_call",    label: "Chill call" },
  { id: "deep_work",     label: "Deep work" },
  { id: "meeting",       label: "Meeting" },
  { id: "other",         label: "Other" },
];
const CLASS_LABEL = Object.fromEntries(EVENT_CLASSES.map(c => [c.id, c.label]));
const CLASS_CSS_KEY = {
  business_call: "business",
  chill_call: "chill",
  deep_work: "deep",
  meeting: "meeting",
  other: "other",
};

const el = (id) => document.getElementById(id);
const toggleBtn = el("toggleBtn");
const pipBtn = el("pipBtn");
const wakeBtn = el("wakeBtn");
const exportBtn = el("exportBtn");
const clearBtn = el("clearBtn");
const previewChk = el("previewChk");
const autoPauseChk = el("autoPauseChk");
const videoWrap = el("videoWrap");
const video = el("video");
const pipCanvas = el("pipCanvas");
const chart = el("chart");
const rateVal = el("rateVal");
const sessionRateVal = el("sessionRateVal");
const varVal = el("varVal");
const totalVal = el("totalVal");
const sessionVal = el("sessionVal");
const statusEl = el("status");
const sessionList = el("sessionList");
const pulseEl = el("pulse");
const pulseLabelEl = el("pulseLabel");
const reportSection = el("reportSection");
const reportDate = el("reportDate");
const repDuration = el("repDuration");
const repTotal = el("repTotal");
const repAvgRate = el("repAvgRate");
const repTrend = el("repTrend");
const repVar = el("repVar");
const repFdAvg = el("repFdAvg");
const repCfAvg = el("repCfAvg");
const repFdTrend = el("repFdTrend");
const repCfTrend = el("repCfTrend");
const reportAnalysis = el("reportAnalysis");
const exportReportBtn = el("exportReportBtn");
const calEventList = el("calEventList");
const clearEventsBtn = el("clearEventsBtn");
const calStats = el("calStats");
const calStatsBody = el("calStatsBody");
const connectGoogleBtn = el("connectGoogleBtn");
const connectGoogleLabel = el("connectGoogleLabel");
const signInBtn = el("signInBtn");
const signOutBtn = el("signOutBtn");
const userBadge = el("userBadge");
const userEmailEl = el("userEmail");
const adminPill = el("adminPill");
const connectWhoopBtn = el("connectWhoopBtn");
const connectWhoopLabel = el("connectWhoopLabel");
const reportPhysio = el("reportPhysio");
const physioSub = el("physioSub");
const physioKpis = el("physioKpis");
const physioCorr = el("physioCorr");
const physioNote = el("physioNote");
let currentReportSession = null;

const state = {
  landmarker: null,
  stream: null,
  tickWorker: null,
  sampleTimer: null,
  uiTimer: null,
  liveReportTimer: null,
  reportDismissed: false,
  eyesClosed: false,
  lastBlinkAt: 0,
  blinkTimes: [],
  rateHistory: [],
  varHistory: [],
  startedAt: 0,
  wakeLock: null,
  pipStream: null,
  pipVideo: null,
  audioCtx: null,
  audioOsc: null,
  totalBlinks: 0,
  paused: false,
  lastFaceSeenAt: 0,
  faceBackFirstSeenAt: 0,
  pauseStartedAt: 0,
  totalPausedMs: 0,
  // cognitive metrics
  cogB_user: 15,
  cogB_session: null,
  cogB_session_ready: false,
  cogB_session_samples: [],
  cogLastTick: 0,
  cogFD: 0,
  cogCF: 0,
  cogFD_conf: 0,
  cogCF_conf: 0,
  cogStateLabel: "idle",
  cogHistory: [],
  lastResumedAt: 0,
  activeSupprStart: null,
  suppressionEps: [],
  reboundBursts: [],
  ibiMedian3m: null,
  ibiCv3m: 0.55,
  ibiP903m: 6,
  rateSlopeSession: 0,
};

// Surface any uncaught error visibly. Without this, a silent module-level
// throw would prevent click handlers from being attached, making buttons
// look unresponsive with no clue why.
window.addEventListener("error", (ev) => {
  console.error("[uncaught error]", ev.error || ev.message, ev.filename + ":" + ev.lineno);
  try { setStatus("Script error: " + (ev.error?.message || ev.message), true); } catch {}
});
window.addEventListener("unhandledrejection", (ev) => {
  console.error("[unhandled rejection]", ev.reason);
  try { setStatus("Promise error: " + (ev.reason?.message || ev.reason), true); } catch {}
});

function setStatus(msg, isErr = false) {
  const textSpan = statusEl.querySelector("span:last-child");
  const pulseSpan = statusEl.querySelector(".pulse");
  if (textSpan) textSpan.textContent = msg; else statusEl.textContent = msg;
  statusEl.classList.toggle("err", isErr);
  if (pulseSpan) {
    pulseSpan.classList.toggle("err", isErr);
    if (isErr) pulseSpan.classList.remove("idle");
  }
}

function setPulse(mode, label) {
  if (!pulseEl) return;
  pulseEl.classList.remove("idle", "err");
  if (mode === "idle") pulseEl.classList.add("idle");
  else if (mode === "err") pulseEl.classList.add("err");
  if (pulseLabelEl && label) pulseLabelEl.textContent = label;
}

async function loadLandmarker() {
  setStatus("Loading face landmark model…");
  const vision = await FilesetResolver.forVisionTasks(WASM_URL);
  state.landmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: false,
    runningMode: "VIDEO",
    numFaces: 1,
  });
}

async function startCamera() {
  state.stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
    audio: false,
  });
  video.srcObject = state.stream;
  await video.play();
}

function stopCamera() {
  if (state.stream) {
    for (const t of state.stream.getTracks()) t.stop();
    state.stream = null;
  }
  video.srcObject = null;
}

function startKeepAlive() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    state.audioCtx = new Ctx();
    const osc = state.audioCtx.createOscillator();
    const gain = state.audioCtx.createGain();
    gain.gain.value = 0.0001;
    osc.connect(gain);
    gain.connect(state.audioCtx.destination);
    osc.start();
    state.audioOsc = osc;
  } catch {}
}

function stopKeepAlive() {
  try { state.audioOsc?.stop(); } catch {}
  try { state.audioCtx?.close(); } catch {}
  state.audioOsc = null;
  state.audioCtx = null;
}

function makeTickWorker() {
  const src = `
    let id = null;
    onmessage = (e) => {
      if (e.data && e.data.type === 'start') {
        clearInterval(id);
        id = setInterval(() => postMessage(0), e.data.interval || 40);
      } else if (e.data && e.data.type === 'stop') {
        clearInterval(id); id = null;
      }
    };
  `;
  const blob = new Blob([src], { type: "application/javascript" });
  return new Worker(URL.createObjectURL(blob));
}

function processFrame() {
  if (!state.landmarker || !state.stream) return;
  if (video.readyState < 2) return;
  const res = state.landmarker.detectForVideo(video, performance.now());
  const bs = res?.faceBlendshapes?.[0]?.categories;
  const hasFace = Array.isArray(bs) && bs.length > 0;
  const nowEpoch = Date.now();
  const autoPause = autoPauseChk.checked;

  if (hasFace) {
    state.lastFaceSeenAt = nowEpoch;
    if (state.paused) {
      if (!state.faceBackFirstSeenAt) state.faceBackFirstSeenAt = nowEpoch;
      if (nowEpoch - state.faceBackFirstSeenAt >= FACE_BACK_MS) {
        state.totalPausedMs += nowEpoch - state.pauseStartedAt;
        state.paused = false;
        state.faceBackFirstSeenAt = 0;
        state.eyesClosed = false;
        state.lastResumedAt = nowEpoch;
        state.activeSupprStart = null;
        setStatus("Resumed — face detected.");
        setPulse("live", "Live");
      } else {
        return;
      }
    }
  } else {
    state.faceBackFirstSeenAt = 0;
    if (autoPause && !state.paused && state.lastFaceSeenAt &&
        nowEpoch - state.lastFaceSeenAt > FACE_LOST_MS) {
      state.paused = true;
      state.pauseStartedAt = state.lastFaceSeenAt;
      state.eyesClosed = false;
      setStatus("Paused — no face detected.");
      setPulse("err", "Paused");
    }
    if (state.paused) return;
  }

  if (!hasFace) return;

  const left = bs.find((c) => c.categoryName === "eyeBlinkLeft")?.score ?? 0;
  const right = bs.find((c) => c.categoryName === "eyeBlinkRight")?.score ?? 0;
  const score = (left + right) / 2;
  const now = performance.now();
  if (!state.eyesClosed && score > BLINK_HIGH) {
    state.eyesClosed = true;
  } else if (state.eyesClosed && score < BLINK_LOW) {
    state.eyesClosed = false;
    if (now - state.lastBlinkAt > MIN_BLINK_GAP_MS) {
      state.lastBlinkAt = now;
      state.blinkTimes.push(nowEpoch);
      state.totalBlinks++;
    }
  }
}

function sample() {
  if (state.paused) return;
  const now = Date.now();
  const cutoff = now - BLINK_RETENTION_MS;
  while (state.blinkTimes.length && state.blinkTimes[0] < cutoff) state.blinkTimes.shift();

  const t60 = now - RATE_WINDOW_MS;
  let blinks60 = 0;
  for (const t of state.blinkTimes) if (t >= t60) blinks60++;
  const elapsedSec = Math.min((now - state.startedAt) / 1000, 60);
  const rate = elapsedSec > 0
    ? blinks60 * (60 / Math.max(elapsedSec, 1))
    : 0;

  state.rateHistory.push({ t: now, v: rate });
  const recent = state.rateHistory.slice(-VAR_WINDOW_SAMPLES).map((p) => p.v);
  const variation = stddev(recent);
  state.varHistory.push({ t: now, v: variation });

  checkNoBlinkAlert(now);
}

function checkNoBlinkAlert(now) {
  if (!state.startedAt) return;
  const sinceStart = now - state.startedAt;
  if (sinceStart < NO_BLINK_ALERT_GRACE_MS) return;
  if (state.lastResumedAt && now - state.lastResumedAt < NO_BLINK_ALERT_GRACE_MS) return;

  const lastBlinkEpoch = state.blinkTimes.length
    ? state.blinkTimes[state.blinkTimes.length - 1]
    : state.startedAt;
  const sinceBlink = now - lastBlinkEpoch;

  if (sinceBlink < NO_BLINK_ALERT_MS) {
    if (state.noBlinkAlertedAt && lastBlinkEpoch > state.noBlinkAlertedAt) {
      state.noBlinkAlertedAt = 0;
    }
    return;
  }
  if (state.noBlinkAlertedAt) return;

  playNoBlinkAlert();
  state.noBlinkAlertedAt = now;
  setStatus(`No blink detected for ${Math.round(sinceBlink / 1000)} s — remember to blink.`);
}

function playNoBlinkAlert() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const t0 = ctx.currentTime;
    const chime = (start, freq) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.18, start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.45);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.5);
    };
    chime(t0, 880);
    chime(t0 + 0.18, 1175);
    setTimeout(() => { try { ctx.close(); } catch {} }, 900);
  } catch (e) {
    console.warn("[blink alert] audio failed:", e);
  }
}

function stddev(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const s = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
  return Math.sqrt(s);
}

function fmtTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleString();
}

function activeElapsedMs() {
  const now = Date.now();
  const raw = now - state.startedAt;
  const currentPause = state.paused ? (now - state.pauseStartedAt) : 0;
  return Math.max(1, raw - state.totalPausedMs - currentPause);
}

function updateUI() {
  const activeMs = activeElapsedMs();
  const activeMin = activeMs / 60000;

  const now = Date.now();
  const t5 = now - UI_ROLLING_MS;
  let blinks5 = 0;
  for (const t of state.blinkTimes) if (t >= t5) blinks5++;
  const windowMin = Math.min(activeMin, UI_ROLLING_MS / 60000);
  const rate5m = windowMin > 0 ? blinks5 / windowMin : 0;

  const rateSession = state.totalBlinks / activeMin;
  const varSession = stddev(state.rateHistory.map((p) => p.v));

  rateVal.textContent = rate5m.toFixed(1);
  sessionRateVal.textContent = rateSession.toFixed(1);
  varVal.textContent = varSession.toFixed(2);
  totalVal.textContent = String(state.totalBlinks);
  sessionVal.textContent = fmtTime(activeMs) + (state.paused ? " · paused" : "");
  drawChart();
  drawPipCanvas(rate5m);

  // throttled cognitive update
  const now2 = Date.now();
  if (now2 - state.cogLastTick >= COG_TICK_MS) {
    state.cogLastTick = now2;
    updateCognitiveMetrics();
  }
}

function drawChart() {
  const dpr = window.devicePixelRatio || 1;
  const cssW = chart.clientWidth;
  const cssH = chart.clientHeight;
  if (chart.width !== cssW * dpr || chart.height !== cssH * dpr) {
    chart.width = cssW * dpr;
    chart.height = cssH * dpr;
  }
  const ctx = chart.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const pad = { l: 40, r: 12, t: 12, b: 22 };
  const w = cssW - pad.l - pad.r;
  const h = cssH - pad.t - pad.b;

  ctx.strokeStyle = "rgba(249, 214, 232, 0.12)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(pad.l, pad.t, w, h);
  ctx.stroke();

  const now = Date.now();
  const cutoff = now - CHART_WINDOW_MS;
  const rates = state.rateHistory.filter((p) => p.t >= cutoff);
  const vars = state.varHistory.filter((p) => p.t >= cutoff);

  const rateMaxData = Math.max(20, ...rates.map((p) => p.v));
  const rateMax = Math.ceil(rateMaxData / 5) * 5;
  const varMaxData = Math.max(5, ...vars.map((p) => p.v));
  const varMax = Math.ceil(varMaxData);

  ctx.fillStyle = "#8f7a8b";
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (h * i) / 4;
    const v = rateMax * (1 - i / 4);
    ctx.fillText(v.toFixed(0), pad.l - 6, y);
    ctx.strokeStyle = "rgba(249, 214, 232, 0.06)";
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + w, y);
    ctx.stroke();
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let s = 0; s <= 120; s += 30) {
    const x = pad.l + w * (1 - s / 120);
    ctx.fillText(`-${s}s`, x, pad.t + h + 4);
  }

  const toX = (t) => pad.l + w * (1 - (now - t) / CHART_WINDOW_MS);
  const toYRate = (v) => pad.t + h * (1 - Math.min(v, rateMax) / rateMax);
  const toYVar = (v) => pad.t + h * (1 - Math.min(v, varMax) / Math.max(varMax, 1));

  const drawLine = (pts, color, shadow, toY) => {
    if (pts.length < 2) return;
    ctx.save();
    ctx.shadowColor = shadow;
    ctx.shadowBlur = 12;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = toX(p.t), y = toY(p.v);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();
  };

  drawLine(rates, "#f4b4c7", "rgba(244,180,199,0.5)", toYRate);
  drawLine(vars,  "#8ed8ff", "rgba(142,216,255,0.4)", toYVar);
}

function drawPipCanvas(rate) {
  const ctx = pipCanvas.getContext("2d");
  const W = pipCanvas.width, H = pipCanvas.height;

  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#140e1d");
  bg.addColorStop(1, "#0a0810");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = "#c9b7c6";
  ctx.font = "20px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText("Blink rate", W / 2, 18);

  const iri = ctx.createLinearGradient(0, 50, W, 170);
  iri.addColorStop(0.0, "#ffd4e4");
  iri.addColorStop(0.3, "#c9a6ff");
  iri.addColorStop(0.65, "#8ed8ff");
  iri.addColorStop(1.0, "#a8f0d4");
  ctx.fillStyle = iri;
  ctx.font = "bold 120px system-ui, sans-serif";
  ctx.fillText(rate.toFixed(1), W / 2, 50);

  ctx.fillStyle = "#8f7a8b";
  ctx.font = "18px system-ui, sans-serif";
  ctx.fillText("blink / min", W / 2, 190);

  const pad = 30;
  const top = 230;
  const h = H - top - 20;
  const w = W - 2 * pad;
  ctx.strokeStyle = "rgba(249, 214, 232, 0.12)";
  ctx.lineWidth = 1;
  ctx.strokeRect(pad, top, w, h);

  const now = Date.now();
  const cutoff = now - CHART_WINDOW_MS;
  const pts = state.rateHistory.filter((p) => p.t >= cutoff);
  const rateMax = Math.max(20, ...pts.map((p) => p.v));
  if (pts.length > 1) {
    ctx.save();
    ctx.shadowColor = "rgba(244,180,199,0.5)";
    ctx.shadowBlur = 14;
    ctx.strokeStyle = "#f4b4c7";
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = pad + w * (1 - (now - p.t) / CHART_WINDOW_MS);
      const y = top + h * (1 - Math.min(p.v, rateMax) / rateMax);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();
  }
}

async function toggleWakeLock() {
  if (state.wakeLock) {
    try { await state.wakeLock.release(); } catch {}
    state.wakeLock = null;
    wakeBtn.setAttribute("aria-pressed", "false");
    setStatus("Screen wake lock disabled.");
    return;
  }
  if (!("wakeLock" in navigator)) {
    setStatus("Wake Lock not supported by this browser.", true);
    return;
  }
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener("release", () => {
      wakeBtn.setAttribute("aria-pressed", "false");
    });
    wakeBtn.setAttribute("aria-pressed", "true");
    setStatus("Screen kept awake.");
  } catch (e) {
    setStatus("Wake lock failed: " + e.message, true);
  }
}

async function togglePip() {
  if (document.pictureInPictureElement) {
    await document.exitPictureInPicture();
    return;
  }
  try {
    state.pipStream = pipCanvas.captureStream(8);
    const pipVideo = document.createElement("video");
    pipVideo.srcObject = state.pipStream;
    pipVideo.muted = true;
    pipVideo.playsInline = true;
    await pipVideo.play();
    await pipVideo.requestPictureInPicture();
    pipVideo.addEventListener("leavepictureinpicture", () => {
      pipVideo.srcObject = null;
    });
    state.pipVideo = pipVideo;
  } catch (e) {
    setStatus("Picture-in-Picture not available: " + e.message, true);
  }
}

function loadSessions() {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveSessions(list) {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(list));
    return true;
  } catch (e) {
    // Likely QuotaExceededError. Try shedding old samples to make room.
    if (e?.name === "QuotaExceededError" || /quota/i.test(e?.message || "")) {
      try {
        const trimmed = list.map((s, i) => i === 0 ? s : { ...s, samples: [], cogSamples: [], blinkTimes: [] });
        localStorage.setItem(SESSIONS_KEY, JSON.stringify(trimmed));
        setStatus("Storage was full — older session detail discarded to keep today's report.", true);
        return true;
      } catch (e2) {
        setStatus("Storage full: today's session could not be saved. Use 'Clear all' to free space. (" + e2.message + ")", true);
        return false;
      }
    }
    setStatus("Unable to save to localStorage: " + e.message, true);
    return false;
  }
}

function buildSessionSnapshot({ live = false } = {}) {
  if (!state.startedAt) return null;
  const endedAt = Date.now();
  const durationMs = endedAt - state.startedAt;
  // Drop only truly empty sessions (under a second AND no blinks AND no samples)
  if (durationMs < 1000 && state.totalBlinks === 0 && state.rateHistory.length === 0) {
    return null;
  }
  const rates = state.rateHistory.map((p) => p.v);
  const avg = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;
  return {
    id: "s_" + state.startedAt,
    startedAt: state.startedAt,
    endedAt,
    durationMs,
    totalBlinks: state.totalBlinks,
    avgRate: avg,
    samples: state.rateHistory.map((p, i) => ({
      t: p.t,
      rate: p.v,
      variation: state.varHistory[i]?.v ?? 0,
    })),
    cogSamples: state.cogHistory.slice(),
    blinkTimes: state.blinkTimes.slice(),
    live,
  };
}

function persistCurrentSession() {
  const session = buildSessionSnapshot({ live: false });
  if (!session) {
    console.warn("[persist] skipped — no session snapshot (startedAt or duration empty)");
    return null;
  }
  const sessions = loadSessions();
  // Replace any earlier snapshot of the same start so we don't keep duplicates
  const filtered = sessions.filter(s => s.id !== session.id);
  filtered.unshift(session);
  while (filtered.length > MAX_STORED_SESSIONS) filtered.pop();
  const ok = saveSessions(filtered);
  if (!ok) {
    console.error("[persist] saveSessions failed — today's session not stored");
    return null;
  }
  console.log("[persist] saved session", session.id, "totalBlinks=", session.totalBlinks, "duration=", session.durationMs);
  return session;
}

function sessionToCSV(s) {
  const lines = [];
  lines.push(`# session_id,${s.id}`);
  lines.push(`# started_at,${new Date(s.startedAt).toISOString()}`);
  lines.push(`# ended_at,${new Date(s.endedAt).toISOString()}`);
  lines.push(`# duration_seconds,${(s.durationMs / 1000).toFixed(1)}`);
  lines.push(`# total_blinks,${s.totalBlinks}`);
  lines.push(`# avg_rate_per_min,${s.avgRate.toFixed(3)}`);
  lines.push("timestamp_iso,epoch_ms,rate_per_min,variation_sigma");
  for (const p of s.samples) {
    lines.push(`${new Date(p.t).toISOString()},${p.t},${p.rate.toFixed(3)},${p.variation.toFixed(3)}`);
  }
  return lines.join("\n");
}

function reportToCSV(s) {
  const rates = s.samples.map((p) => p.rate ?? 0);
  const sd = stddev(rates);
  const xs = s.samples.map((_, i) => i);
  const { slope } = linReg(xs, rates);
  const slopePerMin = slope * (60000 / SAMPLE_INTERVAL_MS);
  const cs = cogStats(s);

  const lines = [];
  lines.push("# ===== BLINK RATE SESSION REPORT =====");
  lines.push(`# session_id,${s.id}`);
  lines.push(`# started_at,${new Date(s.startedAt).toISOString()}`);
  lines.push(`# ended_at,${new Date(s.endedAt).toISOString()}`);
  lines.push(`# duration_seconds,${(s.durationMs / 1000).toFixed(1)}`);
  lines.push(`# total_blinks,${s.totalBlinks}`);
  lines.push(`# avg_rate_per_min,${s.avgRate.toFixed(3)}`);
  lines.push(`# std_dev_sigma,${sd.toFixed(3)}`);
  lines.push(`# rate_slope_per_min,${slopePerMin.toFixed(3)}`);
  if (cs.ready) {
    lines.push(`# focus_depth_avg,${cs.fdAvg.toFixed(2)}`);
    lines.push(`# focus_depth_slope_per_min,${cs.fdSlopePerMin.toFixed(3)}`);
    lines.push(`# cognitive_fatigue_avg,${cs.cfAvg.toFixed(2)}`);
    lines.push(`# cognitive_fatigue_slope_per_min,${cs.cfSlopePerMin.toFixed(3)}`);
    lines.push(`# cognitive_samples_usable,${cs.count}`);
  } else {
    lines.push(`# focus_depth_avg,`);
    lines.push(`# cognitive_fatigue_avg,`);
    lines.push(`# cognitive_samples_usable,${cs.count}`);
    lines.push(`# note,insufficient_cognitive_data`);
  }
  lines.push("");
  lines.push("# ----- Rate time series (per sample) -----");
  lines.push("timestamp_iso,epoch_ms,rate_per_min,variation_sigma");
  for (const p of s.samples) {
    lines.push(`${new Date(p.t).toISOString()},${p.t},${(p.rate ?? 0).toFixed(3)},${(p.variation ?? 0).toFixed(3)}`);
  }
  lines.push("");
  lines.push("# ----- Cognitive time series (per cognitive tick) -----");
  lines.push("timestamp_iso,epoch_ms,focus_depth,cognitive_fatigue,fd_confidence,cf_confidence,state");
  const cog = s.cogSamples || [];
  for (const c of cog) {
    lines.push([
      new Date(c.t).toISOString(),
      c.t,
      Number.isFinite(c.fd) ? c.fd : "",
      Number.isFinite(c.cf) ? c.cf : "",
      (c.fdConf ?? 0).toFixed(3),
      (c.cfConf ?? 0).toFixed(3),
      c.st ?? "",
    ].join(","));
  }
  return lines.join("\n");
}

function downloadText(filename, text, mime = "text/csv") {
  const blob = new Blob([text], { type: mime + ";charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function sessionFilename(s) {
  const d = new Date(s.startedAt);
  const pad = (n) => String(n).padStart(2, "0");
  return `blink-session-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.csv`;
}

function downloadSession(s) {
  downloadText(sessionFilename(s), sessionToCSV(s));
}

function exportAllSessions() {
  const sessions = loadSessions();
  if (!sessions.length) {
    setStatus("No saved sessions.", true);
    return;
  }
  const lines = [
    "session_id,day,started_at,ended_at,duration_seconds,total_blinks,avg_rate_per_min,class,event_label",
  ];
  for (const s of sessions) {
    const cls = s.tag?.class || "";
    const lbl = (s.tag?.label || "").replace(/[",\n]/g, " ");
    lines.push([
      s.id,
      dayKey(s.startedAt),
      new Date(s.startedAt).toISOString(),
      new Date(s.endedAt).toISOString(),
      (s.durationMs / 1000).toFixed(1),
      s.totalBlinks,
      s.avgRate.toFixed(3),
      cls,
      lbl,
    ].join(","));
  }
  downloadText("blink-database.csv", lines.join("\n"));
}

function deleteSession(id) {
  const list = loadSessions().filter((s) => s.id !== id);
  saveSessions(list);
  renderSessions();
  renderCalendarEvents();
}

function clearAllSessions() {
  if (!confirm("Delete all saved sessions?")) return;
  localStorage.removeItem(SESSIONS_KEY);
  renderSessions();
  renderCalendarEvents();
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return { r: NaN, n };
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const ex = xs[i] - mx, ey = ys[i] - my;
    num += ex * ey;
    dx  += ex * ex;
    dy  += ey * ey;
  }
  const denom = Math.sqrt(dx * dy);
  if (denom < 1e-9) return { r: NaN, n };
  return { r: num / denom, n };
}

function corrClass(r) {
  if (!isFinite(r)) return "weak";
  const a = Math.abs(r);
  if (a < 0.2) return "weak";
  if (r > 0)   return a >= 0.5 ? "pos-strong" : "pos-mod";
  return a >= 0.5 ? "neg-strong" : "neg-mod";
}

function recoveryByDay() {
  const map = new Map();
  for (const r of loadWhoopRecovery()) map.set(r.date, r);
  return map;
}

function sessionPhysiologyDataset() {
  // Build (session, recovery) pairs across all stored sessions for the dates
  // we have WHOOP data for. Used to compute cross-day correlations.
  const byDay = recoveryByDay();
  const sessions = loadSessions();
  const rows = [];
  for (const s of sessions) {
    const k = dayKey(s.startedAt);
    const rec = byDay.get(k);
    if (!rec || rec.hrv_ms == null || rec.resting_hr == null) continue;
    const samples = (s.samples || []);
    const cog = (s.cogSamples || []);
    if (samples.length === 0 && cog.length === 0) continue;
    const fd = cog.length ? cog.reduce((a, c) => a + (c.fd ?? 0), 0) / cog.length : null;
    const cf = cog.length ? cog.reduce((a, c) => a + (c.cf ?? 0), 0) / cog.length : null;
    const sigma = samples.length ? stddev(samples.map(p => p.rate ?? p.v ?? 0)) : null;
    rows.push({
      day: k,
      avgRate: s.avgRate ?? 0,
      sigma,
      fd, cf,
      hrv: rec.hrv_ms,
      rhr: rec.resting_hr,
      recovery: rec.recovery_score,
    });
  }
  return rows;
}

function whoopBaseline(records, field) {
  const vals = records.map(r => r[field]).filter(v => v != null && isFinite(v));
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length / 2)];
}

function renderPhysiologyBlock(session) {
  if (!reportPhysio) return;
  if (!isWhoopConnectedCached() && loadWhoopRecovery().length === 0) {
    reportPhysio.hidden = true;
    return;
  }
  const records = loadWhoopRecovery();
  if (records.length === 0) {
    reportPhysio.hidden = true;
    return;
  }
  reportPhysio.hidden = false;

  const sessionDay = dayKey(session.startedAt);
  const todayRec = records.find(r => r.date === sessionDay);
  const hrvBaseline = whoopBaseline(records, "hrv_ms");
  const rhrBaseline = whoopBaseline(records, "resting_hr");
  const recBaseline = whoopBaseline(records, "recovery_score");

  // Header subtitle
  if (physioSub) {
    physioSub.textContent = todayRec
      ? `Recovery for ${sessionDay}`
      : `No WHOOP data for ${sessionDay} — using baseline only`;
  }

  // KPI cards
  const kpis = [];
  const fmtDelta = (val, base, unit, betterHigh) => {
    if (val == null || base == null) return "";
    const d = val - base;
    const dir = d > 0 ? "↑" : d < 0 ? "↓" : "→";
    const tone = (d > 0 && betterHigh) || (d < 0 && !betterHigh) ? "good" : "warn";
    const pct = base ? Math.round((d / base) * 100) : 0;
    return `<div class="physio-kpi-sub" data-tone="${tone}">${dir} ${Math.abs(pct)}% vs ${base.toFixed(0)} ${unit} baseline</div>`;
  };
  if (todayRec) {
    if (todayRec.hrv_ms != null) {
      kpis.push(`
        <div class="physio-kpi">
          <div class="physio-kpi-label">HRV (RMSSD)</div>
          <div class="physio-kpi-value">${todayRec.hrv_ms.toFixed(0)}<span class="physio-kpi-unit">ms</span></div>
          ${fmtDelta(todayRec.hrv_ms, hrvBaseline, "ms", true)}
        </div>`);
    }
    if (todayRec.resting_hr != null) {
      kpis.push(`
        <div class="physio-kpi">
          <div class="physio-kpi-label">Resting HR</div>
          <div class="physio-kpi-value">${todayRec.resting_hr.toFixed(0)}<span class="physio-kpi-unit">bpm</span></div>
          ${fmtDelta(todayRec.resting_hr, rhrBaseline, "bpm", false)}
        </div>`);
    }
    if (todayRec.recovery_score != null) {
      kpis.push(`
        <div class="physio-kpi">
          <div class="physio-kpi-label">Recovery</div>
          <div class="physio-kpi-value">${todayRec.recovery_score.toFixed(0)}<span class="physio-kpi-unit">/100</span></div>
          ${fmtDelta(todayRec.recovery_score, recBaseline, "%", true)}
        </div>`);
    }
  }
  if (!kpis.length && hrvBaseline != null) {
    kpis.push(`
      <div class="physio-kpi">
        <div class="physio-kpi-label">HRV baseline</div>
        <div class="physio-kpi-value">${hrvBaseline.toFixed(0)}<span class="physio-kpi-unit">ms</span></div>
      </div>`);
  }
  physioKpis.innerHTML = kpis.join("");

  // Cross-day correlations
  const ds = sessionPhysiologyDataset();
  const pairs = [
    ["Blink rate", "HRV",      ds.map(d => d.avgRate),  ds.map(d => d.hrv)],
    ["Blink rate", "Resting HR", ds.map(d => d.avgRate), ds.map(d => d.rhr)],
    ["Blink rate", "Recovery",  ds.map(d => d.avgRate),  ds.map(d => d.recovery)],
    ["Focus Depth", "HRV",      ds.filter(d => d.fd != null).map(d => d.fd), ds.filter(d => d.fd != null).map(d => d.hrv)],
    ["Focus Depth", "Recovery", ds.filter(d => d.fd != null).map(d => d.fd), ds.filter(d => d.fd != null).map(d => d.recovery)],
    ["Cog Fatigue", "HRV",      ds.filter(d => d.cf != null).map(d => d.cf), ds.filter(d => d.cf != null).map(d => d.hrv)],
    ["Cog Fatigue", "Recovery", ds.filter(d => d.cf != null).map(d => d.cf), ds.filter(d => d.cf != null).map(d => d.recovery)],
  ];
  const rows = pairs
    .map(([a, b, xs, ys]) => ({ a, b, ...pearson(xs, ys) }))
    .filter(p => isFinite(p.r));

  if (rows.length === 0) {
    physioCorr.innerHTML = "";
    physioNote.textContent = ds.length < 3
      ? `Need at least 3 sessions on days with WHOOP data to compute correlations (have ${ds.length}).`
      : "No usable correlations yet.";
  } else {
    physioCorr.innerHTML = rows.map(p => `
      <div class="physio-corr-row">
        <span class="physio-corr-pair">${p.a} ↔ ${p.b}</span>
        <span class="physio-corr-r ${corrClass(p.r)}">r = ${p.r.toFixed(2)} <small style="opacity:0.6">(n=${p.n})</small></span>
      </div>
    `).join("");
    const strong = rows.filter(p => Math.abs(p.r) >= 0.5);
    if (strong.length) {
      const top = strong.sort((a, b) => Math.abs(b.r) - Math.abs(a.r))[0];
      const dir = top.r > 0 ? "rises" : "falls";
      physioNote.textContent = `Strongest pattern across ${top.n} session-days: ${top.a} ${dir} when ${top.b} increases (r = ${top.r.toFixed(2)}).`;
    } else {
      physioNote.textContent = `Correlations across ${ds.length} session-days are weak (|r| < 0.5). Need more sessions across varied recovery states for clearer patterns.`;
    }
  }
}

function fmtDayLabel(ts) {
  const day = startOfDay(ts);
  const today = startOfDay(Date.now());
  const diffDays = Math.round((today - day) / (24 * 3600 * 1000));
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return new Date(day).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

function groupSessionsByDay(sessions) {
  const map = new Map();
  for (const s of sessions) {
    const k = dayKey(s.startedAt);
    if (!map.has(k)) map.set(k, { key: k, dayStart: startOfDay(s.startedAt), sessions: [] });
    map.get(k).sessions.push(s);
  }
  const out = [...map.values()];
  out.sort((a, b) => b.dayStart - a.dayStart);
  for (const g of out) g.sessions.sort((a, b) => a.startedAt - b.startedAt);
  return out;
}

function aggregateDay(group) {
  const sessions = group.sessions;
  const samples = sessions.flatMap(s => (s.samples || []).map(p => ({
    t: p.t,
    rate: p.rate ?? p.v ?? 0,
    variation: p.variation ?? 0,
  }))).sort((a, b) => a.t - b.t);
  const cogSamples = sessions.flatMap(s => s.cogSamples || []).sort((a, b) => a.t - b.t);
  const totalBlinks = sessions.reduce((a, s) => a + (s.totalBlinks || 0), 0);
  const durationMs = sessions.reduce((a, s) => a + (s.durationMs || 0), 0);
  const startedAt = sessions[0]?.startedAt || group.dayStart;
  const endedAt = sessions[sessions.length - 1]?.endedAt || (startedAt + durationMs);
  const avgRate = samples.length ? samples.reduce((a, p) => a + p.rate, 0) / samples.length : 0;
  return {
    id: "day_" + group.key,
    dayKey: group.key,
    startedAt, endedAt, durationMs, totalBlinks, avgRate,
    samples, cogSamples,
    sessionCount: sessions.length,
    childIds: sessions.map(s => s.id),
    aggregated: true,
  };
}

function renderSessions() {
  const sessions = loadSessions();
  sessionList.innerHTML = "";
  if (!sessions.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No sessions recorded yet.";
    sessionList.appendChild(empty);
    return;
  }
  const days = groupSessionsByDay(sessions);
  for (const g of days) {
    const dayAgg = aggregateDay(g);
    const row = document.createElement("div");
    row.className = "day-row";
    row.tabIndex = 0;
    row.setAttribute("role", "button");

    const info = document.createElement("div");
    info.className = "day-info";
    info.innerHTML = `
      <div class="d-date">${fmtDayLabel(g.dayStart)}</div>
      <div class="d-meta">
        ${dayAgg.sessionCount} session${dayAgg.sessionCount === 1 ? "" : "s"} ·
        ${fmtTime(dayAgg.durationMs)} total ·
        ${dayAgg.totalBlinks} blinks ·
        avg ${dayAgg.avgRate.toFixed(1)}/min
      </div>
    `;

    const actions = document.createElement("div");
    actions.className = "day-actions";
    const open = document.createElement("button");
    open.textContent = "Open report";
    open.className = "day-open";
    open.addEventListener("click", (e) => {
      e.stopPropagation();
      generateReport(dayAgg);
    });
    const del = document.createElement("button");
    del.textContent = "Delete";
    del.className = "danger";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!confirm(`Delete all ${dayAgg.sessionCount} session(s) from ${fmtDayLabel(g.dayStart)}?`)) return;
      const childSet = new Set(dayAgg.childIds);
      const remaining = loadSessions().filter(s => !childSet.has(s.id));
      saveSessions(remaining);
      renderSessions();
      renderCalendarEvents();
    });
    actions.appendChild(open);
    actions.appendChild(del);

    row.appendChild(info);
    row.appendChild(actions);
    row.addEventListener("click", () => generateReport(dayAgg));
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        generateReport(dayAgg);
      }
    });
    sessionList.appendChild(row);
  }
}

async function start() {
  toggleBtn.disabled = true;
  try {
    if (!state.landmarker) await loadLandmarker();
    await startCamera();
  } catch (e) {
    setStatus("Unable to start: " + e.message, true);
    toggleBtn.disabled = false;
    return;
  }
  state.startedAt = Date.now();
  state.blinkTimes = [];
  state.rateHistory = [];
  state.varHistory = [];
  state.totalBlinks = 0;
  state.eyesClosed = false;
  state.lastBlinkAt = 0;
  state.noBlinkAlertedAt = 0;
  state.paused = false;
  state.lastFaceSeenAt = Date.now();
  state.faceBackFirstSeenAt = 0;
  state.pauseStartedAt = 0;
  state.totalPausedMs = 0;
  // reset cognitive state
  state.cogB_session = null;
  state.cogB_session_ready = false;
  state.cogB_session_samples = [];
  state.cogLastTick = 0;
  state.cogFD = 0;
  state.cogCF = 0;
  state.cogFD_conf = 0;
  state.cogCF_conf = 0;
  state.cogStateLabel = "calib";
  state.cogHistory = [];
  state.lastResumedAt = 0;
  state.activeSupprStart = null;
  state.suppressionEps = [];
  state.reboundBursts = [];
  state.rateSlopeSession = 0;
  // load persisted user baseline
  const bl = loadUserBaseline();
  if (bl) { state.cogB_user = bl.B_user; }
  resetCognitiveUI();

  startKeepAlive();
  state.tickWorker = makeTickWorker();
  state.tickWorker.onmessage = () => processFrame();
  state.tickWorker.postMessage({ type: "start", interval: TICK_INTERVAL_MS });

  state.sampleTimer = setInterval(sample, SAMPLE_INTERVAL_MS);
  state.uiTimer = setInterval(updateUI, 250);
  state.reportDismissed = false;
  state.liveReportTimer = setInterval(() => {
    const snap = buildSessionSnapshot({ live: true });
    if (snap) generateReport(snap);
  }, LIVE_REPORT_INTERVAL_MS);

  toggleBtn.disabled = false;
  toggleBtn.textContent = "Stop";
  toggleBtn.dataset.state = "running";
  pipBtn.disabled = !("pictureInPictureEnabled" in document) || !document.pictureInPictureEnabled;
  setStatus("Running — detection continues even when you switch tabs.");
  setPulse("live", "Live");
}

function stop() {
  if (state.tickWorker) {
    try { state.tickWorker.postMessage({ type: "stop" }); } catch {}
    state.tickWorker.terminate();
    state.tickWorker = null;
  }
  if (state.sampleTimer) clearInterval(state.sampleTimer);
  if (state.uiTimer) clearInterval(state.uiTimer);
  if (state.liveReportTimer) clearInterval(state.liveReportTimer);
  state.sampleTimer = state.uiTimer = state.liveReportTimer = null;
  stopKeepAlive();
  const saved = persistCurrentSession();
  // update multi-session baseline
  if (state.rateHistory.length >= 10) {
    const rates = state.rateHistory.map(p => p.v).sort((a, b) => a - b);
    const sessionMedian = rates[Math.floor(rates.length / 2)];
    const bl = loadUserBaseline() || { B_user: 15, sessions: 0 };
    bl.B_user = Math.round((0.7 * bl.B_user + 0.3 * sessionMedian) * 100) / 100;
    bl.sessions = (bl.sessions || 0) + 1;
    saveUserBaseline(bl);
  }
  stopCamera();
  if (saved) {
    setStatus(`Session saved (${saved.totalBlinks} blinks in ${fmtTime(saved.durationMs)}).`);
    generateReport(saved);
  } else {
    setStatus("Stopped.");
  }
  toggleBtn.disabled = false;
  toggleBtn.textContent = "Start";
  toggleBtn.dataset.state = "idle";
  pipBtn.disabled = true;
  setPulse("idle", "Idle");
  resetCognitiveUI();
  autoMatchSessionsToEvents();
  renderSessions();
  renderCalendarEvents();
}

previewChk.addEventListener("change", () => {
  videoWrap.hidden = !previewChk.checked;
});
autoPauseChk.addEventListener("change", () => {
  if (!autoPauseChk.checked && state.paused) {
    state.totalPausedMs += Date.now() - state.pauseStartedAt;
    state.paused = false;
    state.faceBackFirstSeenAt = 0;
    state.eyesClosed = false;
    state.lastResumedAt = Date.now();
    state.activeSupprStart = null;
    setStatus("Auto-pause disabled — resumed.");
    setPulse("live", "Live");
  }
});
toggleBtn.addEventListener("click", () => {
  if (toggleBtn.dataset.state === "running") {
    stop();
  } else {
    start();
  }
});
pipBtn.addEventListener("click", togglePip);
wakeBtn.addEventListener("click", toggleWakeLock);
exportBtn.addEventListener("click", exportAllSessions);
clearBtn.addEventListener("click", clearAllSessions);

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && state.wakeLock === null && wakeBtn.getAttribute("aria-pressed") === "true") {
    try { state.wakeLock = await navigator.wakeLock.request("screen"); } catch {}
  }
});

window.addEventListener("beforeunload", () => {
  if (state.startedAt && state.rateHistory.length > 0 && state.tickWorker) {
    persistCurrentSession();
  }
});

renderSessions();

el("closeReportBtn").addEventListener("click", () => {
  reportSection.hidden = true;
  if (state.startedAt) state.reportDismissed = true;
});

exportReportBtn?.addEventListener("click", () => {
  if (!currentReportSession) {
    setStatus("No report available to export.", true);
    return;
  }
  const csv = reportToCSV(currentReportSession);
  const ts = new Date(currentReportSession.startedAt).toISOString().replace(/[:.]/g, "-");
  downloadText(`blink-report-${ts}.csv`, csv);
});

/* ── Session report ── */

function linReg(xs, ys) {
  const n = xs.length;
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((a, x, i) => a + x * ys[i], 0);
  const sumX2 = xs.reduce((a, x) => a + x * x, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: sumY / n };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

function cogStats(session) {
  const cog = (session.cogSamples || []).filter(c =>
    Number.isFinite(c.fd) && Number.isFinite(c.cf) && (c.fdConf ?? 0) >= 0.35
  );
  if (cog.length < 3) {
    return { ready: false, fdAvg: null, cfAvg: null, fdSlopePerMin: 0, cfSlopePerMin: 0, count: cog.length };
  }
  const fdVals = cog.map(c => c.fd);
  const cfVals = cog.map(c => c.cf);
  const fdAvg = fdVals.reduce((a, b) => a + b, 0) / fdVals.length;
  const cfAvg = cfVals.reduce((a, b) => a + b, 0) / cfVals.length;
  const t0 = cog[0].t;
  const xs = cog.map(c => (c.t - t0) / 60000); // minutes
  const fdReg = linReg(xs, fdVals);
  const cfReg = linReg(xs, cfVals);
  return {
    ready: true,
    fdAvg, cfAvg,
    fdSlopePerMin: fdReg.slope,
    cfSlopePerMin: cfReg.slope,
    fdReg, cfReg,
    count: cog.length,
  };
}

function trendTxt(slopePerMin, unit = "") {
  const s = slopePerMin;
  const abs = Math.abs(s);
  if (abs < 0.3) return `→ stable (${s >= 0 ? "+" : ""}${s.toFixed(2)}${unit}/min)`;
  if (s > 0) return `↑ +${s.toFixed(2)}${unit}/min`;
  return `↓ ${s.toFixed(2)}${unit}/min`;
}

function generateReport(session, opts = {}) {
  if (!session || session.samples.length < 4) return;
  const isLive = !!session.live;
  const wasHidden = reportSection.hidden;
  // If user explicitly closed the report during this live session, don't reopen.
  if (isLive && state.reportDismissed) return;

  currentReportSession = session;

  const samples = session.samples;
  const rates = samples.map((s) => s.rate ?? s.v ?? 0);
  const n = rates.length;
  const avg = rates.reduce((a, b) => a + b, 0) / n;
  const minRate = Math.min(...rates);
  const maxRate = Math.max(...rates);
  const sd = stddev(rates);

  const xs = samples.map((_, i) => i);
  const { slope, intercept } = linReg(xs, rates);
  const slopePerMin = slope * (60000 / SAMPLE_INTERVAL_MS);

  repDuration.textContent = fmtTime(session.durationMs);
  repTotal.textContent = String(session.totalBlinks);
  repAvgRate.textContent = avg.toFixed(1);
  repVar.textContent = sd.toFixed(2) + " σ";

  const trendLabel =
    slopePerMin > 0.4 ? `↑ +${slopePerMin.toFixed(1)}/min` :
    slopePerMin < -0.4 ? `↓ ${slopePerMin.toFixed(1)}/min` : "→ stable";
  repTrend.textContent = trendLabel;
  reportDate.textContent = fmtDate(session.startedAt);

  const cs = cogStats(session);
  if (cs.ready) {
    repFdAvg.textContent = cs.fdAvg.toFixed(0);
    repCfAvg.textContent = cs.cfAvg.toFixed(0);
    repFdTrend.textContent = trendTxt(cs.fdSlopePerMin, " pt");
    repCfTrend.textContent = trendTxt(cs.cfSlopePerMin, " pt");
  } else {
    repFdAvg.textContent = "—";
    repCfAvg.textContent = "—";
    repFdTrend.textContent = "insufficient data";
    repCfTrend.textContent = "insufficient data";
  }

  const peakIdx   = rates.indexOf(maxRate);
  const valleyIdx = rates.indexOf(minRate);
  const peakMin   = ((samples[peakIdx].t - session.startedAt) / 60000).toFixed(1);
  const valleyMin = ((samples[valleyIdx].t - session.startedAt) / 60000).toFixed(1);

  const analysisCards = [
    buildFocusCard(avg),
    buildTrendCard(slopePerMin),
    buildVarCard(sd),
    buildPeaksCard(minRate, maxRate, valleyMin, peakMin),
    buildEyeHealthCard(avg, sd),
  ];
  if (cs.ready) {
    analysisCards.push(buildFocusDepthCard(cs.fdAvg, cs.fdSlopePerMin));
    analysisCards.push(buildCognitiveFatigueCard(cs.cfAvg, cs.cfSlopePerMin));
  } else {
    analysisCards.push(buildCogInsufficientCard());
  }
  reportAnalysis.innerHTML = analysisCards.join("");

  renderPhysiologyBlock(session);

  reportSection.hidden = false;
  reportSection.dataset.mode = isLive ? "live" : "final";
  const liveBadge = el("liveReportBadge");
  if (liveBadge) liveBadge.hidden = !isLive;
  requestAnimationFrame(() => {
    drawReportChart(session, rates, slope, intercept);
    if (wasHidden) {
      reportSection.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
}

function drawReportChart(session, rates, slope, intercept) {
  const canvas = document.getElementById("reportChart");
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = 260;
  canvas.width  = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const pad = { l: 44, r: 16, t: 20, b: 30 };
  const W = cssW - pad.l - pad.r;
  const H = cssH - pad.t - pad.b;
  const n = rates.length;
  const rateMax = Math.ceil(Math.max(22, ...rates) / 5) * 5;
  const samples = session.samples;

  const toX = (i) => pad.l + W * (i / Math.max(n - 1, 1));
  const toY = (v) => pad.t + H * (1 - Math.min(Math.max(v, 0), rateMax) / rateMax);

  ctx.strokeStyle = "rgba(249,214,232,0.12)";
  ctx.lineWidth = 1;
  ctx.strokeRect(pad.l, pad.t, W, H);

  ctx.fillStyle = "#8f7a8b";
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + H * i / 4;
    ctx.fillText((rateMax * (1 - i / 4)).toFixed(0), pad.l - 8, y);
    ctx.strokeStyle = "rgba(249,214,232,0.06)";
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + W, y); ctx.stroke();
  }

  const y20 = toY(Math.min(20, rateMax));
  const y12 = toY(12);
  ctx.fillStyle = "rgba(127,185,139,0.07)";
  ctx.fillRect(pad.l, y20, W, y12 - y20);
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = "rgba(127,185,139,0.22)";
  ctx.lineWidth = 1;
  [12, 20].forEach((v) => {
    if (v <= rateMax) {
      ctx.beginPath(); ctx.moveTo(pad.l, toY(v)); ctx.lineTo(pad.l + W, toY(v)); ctx.stroke();
    }
  });
  ctx.setLineDash([]);

  const totalMin = session.durationMs / 60000;
  const mStep = totalMin > 15 ? 5 : totalMin > 5 ? 2 : 1;
  ctx.fillStyle = "#8f7a8b";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let m = 0; m <= Math.ceil(totalMin); m += mStep) {
    const frac = m / Math.max(totalMin, 0.001);
    if (frac <= 1.01) ctx.fillText(m + "m", pad.l + W * frac, pad.t + H + 6);
  }

  if (n > 1) {
    ctx.save();
    ctx.shadowColor = "rgba(244,180,199,0.45)";
    ctx.shadowBlur = 10;
    ctx.strokeStyle = "#f4b4c7";
    ctx.lineWidth = 2.2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    rates.forEach((v, i) => { i === 0 ? ctx.moveTo(toX(i), toY(v)) : ctx.lineTo(toX(i), toY(v)); });
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = "rgba(201,166,255,0.75)";
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 5]);
    ctx.beginPath();
    ctx.moveTo(toX(0),     toY(intercept));
    ctx.lineTo(toX(n - 1), toY(slope * (n - 1) + intercept));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }
}

function anaCard(dotClass, title, body) {
  return `<div class="ana-card">
    <div class="ana-card-header">
      <span class="ana-dot ${dotClass}"></span>
      <span class="ana-card-title">${title}</span>
    </div>
    <div class="ana-card-body">${body}</div>
  </div>`;
}

function buildFocusCard(avg) {
  if (avg < 8)
    return anaCard("red", "Intense concentration",
      `Average rate <strong>${avg.toFixed(1)}/min</strong>, well below the norm (12–20/min). ` +
      `This indicates very deep focus — or prolonged fixation that suppresses the blink reflex. ` +
      `A reduced blink rate accelerates tear film evaporation: take frequent visual breaks.`);
  if (avg < 12)
    return anaCard("yellow", "High focus state",
      `Average rate <strong>${avg.toFixed(1)}/min</strong>: below the resting physiological baseline. ` +
      `Typical of cognitively demanding activities such as reading, coding or analysis. ` +
      `Consider the 20-20-20 rule: every 20 minutes, look at something 20 feet (6 m) away for 20 seconds.`);
  if (avg < 20)
    return anaCard("green", "Normal physiological rate",
      `Average rate <strong>${avg.toFixed(1)}/min</strong>: within the healthy range (12–20/min). ` +
      `No signs of overload — mind and eyes in balance throughout the session.`);
  return anaCard("red", "Signs of strain",
    `Average rate <strong>${avg.toFixed(1)}/min</strong>, above the resting norm. ` +
    `A high rate can indicate visual strain, dry eyes or prolonged stress. ` +
    `Check brightness, posture, and consider a longer break.`);
}

function buildTrendCard(slopePerMin) {
  if (Math.abs(slopePerMin) < 0.4)
    return anaCard("green", "Stable trend",
      `Nearly flat trendline (<strong>${slopePerMin >= 0 ? "+" : ""}${slopePerMin.toFixed(2)}/min·min</strong>). ` +
      `Uniform, sustained cognitive state — excellent attentional coherence throughout the session.`);
  if (slopePerMin > 0)
    return anaCard("red", "Progressive fatigue",
      `Blink rate rose by about <strong>+${slopePerMin.toFixed(1)}/min</strong> per minute elapsed. ` +
      `An upward trend = accumulating cognitive and visual fatigue. ` +
      `Try the Pomodoro technique: 25 min of work + 5 min break to break the buildup.`);
  return anaCard("iris", "Deepening focus",
    `Blink rate dropped by about <strong>${slopePerMin.toFixed(1)}/min</strong> per minute. ` +
    `A downward trend reflects the classic cognitive warm-up: after an initial orientation phase, ` +
    `attention consolidated and deepened progressively.`);
}

function buildVarCard(sd) {
  if (sd < 2)
    return anaCard("green", "Consistent cognitive state",
      `Variability <strong>σ = ${sd.toFixed(2)}</strong> — very low. ` +
      `Blink rate stayed stable: no clear distractions in the oculomotor pattern, ` +
      `homogeneous and sustained attention.`);
  if (sd < 5)
    return anaCard("yellow", "Normal variability",
      `Variability <strong>σ = ${sd.toFixed(2)}</strong>. ` +
      `Physiological oscillations reflecting natural ultradian attention cycles (~90 min), ` +
      `cognitive micro-breaks and sub-task transitions.`);
  return anaCard("red", "High variability",
    `Variability <strong>σ = ${sd.toFixed(2)}</strong> — elevated. ` +
    `Suggests frequent interruptions, external distractions or strong state transitions. ` +
    `Single-task sessions in low-distraction environments tend to reduce it.`);
}

function buildPeaksCard(minRate, maxRate, valleyMin, peakMin) {
  return anaCard("cyan", "Notable moments",
    `<strong>Peak:</strong> ${maxRate.toFixed(1)}/min at minute ${peakMin} ` +
    `— likely a spike of stress, distraction or activity change.<br>` +
    `<strong>Lowest:</strong> ${minRate.toFixed(1)}/min at minute ${valleyMin} ` +
    `— window of maximum concentration during the session.`);
}

function buildEyeHealthCard(avg, sd) {
  const risk = avg < 8 || (avg < 12 && sd > 4);
  return anaCard(risk ? "yellow" : "green",
    "Eye health",
    risk
      ? `With <strong>${avg.toFixed(1)}/min</strong> you're below the recommended threshold for visual comfort. ` +
        `Reduced blinking decreases corneal lubrication (computer-vision dry-eye syndrome). ` +
        `Use lubricating eye drops if needed, and keep your screen slightly below eye level.`
      : `<strong>${avg.toFixed(1)}/min</strong> is compatible with good ocular hydration. ` +
        `Keep a distance of at least 50–70 cm from the screen and take periodic visual breaks ` +
        `to reduce accommodative strain.`);
}

function buildFocusDepthCard(fdAvg, fdSlopePerMin) {
  const level =
    fdAvg >= 70 ? "deep" :
    fdAvg >= 50 ? "stable"  :
    fdAvg >= 35 ? "shallow" : "disengaged";
  const trend = fdSlopePerMin;
  let tone = "iris";
  let body =
    `Average Focus Depth <strong>${fdAvg.toFixed(0)}/100</strong> — state: <strong>${level}</strong>. ` +
    `This index combines attentional blink suppression, ocular rhythm coherence ` +
    `and absence of rebound, compared against your personal baseline.`;
  if (trend <= -0.8) {
    tone = "red";
    body += ` Focus has <strong>declined</strong> by about ${trend.toFixed(1)} pt/min: attention ` +
      `dispersed progressively. You may have experienced cognitive lapses or recurring distractions.`;
  } else if (trend >= 0.8) {
    tone = "green";
    body += ` <strong>Upward</strong> trend (+${trend.toFixed(1)} pt/min): after the start, attention ` +
      `consolidated — a classic cognitive warm-up pattern.`;
  } else {
    tone = fdAvg >= 50 ? "green" : "yellow";
    body += ` <strong>Stable</strong> trajectory (${trend >= 0 ? "+" : ""}${trend.toFixed(1)} pt/min): ` +
      `attentional state sustained through the entire session.`;
  }
  return anaCard(tone, "Focus Depth — interpretation", body);
}

function buildCognitiveFatigueCard(cfAvg, cfSlopePerMin) {
  const level =
    cfAvg >= 60 ? "high" :
    cfAvg >= 40 ? "moderate" :
    cfAvg >= 20 ? "mild" : "minimal";
  const trend = cfSlopePerMin;
  let tone = cfAvg >= 60 ? "red" : cfAvg >= 40 ? "yellow" : "green";
  let body =
    `Average Cognitive Fatigue <strong>${cfAvg.toFixed(0)}/100</strong> — fatigue: <strong>${level}</strong>. ` +
    `Aggregates temporal drift of blink rate, inter-blink interval variability ` +
    `and rebound episodes typical of disengagement.`;
  if (trend >= 0.8) {
    tone = "red";
    body += ` Fatigue <strong>grew</strong> by about +${trend.toFixed(1)} pt/min: clear buildup ` +
      `through the session. This is the ideal moment for a recovery break (5–10 min).`;
  } else if (trend <= -0.8) {
    body += ` Fatigue <strong>decreased</strong> by ${trend.toFixed(1)} pt/min: likely entry ` +
      `into a flow state after an initial adjustment phase.`;
  } else {
    body += ` Flat trend (${trend >= 0 ? "+" : ""}${trend.toFixed(1)} pt/min): steady cognitive load, ` +
      `no evident accumulation.`;
  }
  return anaCard(tone, "Cognitive Fatigue — interpretation", body);
}

function buildCogInsufficientCard() {
  return anaCard("cyan", "Cognitive metrics",
    `Session too short or calibration incomplete: at least 3–5 minutes of continuous monitoring ` +
    `with a visible face are needed for reliable <strong>Focus Depth</strong> and <strong>Cognitive Fatigue</strong>. ` +
    `Estimates will be computed automatically in longer sessions.`);
}

/* ── Cognitive metrics ── */

function loadUserBaseline() {
  try { return JSON.parse(localStorage.getItem(BASELINES_KEY)); } catch { return null; }
}
function saveUserBaseline(data) {
  try { localStorage.setItem(BASELINES_KEY, JSON.stringify(data)); } catch {}
}

function cogEffectiveBaseline() {
  if (state.cogB_session_ready && state.cogB_user) {
    return 0.35 * state.cogB_session + 0.65 * state.cogB_user;
  }
  return state.cogB_session_ready ? state.cogB_session : (state.cogB_user || 15);
}

function computeIBIFeatures() {
  const now = Date.now();
  const t3m = now - 3 * 60000;
  const recent = state.blinkTimes.filter(t => t >= t3m);
  if (recent.length < 3) return { median: null, cv: 0.55, p90: 6, count: recent.length };

  const ibis = [];
  for (let i = 1; i < recent.length; i++) ibis.push((recent[i] - recent[i - 1]) / 1000);
  if (state.blinkTimes.length > 0) {
    ibis.push((now - state.blinkTimes[state.blinkTimes.length - 1]) / 1000);
  }
  ibis.sort((a, b) => a - b);
  const mean = ibis.reduce((a, b) => a + b, 0) / ibis.length;
  const sd = Math.sqrt(ibis.reduce((a, b) => a + (b - mean) ** 2, 0) / ibis.length);
  const mid = Math.floor(ibis.length / 2);
  const median = ibis.length % 2 === 0 ? (ibis[mid - 1] + ibis[mid]) / 2 : ibis[mid];
  const p90 = ibis[Math.min(Math.floor(0.9 * ibis.length), ibis.length - 1)];
  return { median, cv: mean > 0 ? sd / mean : 0.55, p90, count: recent.length };
}

function detectSuppressionBursts() {
  const now = Date.now();
  const Beff = cogEffectiveBaseline();
  const ibiMed = state.ibiMedian3m || (Beff > 0 ? 60 / Beff : 4);
  const T_supp_ms = Math.max(12000, 3 * ibiMed * 1000);

  const hasFace = (now - state.lastFaceSeenAt) < 2500;
  const n = state.blinkTimes.length;
  const sinceLastMs = n > 0 ? now - state.blinkTimes[n - 1] : Infinity;

  if (!state.paused && hasFace) {
    if (sinceLastMs >= T_supp_ms) {
      if (state.activeSupprStart === null) {
        state.activeSupprStart = n > 0
          ? state.blinkTimes[n - 1]
          : now - sinceLastMs;
      }
    } else if (state.activeSupprStart !== null) {
      const lastBlink = state.blinkTimes[n - 1];
      const dur_s = (lastBlink - state.activeSupprStart) / 1000;
      if (dur_s >= T_supp_ms / 1000) {
        state.suppressionEps.push({ t_start: state.activeSupprStart, t_end: lastBlink, dur_s });
        detectReboundBurst(lastBlink);
      }
      state.activeSupprStart = null;
    }
  } else {
    state.activeSupprStart = null;
  }

  const cut5m = now - 5 * 60000;
  state.suppressionEps = state.suppressionEps.filter(e => e.t_end > cut5m);
  state.reboundBursts   = state.reboundBursts.filter(b => b.t > cut5m);
}

function detectReboundBurst(t_start) {
  const t_end = t_start + 5000;
  const burst = state.blinkTimes.filter(t => t >= t_start && t <= t_end);
  if (burst.length < 3) return;
  let ok = true;
  for (let i = 1; i < burst.length; i++) if ((burst[i] - burst[i - 1]) / 1000 > 0.6) { ok = false; break; }
  if (ok) state.reboundBursts.push({ t: t_start, size: burst.length });
}

function computeRateSlope() {
  if (state.rateHistory.length < 6) return 0;
  const pts = state.rateHistory;
  const n = pts.length;
  const t0 = pts[0].t;
  const xs = pts.map(p => (p.t - t0) / 60000);
  const ys = pts.map(p => p.v);
  const sx = xs.reduce((a, b) => a + b, 0);
  const sy = ys.reduce((a, b) => a + b, 0);
  const sxy = xs.reduce((a, x, i) => a + x * ys[i], 0);
  const sx2 = xs.reduce((a, x) => a + x * x, 0);
  const d = n * sx2 - sx * sx;
  return d === 0 ? 0 : (n * sxy - sx * sy) / d;
}

function computeVarianceRatio() {
  const n = state.rateHistory.length;
  if (n < 12) return 1;
  const mid1 = Math.floor(n / 3), mid2 = Math.floor(2 * n / 3);
  const varOf = arr => {
    if (arr.length < 2) return 0;
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    return arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length;
  };
  const vMid  = varOf(state.rateHistory.slice(mid1, mid2).map(p => p.v));
  const vLate = varOf(state.rateHistory.slice(mid2).map(p => p.v));
  return vMid > 0 ? vLate / vMid : 1;
}

function computeFocusDepth(elapsed_s) {
  const Beff = cogEffectiveBaseline();
  const rate60 = state.rateHistory.length ? state.rateHistory[state.rateHistory.length - 1].v : 0;
  const cv   = state.ibiCv3m;
  const p90  = state.ibiP903m;
  const reboundDensity = state.reboundBursts.length / 5;

  const s_supp      = Math.min(1, Math.max(0, (1 - rate60 / Math.max(Beff, 1)) / 0.50));
  const s_p90       = Math.min(1, Math.max(0, (p90 - 6) / 14));
  const s_coherence = 1 - Math.min(1, Math.abs(cv - 0.55) / 0.60);
  const p_rebound   = Math.min(1, reboundDensity / 0.6);
  const p_unstable  = Math.min(1, Math.max(0, (cv - 1.2) / 0.8));

  const fd_raw = Math.max(0, Math.min(1,
    0.55 * s_supp + 0.20 * s_p90 + 0.25 * s_coherence - 0.25 * p_rebound - 0.15 * p_unstable));

  const alpha = 0.15;
  state.cogFD = alpha * fd_raw + (1 - alpha) * state.cogFD;

  const warmup = elapsed_s < 60 ? 0 : Math.min(1, (elapsed_s - 60) / 120);
  const density = Math.min(1, (state.ibiMedian3m ? 5 : 0) / 5 +
    state.blinkTimes.filter(t => Date.now() - t < 3 * 60000).length / 5);
  state.cogFD_conf = warmup * Math.min(1, density);
}

function computeCognitiveFatigue(elapsed_s) {
  if (elapsed_s < 180) { state.cogCF = state.cogCF * 0.98; return; }

  const Beff = cogEffectiveBaseline();
  const slope = state.rateSlopeSession;
  const vr = computeVarianceRatio();
  const reboundDensity = state.reboundBursts.length / 5;

  const now = Date.now();
  const t5m = now - 5 * 60000;
  const r5vals = state.rateHistory.filter(p => p.t >= t5m).map(p => p.v);
  const rate5m = r5vals.length ? r5vals.reduce((a, b) => a + b, 0) / r5vals.length : 0;
  const driftRatio = (rate5m - Beff) / Math.max(Beff, 1);

  const s_drift     = Math.min(1, Math.max(0, slope / (0.05 * Math.max(Beff, 1))));
  const s_variance  = Math.min(1, Math.max(0, (vr - 1.0) / 1.5));
  const s_rebound   = Math.min(1, reboundDensity / 0.8);
  const s_elevation = Math.min(1, Math.max(0, driftRatio / 0.40));

  const cf_raw = Math.max(0, Math.min(1,
    0.35 * s_drift + 0.20 * s_variance + 0.25 * s_rebound + 0.20 * s_elevation));

  const alpha = 0.05;
  state.cogCF = alpha * cf_raw + (1 - alpha) * state.cogCF;

  const warmupCF = Math.min(1, (elapsed_s - 180) / 120);
  state.cogCF_conf = state.cogFD_conf * warmupCF;
}

const STATE_LABELS = {
  deep:       "Deep focus",
  stable:     "Stable focus",
  drifting:   "Drifting",
  fatigue:    "Fatigue",
  rebound:    "Rebound",
  disengaged: "Disengaged",
  calib:      "Calibrating…",
  idle:       "Idle",
};

function classifyState(fd, cf, elapsed_s) {
  if (elapsed_s < 60) return "calib";
  const justResumed = state.lastResumedAt > 0 && Date.now() - state.lastResumedAt < 60000;
  const reboundNow = state.reboundBursts.length > 0 &&
    Date.now() - state.reboundBursts[state.reboundBursts.length - 1].t < 15000;
  if (justResumed || (reboundNow && cf >= 40)) return "rebound";
  if (cf >= 60) return "fatigue";
  if (fd >= 70 && cf < 40) return "deep";
  if (fd >= 50 && cf < 50) return "stable";
  if (fd < 35 && cf < 40)  return "disengaged";
  return "drifting";
}

function updateCognitiveMetrics() {
  if (!state.startedAt) return;
  const elapsed_s = (Date.now() - state.startedAt) / 1000;

  // collect B_session samples (min 1–3)
  if (!state.cogB_session_ready && elapsed_s >= 60 && elapsed_s <= 180 &&
      state.rateHistory.length) {
    state.cogB_session_samples.push(state.rateHistory[state.rateHistory.length - 1].v);
  }
  if (!state.cogB_session_ready && elapsed_s > 180 && state.cogB_session_samples.length >= 3) {
    const s = [...state.cogB_session_samples].sort((a, b) => a - b);
    state.cogB_session = s[Math.floor(s.length / 2)];
    state.cogB_session_ready = true;
  }

  const ibi = computeIBIFeatures();
  state.ibiMedian3m = ibi.median;
  state.ibiCv3m     = ibi.cv;
  state.ibiP903m    = ibi.p90;

  detectSuppressionBursts();
  state.rateSlopeSession = computeRateSlope();

  computeFocusDepth(elapsed_s);
  computeCognitiveFatigue(elapsed_s);

  const fd = Math.round(state.cogFD * 100);
  const cf = Math.round(state.cogCF * 100);
  state.cogStateLabel = classifyState(fd, cf, elapsed_s);

  state.cogHistory.push({
    t: Date.now(),
    fd,
    cf,
    fdConf: state.cogFD_conf,
    cfConf: state.cogCF_conf,
    st: state.cogStateLabel,
  });

  renderCognitiveUI(fd, cf, elapsed_s);
}

function renderCognitiveUI(fd, cf, elapsed_s) {
  const fdEl  = document.getElementById("fdVal");
  const cfEl  = document.getElementById("cfVal");
  const fdBar = document.getElementById("fdBar");
  const cfBar = document.getElementById("cfBar");
  const fdConf= document.getElementById("fdConf");
  const cfConf= document.getElementById("cfConf");
  const stEl  = document.getElementById("stateLabel");
  if (!fdEl) return;

  const calibrating = !state.cogB_session_ready;
  const fdLow = state.cogFD_conf < 0.35;
  const cfLow = state.cogCF_conf < 0.35;

  if (calibrating || fdLow) {
    fdEl.textContent = "—";
    fdBar.style.width = "0%";
    fdConf.textContent = calibrating ? "calibration in progress…" : "insufficient data";
  } else {
    fdEl.textContent = String(fd);
    fdBar.style.width = fd + "%";
    fdConf.textContent = `baseline ${cogEffectiveBaseline().toFixed(1)}/min`;
  }

  if (calibrating || cfLow) {
    cfEl.textContent = "—";
    cfBar.style.width = "0%";
    cfConf.textContent = calibrating ? "calibration in progress…" : elapsed_s < 180 ? "available after 3 min" : "insufficient data";
  } else {
    cfEl.textContent = String(cf);
    cfBar.style.width = cf + "%";
    cfConf.textContent = `drift: ${state.rateSlopeSession >= 0 ? "+" : ""}${state.rateSlopeSession.toFixed(2)}/min·min`;
  }

  if (stEl) {
    const key = state.cogStateLabel;
    stEl.textContent = STATE_LABELS[key] || key;
    stEl.className = "state-badge state-" + key;
  }
}

function resetCognitiveUI() {
  const ids = ["fdVal", "cfVal", "fdConf", "cfConf"];
  ids.forEach(id => {
    const el2 = document.getElementById(id);
    if (el2) el2.textContent = id.endsWith("Val") ? "—" : "waiting";
  });
  ["fdBar", "cfBar"].forEach(id => {
    const el2 = document.getElementById(id);
    if (el2) el2.style.width = "0%";
  });
  const stEl = document.getElementById("stateLabel");
  if (stEl) { stEl.textContent = "Idle"; stEl.className = "state-badge state-idle"; }
}

/* ── Calendar integration ── */

function loadEvents() {
  try {
    const raw = localStorage.getItem(EVENTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function saveEvents(list) {
  try { localStorage.setItem(EVENTS_KEY, JSON.stringify(list)); } catch {}
}

/* Minimal ICS parser — handles VEVENT with SUMMARY / DTSTART / DTEND / UID.
   Supports basic DATE-TIME (UTC 'Z' and local) and all-day DATE values.
   Ignores recurrences beyond the first instance. */
function parseIcsDate(val, params) {
  if (!val) return null;
  const isDate = /VALUE=DATE/i.test(params || "") || /^\d{8}$/.test(val);
  if (isDate) {
    const y = +val.slice(0, 4), m = +val.slice(4, 6) - 1, d = +val.slice(6, 8);
    return new Date(y, m, d).getTime();
  }
  const m = val.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S, Z] = m;
  if (Z) return Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +S);
  return new Date(+Y, +Mo - 1, +D, +H, +Mi, +S).getTime();
}

function parseIcs(text) {
  const raw = text.replace(/\r\n/g, "\n");
  const unfolded = raw.replace(/\n[ \t]/g, "");
  const lines = unfolded.split("\n");
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { cur = {}; continue; }
    if (line === "END:VEVENT") {
      if (cur && cur.start && cur.end && cur.end > cur.start) {
        events.push({
          uid: cur.uid || ("ev_" + cur.start + "_" + Math.random().toString(36).slice(2, 8)),
          title: cur.title || "(untitled)",
          start: cur.start,
          end: cur.end,
          classTag: null,
        });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const head = line.slice(0, idx);
    const val  = line.slice(idx + 1);
    const [name, ...paramParts] = head.split(";");
    const params = paramParts.join(";");
    switch (name) {
      case "SUMMARY": cur.title = val.replace(/\\,/g, ",").replace(/\\n/gi, " "); break;
      case "UID":     cur.uid = val; break;
      case "DTSTART": cur.start = parseIcsDate(val, params); break;
      case "DTEND":   cur.end   = parseIcsDate(val, params); break;
    }
  }
  return events;
}

function matchSessionForEvent(event, sessions) {
  for (const s of sessions) {
    const sStart = s.startedAt;
    const sEnd = s.endedAt || (s.startedAt + (s.durationMs || 0));
    const overlapStart = Math.max(sStart, event.start);
    const overlapEnd = Math.min(sEnd, event.end);
    const overlap = overlapEnd - overlapStart;
    if (overlap > 0 && overlap >= Math.min(60000, (sEnd - sStart) * 0.25)) {
      return s;
    }
  }
  return null;
}

function classOptionsHtml(selected) {
  let html = `<option value="">— classify —</option>`;
  for (const c of EVENT_CLASSES) {
    html += `<option value="${c.id}"${c.id === selected ? " selected" : ""}>${c.label}</option>`;
  }
  return html;
}

function fmtEventTime(ev) {
  const s = new Date(ev.start);
  const e = new Date(ev.end);
  const sameDay = s.toDateString() === e.toDateString();
  const d = s.toLocaleDateString();
  const pad = (n) => String(n).padStart(2, "0");
  const hm = (x) => `${pad(x.getHours())}:${pad(x.getMinutes())}`;
  return sameDay ? `${d} · ${hm(s)}–${hm(e)}` : `${d} ${hm(s)} → ${e.toLocaleDateString()} ${hm(e)}`;
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function bucketEvent(eventStart, now) {
  const todayStart = startOfDay(now);
  const tomorrowStart = todayStart + 24 * 3600 * 1000;
  const yStart = todayStart - 24 * 3600 * 1000;
  const sevenStart = todayStart - 7 * 24 * 3600 * 1000;
  const thirtyStart = todayStart - 30 * 24 * 3600 * 1000;
  if (eventStart >= tomorrowStart) return "future";
  if (eventStart >= todayStart) return "today";
  if (eventStart >= yStart) return "yesterday";
  if (eventStart >= sevenStart) return "past7";
  if (eventStart >= thirtyStart) return "past30";
  return null;
}

const BUCKET_DEFS = [
  { id: "future",    label: "Upcoming",     defaultOpen: false },
  { id: "today",     label: "Today",        defaultOpen: true  },
  { id: "yesterday", label: "Yesterday",    defaultOpen: false },
  { id: "past7",     label: "Past 7 days",  defaultOpen: false },
  { id: "past30",    label: "Past 30 days", defaultOpen: false },
];

function buildEventRow(ev, sessions) {
  const matched = matchSessionForEvent(ev, sessions);
  const row = document.createElement("div");
  row.className = "cal-event-row " + (matched ? "matched" : "no-match");
  const effectiveClass = ev.classTag || (matched?.tag?.class) || "";

  const info = document.createElement("div");
  info.className = "cev-info";
  info.innerHTML = `
    <div class="cev-title">${escapeHtml(ev.title)}</div>
    <div class="cev-meta">${fmtEventTime(ev)}</div>
    ${matched
      ? `<div class="cev-match">✓ linked to session ${fmtDate(matched.startedAt)} · avg ${matched.avgRate.toFixed(1)}/min</div>`
      : `<div class="cev-no-match">no overlapping session</div>`}
  `;

  const select = document.createElement("select");
  select.className = "cev-class-select";
  select.innerHTML = classOptionsHtml(effectiveClass);
  select.addEventListener("change", () => {
    updateEventClass(ev.uid, select.value || null);
    if (matched) {
      tagSessionFromEvent(matched.id, select.value || null, ev.title);
    }
    renderCalendarEvents();
    renderSessions();
  });

  const del = document.createElement("button");
  del.className = "cev-del";
  del.textContent = "✕";
  del.title = "Remove event";
  del.addEventListener("click", () => {
    const next = loadEvents().filter(e => e.uid !== ev.uid);
    saveEvents(next);
    renderCalendarEvents();
  });

  row.appendChild(info);
  row.appendChild(select);
  row.appendChild(del);
  return row;
}

function renderCalendarEvents() {
  const events = loadEvents().sort((a, b) => b.start - a.start);
  const sessions = loadSessions();
  calEventList.innerHTML = "";
  if (!events.length) {
    const p = document.createElement("p");
    p.className = "cal-empty";
    p.textContent = "No events imported. Connect Google Calendar to get started.";
    calEventList.appendChild(p);
    renderCalendarStats();
    return;
  }

  const now = Date.now();
  const buckets = Object.fromEntries(BUCKET_DEFS.map(d => [d.id, []]));
  for (const ev of events) {
    const k = bucketEvent(ev.start, now);
    if (k && buckets[k]) buckets[k].push(ev);
  }

  let total = 0;
  for (const def of BUCKET_DEFS) {
    const list = buckets[def.id] || [];
    if (!list.length) continue;
    total += list.length;
    const details = document.createElement("details");
    details.className = "cal-bucket";
    if (def.defaultOpen) details.open = true;
    const summary = document.createElement("summary");
    summary.className = "cal-bucket-summary";
    summary.innerHTML =
      `<span class="cal-bucket-label">${def.label}</span>` +
      `<span class="cal-bucket-count">${list.length}</span>`;
    details.appendChild(summary);
    const rows = document.createElement("div");
    rows.className = "cal-bucket-rows";
    for (const ev of list) rows.appendChild(buildEventRow(ev, sessions));
    details.appendChild(rows);
    calEventList.appendChild(details);
  }

  if (total === 0) {
    const p = document.createElement("p");
    p.className = "cal-empty";
    p.textContent = "No events in the last 30 days.";
    calEventList.appendChild(p);
  }
  renderCalendarStats();
}

function updateEventClass(uid, classTag) {
  const list = loadEvents();
  const ev = list.find(e => e.uid === uid);
  if (!ev) return;
  ev.classTag = classTag;
  saveEvents(list);
}

function tagSessionFromEvent(sessionId, classTag, eventTitle) {
  const sessions = loadSessions();
  const s = sessions.find(x => x.id === sessionId);
  if (!s) return;
  s.tag = {
    class: classTag,
    label: eventTitle || s.tag?.label || null,
    source: "ics",
  };
  saveSessions(sessions);
}

function tagSessionManually(sessionId, classTag) {
  const sessions = loadSessions();
  const s = sessions.find(x => x.id === sessionId);
  if (!s) return;
  s.tag = {
    class: classTag || null,
    label: s.tag?.label || null,
    source: "manual",
  };
  saveSessions(sessions);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function sessionCogAverages(s) {
  const cog = (s.cogSamples || []).filter(c =>
    Number.isFinite(c.fd) && Number.isFinite(c.cf) && (c.fdConf ?? 0) >= 0.35
  );
  if (!cog.length) return { fd: null, cf: null };
  const fd = cog.reduce((a, b) => a + b.fd, 0) / cog.length;
  const cf = cog.reduce((a, b) => a + b.cf, 0) / cog.length;
  return { fd, cf };
}

function renderCalendarStats() {
  const sessions = loadSessions().filter(s => s.tag && s.tag.class);
  if (!sessions.length) {
    calStats.hidden = true;
    return;
  }
  const byClass = {};
  for (const s of sessions) {
    const k = s.tag.class;
    byClass[k] ||= [];
    byClass[k].push(s);
  }
  calStatsBody.innerHTML = "";
  for (const c of EVENT_CLASSES) {
    const list = byClass[c.id];
    if (!list || !list.length) continue;
    const rates = list.map(s => s.avgRate);
    const avg = rates.reduce((a, b) => a + b, 0) / rates.length;
    const sd = stddev(rates);
    const fdVals = [], cfVals = [];
    for (const s of list) {
      const ca = sessionCogAverages(s);
      if (ca.fd != null) fdVals.push(ca.fd);
      if (ca.cf != null) cfVals.push(ca.cf);
    }
    const fdAvg = fdVals.length ? fdVals.reduce((a, b) => a + b, 0) / fdVals.length : null;
    const cfAvg = cfVals.length ? cfVals.reduce((a, b) => a + b, 0) / cfVals.length : null;

    const card = document.createElement("div");
    card.className = "class-stat cs-" + CLASS_CSS_KEY[c.id];
    card.innerHTML = `
      <div class="cs-label">${c.label} · ${list.length} session${list.length === 1 ? "" : "s"}</div>
      <div class="cs-row"><span>Average rate</span><strong>${avg.toFixed(1)}/min</strong></div>
      <div class="cs-row"><span>Variability σ</span><strong>${sd.toFixed(2)}</strong></div>
      <div class="cs-row"><span>Focus Depth</span><strong>${fdAvg != null ? fdAvg.toFixed(0) + "/100" : "—"}</strong></div>
      <div class="cs-row"><span>Cognitive Fatigue</span><strong>${cfAvg != null ? cfAvg.toFixed(0) + "/100" : "—"}</strong></div>
    `;
    calStatsBody.appendChild(card);
  }
  calStats.hidden = calStatsBody.children.length === 0;
}

function mergeAndPersistEvents(parsed) {
  if (!parsed.length) return 0;
  const existing = loadEvents();
  const byUid = new Map(existing.map(e => [e.uid, e]));
  let added = 0;
  for (const ev of parsed) {
    if (!byUid.has(ev.uid)) { byUid.set(ev.uid, ev); added++; }
    else {
      // refresh title/start/end if changed, keep classTag
      const prev = byUid.get(ev.uid);
      byUid.set(ev.uid, { ...prev, title: ev.title, start: ev.start, end: ev.end });
    }
  }
  saveEvents([...byUid.values()]);
  autoMatchSessionsToEvents();
  renderCalendarEvents();
  renderSessions();
  return added;
}

function autoMatchSessionsToEvents() {
  const events = loadEvents();
  const sessions = loadSessions();
  let dirty = false;
  for (const ev of events) {
    if (!ev.classTag) continue;
    const matched = matchSessionForEvent(ev, sessions);
    if (matched && (!matched.tag || matched.tag.source !== "manual")) {
      matched.tag = { class: ev.classTag, label: ev.title, source: "ics" };
      dirty = true;
    }
  }
  if (dirty) saveSessions(sessions);
}

clearEventsBtn?.addEventListener("click", () => {
  if (!confirm("Delete all imported events?")) return;
  saveEvents([]);
  renderCalendarEvents();
});

renderCalendarEvents();

/* ── Google Calendar OAuth integration ── */

// Set this to your Google OAuth Web Client ID (Google Cloud Console
// → APIs & Services → Credentials → OAuth 2.0 Client IDs → Web application).
// Add the deployed origin (and http://localhost:<port> for dev) to
// "Authorized JavaScript origins". Leave empty to disable Google sign-in.
const GOOGLE_CLIENT_ID = "615032101382-bglrmgcsqnfijkn405pjv1cu14rgpccb.apps.googleusercontent.com";
const GOOGLE_SCOPES = "https://www.googleapis.com/auth/calendar.readonly";
const GOOGLE_TOKEN_KEY = "blinkGoogleToken.v1";

let googleTokenClient = null;

function getStoredGoogleToken() {
  try {
    const raw = sessionStorage.getItem(GOOGLE_TOKEN_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw);
    if (Date.now() > t.exp) { sessionStorage.removeItem(GOOGLE_TOKEN_KEY); return null; }
    return t;
  } catch { return null; }
}

function updateGoogleConnectButton() {
  if (!connectGoogleBtn) return;
  const t = getStoredGoogleToken();
  const connected = !!t;
  connectGoogleBtn.dataset.connected = connected ? "true" : "false";
  if (connectGoogleLabel) {
    connectGoogleLabel.textContent = connected
      ? "Refresh Google Calendar"
      : "Connect Google Calendar";
  }
}

function ensureGoogleClient() {
  if (!GOOGLE_CLIENT_ID) return false;
  if (!window.google?.accounts?.oauth2) return false;
  if (googleTokenClient) return true;
  googleTokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: GOOGLE_SCOPES,
    callback: handleGoogleToken,
    error_callback: handleGoogleError,
  });
  console.log("[google] token client initialised");
  return true;
}

// Pre-initialise as soon as the GIS script becomes available so the click
// handler can call requestAccessToken synchronously (popup blockers require
// the call to happen in the same tick as the user gesture — no awaits).
(function preloadGoogleClient() {
  if (ensureGoogleClient()) return;
  let attempts = 0;
  const iv = setInterval(() => {
    if (ensureGoogleClient() || ++attempts > 60) clearInterval(iv);
  }, 200);
})();

function handleGoogleToken(resp) {
  if (resp.error) {
    console.warn("[google] token response error:", resp);
    setStatus("Google sign-in failed: " + (resp.error_description || resp.error), true);
    return;
  }
  const exp = Date.now() + Math.max(60, (resp.expires_in || 3600) - 60) * 1000;
  sessionStorage.setItem(
    GOOGLE_TOKEN_KEY,
    JSON.stringify({ token: resp.access_token, exp })
  );
  updateGoogleConnectButton();
  fetchGoogleCalendarEvents();
}

function handleGoogleError(err) {
  console.warn("[google] OAuth error:", err);
  const t = err?.type || "unknown";
  let msg;
  if (t === "popup_failed_to_open") {
    msg = "Google sign-in popup was blocked. Allow popups for this site and try again.";
  } else if (t === "popup_closed") {
    msg = "Google sign-in cancelled — popup was closed before consent.";
  } else {
    msg = "Google sign-in failed: " + (err?.message || t);
  }
  setStatus(msg, true);
}

function waitForGoogleScript(maxMs = 8000) {
  return new Promise((resolve) => {
    const start = Date.now();
    (function poll() {
      if (window.google?.accounts?.oauth2) return resolve(true);
      if (Date.now() - start > maxMs) return resolve(false);
      setTimeout(poll, 150);
    })();
  });
}

async function fetchGoogleCalendarEvents() {
  const t = getStoredGoogleToken();
  if (!t) return;
  const now = Date.now();
  const timeMin = new Date(now - 30 * 24 * 3600 * 1000).toISOString();
  const timeMax = new Date(now +  7 * 24 * 3600 * 1000).toISOString();
  const url =
    "https://www.googleapis.com/calendar/v3/calendars/primary/events" +
    "?singleEvents=true&orderBy=startTime&maxResults=250" +
    "&timeMin=" + encodeURIComponent(timeMin) +
    "&timeMax=" + encodeURIComponent(timeMax);
  try {
    setStatus("Fetching Google Calendar events…");
    const res = await fetch(url, { headers: { Authorization: "Bearer " + t.token } });
    if (res.status === 401) {
      sessionStorage.removeItem(GOOGLE_TOKEN_KEY);
      updateGoogleConnectButton();
      setStatus("Google session expired — click Connect again.", true);
      return;
    }
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const events = (data.items || []).map(googleEventToInternal).filter(Boolean);
    const added = mergeAndPersistEvents(events);
    setStatus(
      events.length === 0
        ? "Google Calendar reachable, but no events in window."
        : `Synced ${events.length} Google Calendar events (${added} new).`
    );
  } catch (e) {
    setStatus("Google Calendar fetch failed: " + e.message, true);
  }
}

function googleEventToInternal(ev) {
  const start = ev.start?.dateTime ? Date.parse(ev.start.dateTime)
              : ev.start?.date     ? new Date(ev.start.date).getTime()
              : null;
  const end   = ev.end?.dateTime   ? Date.parse(ev.end.dateTime)
              : ev.end?.date       ? new Date(ev.end.date).getTime()
              : null;
  if (!start || !end || end <= start) return null;
  return {
    uid: "g_" + ev.id,
    title: ev.summary || "(untitled)",
    start, end,
    classTag: null,
  };
}

connectGoogleBtn?.addEventListener("click", () => {
  console.log("[google] connect button clicked");
  if (!GOOGLE_CLIENT_ID) {
    alert(
      "Google Calendar integration needs a one-time setup:\n\n" +
      "1. Open https://console.cloud.google.com/apis/credentials\n" +
      "2. Create an OAuth 2.0 Client ID (type: Web application)\n" +
      "3. Add this site's origin (" + location.origin + ") to\n" +
      "   \"Authorized JavaScript origins\"\n" +
      "4. Enable the Google Calendar API for the project\n" +
      "5. Paste the Client ID into app.js → GOOGLE_CLIENT_ID\n\n" +
      "Then reload and click Connect."
    );
    return;
  }
  if (getStoredGoogleToken()) {
    fetchGoogleCalendarEvents();
    return;
  }
  // Synchronous path only — no awaits between the click and requestAccessToken,
  // otherwise the browser pop-up blocker treats the popup as user-less.
  if (!ensureGoogleClient()) {
    setStatus(
      "Google sign-in script is still loading. Wait a moment and click again.",
      true
    );
    return;
  }
  try {
    googleTokenClient.requestAccessToken({ prompt: "consent" });
  } catch (e) {
    console.error("[google] requestAccessToken threw:", e);
    setStatus("Could not start Google sign-in: " + e.message, true);
  }
});

// On load, if we have a fresh token (still valid this tab), refresh events.
if (getStoredGoogleToken()) {
  window.addEventListener("load", () => {
    setTimeout(fetchGoogleCalendarEvents, 400);
  });
}
updateGoogleConnectButton();

// ───────────────────────────────────────────────────────────────────────────
// Auth — Google Sign-In + admin allowlist
// Sign-in produces a Google ID token; the server verifies it and sets a
// signed session cookie. Admin status (= visibility of WHOOP UI) is
// determined by ADMIN_EMAILS in Vercel env vars.
// ───────────────────────────────────────────────────────────────────────────

const authState = { signedIn: false, isAdmin: false, email: null };

function setAdminUiVisibility(isAdmin) {
  document.querySelectorAll(".admin-only").forEach((el) => {
    if (isAdmin) {
      el.removeAttribute("hidden");
    } else {
      el.setAttribute("hidden", "");
    }
  });
}

function renderAuthUi() {
  if (authState.signedIn) {
    if (signInBtn) signInBtn.hidden = true;
    if (userBadge) userBadge.hidden = false;
    if (userEmailEl) userEmailEl.textContent = authState.email;
    if (adminPill) adminPill.hidden = !authState.isAdmin;
  } else {
    if (signInBtn) signInBtn.hidden = false;
    if (userBadge) userBadge.hidden = true;
  }
  setAdminUiVisibility(authState.isAdmin);
}

function ensureGsiId() {
  if (!window.google?.accounts?.id) return false;
  if (window.__gsiIdInited) return true;
  window.google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: handleCredentialResponse,
    auto_select: false,
    cancel_on_tap_outside: true,
  });
  window.__gsiIdInited = true;
  return true;
}

async function handleCredentialResponse(resp) {
  if (!resp?.credential) {
    setStatus("Sign-in failed: no credential.", true);
    return;
  }
  try {
    setStatus("Verifying sign-in…");
    const r = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ id_token: resp.credential }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setStatus(`Sign-in rejected: ${j.error || r.status}`, true);
      return;
    }
    const j = await r.json();
    authState.signedIn = true;
    authState.email = j.email;
    authState.isAdmin = !!j.isAdmin;
    renderAuthUi();
    setStatus(`Signed in as ${authState.email}.`);
  } catch (e) {
    setStatus("Sign-in error: " + e.message, true);
  }
}

signInBtn?.addEventListener("click", async () => {
  if (!GOOGLE_CLIENT_ID) {
    setStatus("Sign-in disabled: GOOGLE_CLIENT_ID not configured.", true);
    return;
  }
  // Wait briefly for GIS to load if needed.
  let waited = 0;
  while (!ensureGsiId() && waited < 4000) {
    await new Promise((r) => setTimeout(r, 200));
    waited += 200;
  }
  if (!ensureGsiId()) {
    setStatus("Google Sign-In script failed to load.", true);
    return;
  }
  try {
    window.google.accounts.id.prompt((notification) => {
      if (notification?.isNotDisplayed?.() || notification?.isSkippedMoment?.()) {
        const reason = notification.getNotDisplayedReason?.() || notification.getSkippedReason?.() || "unknown";
        console.warn("[auth] sign-in prompt suppressed:", reason);
        setStatus(
          `Sign-in popup suppressed (${reason}). If this persists, try a different browser or disable strict tracking protection.`,
          true
        );
      }
    });
  } catch (e) {
    setStatus("Sign-in prompt error: " + e.message, true);
  }
});

signOutBtn?.addEventListener("click", async () => {
  try {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
  } catch {}
  authState.signedIn = false;
  authState.isAdmin = false;
  authState.email = null;
  renderAuthUi();
  // Also clear local WHOOP cached state so non-admins don't see stale data.
  try { localStorage.removeItem("blinkWhoopRecovery.v1"); } catch {}
  try { localStorage.removeItem("blinkWhoopConnected.v1"); } catch {}
  setStatus("Signed out.");
});

async function bootstrapAuth() {
  try {
    const r = await fetch("/api/auth/me", { credentials: "same-origin" });
    if (!r.ok) return;
    const j = await r.json();
    authState.signedIn = !!j.signedIn;
    authState.isAdmin = !!j.isAdmin;
    authState.email = j.email || null;
  } catch {}
  renderAuthUi();
}
bootstrapAuth();

// ───────────────────────────────────────────────────────────────────────────
// WHOOP integration — backend OAuth proxy at /api/whoop/*
// Recovery records are cached locally so reports keep working offline.
// ───────────────────────────────────────────────────────────────────────────

const WHOOP_RECOVERY_KEY = "blinkWhoopRecovery.v1";
const WHOOP_STATUS_KEY = "blinkWhoopConnected.v1";

function loadWhoopRecovery() {
  try {
    const raw = localStorage.getItem(WHOOP_RECOVERY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function saveWhoopRecovery(records) {
  try { localStorage.setItem(WHOOP_RECOVERY_KEY, JSON.stringify(records)); } catch {}
}

function isWhoopConnectedCached() {
  return localStorage.getItem(WHOOP_STATUS_KEY) === "1";
}

function setWhoopConnectedCached(v) {
  if (v) localStorage.setItem(WHOOP_STATUS_KEY, "1");
  else localStorage.removeItem(WHOOP_STATUS_KEY);
}

function updateWhoopButton() {
  if (!connectWhoopBtn) return;
  const connected = isWhoopConnectedCached();
  connectWhoopBtn.dataset.connected = connected ? "true" : "false";
  if (connectWhoopLabel) {
    connectWhoopLabel.textContent = connected ? "Refresh WHOOP" : "Connect WHOOP";
  }
}

async function checkWhoopStatus() {
  try {
    const r = await fetch("/api/whoop/status", { credentials: "same-origin" });
    if (!r.ok) return false;
    const j = await r.json();
    setWhoopConnectedCached(!!j.connected);
    updateWhoopButton();
    return !!j.connected;
  } catch {
    return false;
  }
}

async function fetchWhoopRecovery() {
  const startISO = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();
  const endISO = new Date().toISOString();
  setStatus("Fetching WHOOP recovery data…");
  try {
    const r = await fetch(
      `/api/whoop/recovery?start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(endISO)}`,
      { credentials: "same-origin" }
    );
    if (r.status === 401) {
      setWhoopConnectedCached(false);
      updateWhoopButton();
      setStatus("WHOOP session expired — click Connect again.", true);
      return;
    }
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
    }
    const j = await r.json();
    const records = j.records || [];
    // dedupe by date, keep last seen
    const map = new Map();
    for (const old of loadWhoopRecovery()) map.set(old.date, old);
    for (const rec of records) map.set(rec.date, rec);
    const merged = [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
    saveWhoopRecovery(merged);
    setStatus(`Synced ${records.length} WHOOP recovery record(s).`);
    if (currentReportSession) renderPhysiologyBlock(currentReportSession);
  } catch (e) {
    setStatus("WHOOP fetch failed: " + e.message, true);
  }
}

async function disconnectWhoop() {
  try {
    await fetch("/api/whoop/disconnect", { method: "POST", credentials: "same-origin" });
  } catch {}
  setWhoopConnectedCached(false);
  updateWhoopButton();
  setStatus("Disconnected from WHOOP.");
}

connectWhoopBtn?.addEventListener("click", async (e) => {
  console.log("[whoop] connect button clicked");
  if (e.shiftKey && isWhoopConnectedCached()) {
    if (confirm("Disconnect WHOOP?")) await disconnectWhoop();
    return;
  }
  if (isWhoopConnectedCached()) {
    setStatus("Refreshing WHOOP recovery…");
    await fetchWhoopRecovery();
    return;
  }
  // Probe the backend so we can show a useful message if the serverless
  // functions aren't deployed or the env vars are missing.
  setStatus("Checking WHOOP backend…");
  connectWhoopBtn.disabled = true;
  try {
    const probe = await fetch("/api/whoop/status", { credentials: "same-origin" });
    if (!probe.ok && probe.status !== 401) {
      setStatus(
        `WHOOP backend returned ${probe.status}. Set WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET, WHOOP_REDIRECT_URI in Vercel and redeploy.`,
        true
      );
      return;
    }
  } catch (err) {
    setStatus(
      "Cannot reach /api/whoop/status. Either you're running this without the Vercel functions, or your deployment hasn't built. Open in DevTools → Network to see what fails.",
      true
    );
    return;
  } finally {
    connectWhoopBtn.disabled = false;
  }
  // Backend is reachable — full-page redirect to OAuth start.
  window.location.href = "/api/whoop/start";
});

// Handle the redirect-back from /api/whoop/callback (?whoop=connected | error)
(function handleWhoopRedirect() {
  const params = new URLSearchParams(location.search);
  const w = params.get("whoop");
  if (!w) return;
  // Strip the param from the URL bar
  params.delete("whoop");
  const detail = params.get("detail");
  params.delete("detail");
  const newSearch = params.toString();
  history.replaceState({}, "", location.pathname + (newSearch ? "?" + newSearch : ""));
  if (w === "connected") {
    setWhoopConnectedCached(true);
    updateWhoopButton();
    setStatus("WHOOP connected — fetching recovery…");
    fetchWhoopRecovery();
  } else if (w === "error") {
    setWhoopConnectedCached(false);
    updateWhoopButton();
    setStatus("WHOOP connect failed: " + (detail || "unknown"), true);
  }
})();

updateWhoopButton();
checkWhoopStatus().then((ok) => {
  if (ok && loadWhoopRecovery().length === 0) fetchWhoopRecovery();
});
