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
const VAR_WINDOW_SAMPLES = 30;
const CHART_WINDOW_MS = 120_000;
const UI_ROLLING_MS = 5 * 60_000;
const BLINK_RETENTION_MS = 5 * 60_000;
const FACE_LOST_MS = 1500;
const FACE_BACK_MS = 500;
const TICK_INTERVAL_MS = 40;
const SESSIONS_KEY = "blinkSessions.v1";
const MAX_STORED_SESSIONS = 20;
const BASELINES_KEY = "blinkBaselines.v1";
const EVENTS_KEY = "blinkCalendarEvents.v1";
const COG_TICK_MS = 2000;

const EVENT_CLASSES = [
  { id: "business_call", label: "Business call" },
  { id: "chill_call",    label: "Chill call" },
  { id: "deep_work",     label: "Deep work" },
  { id: "meeting",       label: "Riunione" },
  { id: "other",         label: "Altro" },
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
const startBtn = el("startBtn");
const stopBtn = el("stopBtn");
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
const icsFileInput = el("icsFile");
const calEventList = el("calEventList");
const clearEventsBtn = el("clearEventsBtn");
const calStats = el("calStats");
const calStatsBody = el("calStatsBody");
let currentReportSession = null;

const state = {
  landmarker: null,
  stream: null,
  tickWorker: null,
  sampleTimer: null,
  uiTimer: null,
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
  setStatus("Carico modello di face landmark…");
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
        setStatus("Ripreso — volto rilevato.");
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
      setStatus("In pausa — nessun volto rilevato.");
      setPulse("err", "In pausa");
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
  sessionVal.textContent = fmtTime(activeMs) + (state.paused ? " · in pausa" : "");
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
    setStatus("Screen wake lock disattivato.");
    return;
  }
  if (!("wakeLock" in navigator)) {
    setStatus("Wake Lock non supportato dal browser.", true);
    return;
  }
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener("release", () => {
      wakeBtn.setAttribute("aria-pressed", "false");
    });
    wakeBtn.setAttribute("aria-pressed", "true");
    setStatus("Schermo tenuto attivo.");
  } catch (e) {
    setStatus("Wake lock fallito: " + e.message, true);
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
    setStatus("Picture-in-Picture non disponibile: " + e.message, true);
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
  } catch (e) {
    setStatus("Impossibile salvare in localStorage: " + e.message, true);
  }
}

function persistCurrentSession() {
  if (!state.startedAt || state.rateHistory.length === 0) return null;
  const endedAt = Date.now();
  const rates = state.rateHistory.map((p) => p.v);
  const avg = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;
  const session = {
    id: "s_" + state.startedAt,
    startedAt: state.startedAt,
    endedAt,
    durationMs: endedAt - state.startedAt,
    totalBlinks: state.totalBlinks,
    avgRate: avg,
    samples: state.rateHistory.map((p, i) => ({
      t: p.t,
      rate: p.v,
      variation: state.varHistory[i]?.v ?? 0,
    })),
    cogSamples: state.cogHistory.slice(),
    blinkTimes: state.blinkTimes.slice(),
  };
  const sessions = loadSessions();
  sessions.unshift(session);
  while (sessions.length > MAX_STORED_SESSIONS) sessions.pop();
  saveSessions(sessions);
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
    setStatus("Nessuna sessione salvata.", true);
    return;
  }
  const lines = [
    "session_id,started_at,ended_at,duration_seconds,total_blinks,avg_rate_per_min",
  ];
  for (const s of sessions) {
    lines.push([
      s.id,
      new Date(s.startedAt).toISOString(),
      new Date(s.endedAt).toISOString(),
      (s.durationMs / 1000).toFixed(1),
      s.totalBlinks,
      s.avgRate.toFixed(3),
    ].join(","));
  }
  downloadText("blink-sessions-summary.csv", lines.join("\n"));
}

function deleteSession(id) {
  const list = loadSessions().filter((s) => s.id !== id);
  saveSessions(list);
  renderSessions();
  renderCalendarEvents();
}

function clearAllSessions() {
  if (!confirm("Cancellare tutte le sessioni salvate?")) return;
  localStorage.removeItem(SESSIONS_KEY);
  renderSessions();
  renderCalendarEvents();
}

function renderSessions() {
  const sessions = loadSessions();
  sessionList.innerHTML = "";
  if (!sessions.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Nessuna sessione registrata.";
    sessionList.appendChild(empty);
    return;
  }
  for (const s of sessions) {
    const row = document.createElement("div");
    row.className = "session-row";
    const info = document.createElement("div");
    info.className = "session-info";
    const tagLabelTxt = s.tag?.label ? ` · <em>${escapeHtml(s.tag.label)}</em>` : "";
    info.innerHTML = `
      <div class="s-date">${fmtDate(s.startedAt)}</div>
      <div class="s-meta">
        durata ${fmtTime(s.durationMs)} ·
        ${s.totalBlinks} blink ·
        media ${s.avgRate.toFixed(1)}/min${tagLabelTxt}
      </div>
    `;
    const tagRow = document.createElement("div");
    tagRow.className = "session-tag-row";
    const lbl = document.createElement("label");
    lbl.textContent = "Classe";
    const sel = document.createElement("select");
    sel.className = "session-class-select";
    sel.innerHTML = classOptionsHtml(s.tag?.class || "");
    sel.addEventListener("change", () => {
      tagSessionManually(s.id, sel.value || null);
      renderCalendarStats();
    });
    tagRow.appendChild(lbl);
    tagRow.appendChild(sel);
    info.appendChild(tagRow);

    const actions = document.createElement("div");
    actions.className = "session-actions";
    const dl = document.createElement("button");
    dl.textContent = "CSV";
    dl.addEventListener("click", () => downloadSession(s));
    const del = document.createElement("button");
    del.textContent = "Elimina";
    del.className = "danger";
    del.addEventListener("click", () => deleteSession(s.id));
    actions.appendChild(dl);
    actions.appendChild(del);
    row.appendChild(info);
    row.appendChild(actions);
    sessionList.appendChild(row);
  }
}

async function start() {
  startBtn.disabled = true;
  try {
    if (!state.landmarker) await loadLandmarker();
    await startCamera();
  } catch (e) {
    setStatus("Impossibile avviare: " + e.message, true);
    startBtn.disabled = false;
    return;
  }
  state.startedAt = Date.now();
  state.blinkTimes = [];
  state.rateHistory = [];
  state.varHistory = [];
  state.totalBlinks = 0;
  state.eyesClosed = false;
  state.lastBlinkAt = 0;
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

  stopBtn.disabled = false;
  pipBtn.disabled = !("pictureInPictureEnabled" in document) || !document.pictureInPictureEnabled;
  setStatus("In esecuzione — la detection continua anche cambiando tab.");
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
  state.sampleTimer = state.uiTimer = null;
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
    downloadSession(saved);
    setStatus(`Sessione salvata (${saved.totalBlinks} blink in ${fmtTime(saved.durationMs)}). CSV scaricato.`);
    generateReport(saved);
  } else {
    setStatus("Fermato.");
  }
  startBtn.disabled = false;
  stopBtn.disabled = true;
  pipBtn.disabled = true;
  setPulse("idle", "In attesa");
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
    setStatus("Auto-pausa disattivata — ripreso.");
    setPulse("live", "Live");
  }
});
startBtn.addEventListener("click", start);
stopBtn.addEventListener("click", stop);
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
});

exportReportBtn?.addEventListener("click", () => {
  if (!currentReportSession) {
    setStatus("Nessun report disponibile da esportare.", true);
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
  if (abs < 0.3) return `→ stabile (${s >= 0 ? "+" : ""}${s.toFixed(2)}${unit}/min)`;
  if (s > 0) return `↑ +${s.toFixed(2)}${unit}/min`;
  return `↓ ${s.toFixed(2)}${unit}/min`;
}

function generateReport(session) {
  if (!session || session.samples.length < 4) return;

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
    slopePerMin < -0.4 ? `↓ ${slopePerMin.toFixed(1)}/min` : "→ stabile";
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
    repFdTrend.textContent = "dati insufficienti";
    repCfTrend.textContent = "dati insufficienti";
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

  reportSection.hidden = false;
  requestAnimationFrame(() => {
    drawReportChart(session, rates, slope, intercept);
    reportSection.scrollIntoView({ behavior: "smooth", block: "start" });
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
    return anaCard("red", "Concentrazione intensa",
      `Rate medio <strong>${avg.toFixed(1)}/min</strong>, ben al di sotto della norma (12–20/min). ` +
      `Questo indica un focus molto profondo — o una fissazione prolungata che riduce il riflesso di ammiccamento. ` +
      `La riduzione del blink rate accelera l'evaporazione del film lacrimale: fai pause visive frequenti.`);
  if (avg < 12)
    return anaCard("yellow", "Stato di focus elevato",
      `Rate medio <strong>${avg.toFixed(1)}/min</strong>: inferiore alla media fisiologica a riposo. ` +
      `Tipico di attività cognitivamente impegnative come lettura, coding o analisi. ` +
      `Considera la regola 20-20-20: ogni 20 minuti, guarda a 6 m di distanza per 20 secondi.`);
  if (avg < 20)
    return anaCard("green", "Rate fisiologico normale",
      `Rate medio <strong>${avg.toFixed(1)}/min</strong>: nel range sano (12–20/min). ` +
      `Nessun segnale di sovraccarico — mente e occhi in equilibrio durante la sessione.`);
  return anaCard("red", "Segnali di affaticamento",
    `Rate medio <strong>${avg.toFixed(1)}/min</strong>, oltre la norma a riposo. ` +
    `Un tasso elevato può indicare affaticamento visivo, secchezza oculare o stress prolungato. ` +
    `Controlla luminosità, postura e considera una pausa più lunga.`);
}

function buildTrendCard(slopePerMin) {
  if (Math.abs(slopePerMin) < 0.4)
    return anaCard("green", "Andamento stabile",
      `Trendline quasi piatta (<strong>${slopePerMin >= 0 ? "+" : ""}${slopePerMin.toFixed(2)}/min·min</strong>). ` +
      `Stato cognitivo uniforme e sostenuto — ottima coerenza attentiva per tutta la sessione.`);
  if (slopePerMin > 0)
    return anaCard("red", "Affaticamento progressivo",
      `Il blink rate è aumentato di circa <strong>+${slopePerMin.toFixed(1)}/min</strong> per ogni minuto trascorso. ` +
      `Trend crescente = accumulo di fatica cognitiva e visiva. ` +
      `Prova la tecnica Pomodoro: 25 min lavoro + 5 min pausa per spezzare l'accumulo.`);
  return anaCard("iris", "Approfondimento del focus",
    `Il blink rate è calato di circa <strong>${slopePerMin.toFixed(1)}/min</strong> per minuto. ` +
    `Un trend decrescente riflette il classico warm-up cognitivo: dopo una fase iniziale di orientamento, ` +
    `l'attenzione si è consolidata e approfondita progressivamente.`);
}

function buildVarCard(sd) {
  if (sd < 2)
    return anaCard("green", "Stato cognitivo consistente",
      `Variabilità <strong>σ = ${sd.toFixed(2)}</strong> — molto bassa. ` +
      `Il blink rate è rimasto stabile: nessuna distrazione evidente nel pattern motorio oculare, ` +
      `attenzione omogenea e sostenuta.`);
  if (sd < 5)
    return anaCard("yellow", "Variabilità normale",
      `Variabilità <strong>σ = ${sd.toFixed(2)}</strong>. ` +
      `Oscillazioni fisiologiche che riflettono i naturali cicli di attenzione ultradiani (~90 min), ` +
      `micro-pause cognitive e transizioni tra sotto-compiti.`);
  return anaCard("red", "Alta variabilità",
    `Variabilità <strong>σ = ${sd.toFixed(2)}</strong> — elevata. ` +
    `Suggerisce interruzioni frequenti, distrazioni esterne o forti transizioni di stato. ` +
    `Sessioni dedicate a un singolo compito in ambienti a bassa distrazione tendono a ridurla.`);
}

function buildPeaksCard(minRate, maxRate, valleyMin, peakMin) {
  return anaCard("cyan", "Momenti notevoli",
    `<strong>Picco massimo:</strong> ${maxRate.toFixed(1)}/min al minuto ${peakMin} ` +
    `— probabile picco di stress, distrazione o cambio di attività.<br>` +
    `<strong>Minimo registrato:</strong> ${minRate.toFixed(1)}/min al minuto ${valleyMin} ` +
    `— finestra di massima concentrazione della sessione.`);
}

function buildEyeHealthCard(avg, sd) {
  const risk = avg < 8 || (avg < 12 && sd > 4);
  return anaCard(risk ? "yellow" : "green",
    "Salute oculare",
    risk
      ? `Con <strong>${avg.toFixed(1)}/min</strong> sei sotto la soglia raccomandata per il comfort visivo. ` +
        `La riduzione del blink diminuisce la lubrificazione della cornea (sindrome dell'occhio secco da schermo). ` +
        `Usa collirio lubrificante se necessario, e tieni lo schermo leggermente sotto il livello degli occhi.`
      : `<strong>${avg.toFixed(1)}/min</strong> è compatibile con una buona idratazione oculare. ` +
        `Mantieni una distanza di almeno 50–70 cm dallo schermo e fai pause visive periodiche ` +
        `per ridurre lo sforzo accomodativo.`);
}

function buildFocusDepthCard(fdAvg, fdSlopePerMin) {
  const level =
    fdAvg >= 70 ? "profondo" :
    fdAvg >= 50 ? "stabile"  :
    fdAvg >= 35 ? "superficiale" : "disimpegnato";
  const trend = fdSlopePerMin;
  let tone = "iris";
  let body =
    `Focus Depth medio <strong>${fdAvg.toFixed(0)}/100</strong> — stato <strong>${level}</strong>. ` +
    `Questo indice combina soppressione attenzionale del blink, coerenza del ritmo oculare ` +
    `e assenza di rebound, confrontati con la tua baseline personale.`;
  if (trend <= -0.8) {
    tone = "red";
    body += ` Il focus è <strong>calato</strong> di circa ${trend.toFixed(1)} pt/min: l'attenzione si è ` +
      `dispersa progressivamente. Potresti aver attraversato pause cognitive o distrazioni ricorrenti.`;
  } else if (trend >= 0.8) {
    tone = "green";
    body += ` Trend in <strong>crescita</strong> (+${trend.toFixed(1)} pt/min): dopo l'avvio l'attenzione ` +
      `si è consolidata — un classico pattern di warm-up cognitivo.`;
  } else {
    tone = fdAvg >= 50 ? "green" : "yellow";
    body += ` Andamento <strong>stabile</strong> (${trend >= 0 ? "+" : ""}${trend.toFixed(1)} pt/min): ` +
      `stato attenzionale sostenuto per l'intera sessione.`;
  }
  return anaCard(tone, "Focus Depth — interpretazione", body);
}

function buildCognitiveFatigueCard(cfAvg, cfSlopePerMin) {
  const level =
    cfAvg >= 60 ? "elevata" :
    cfAvg >= 40 ? "moderata" :
    cfAvg >= 20 ? "lieve" : "minima";
  const trend = cfSlopePerMin;
  let tone = cfAvg >= 60 ? "red" : cfAvg >= 40 ? "yellow" : "green";
  let body =
    `Cognitive Fatigue media <strong>${cfAvg.toFixed(0)}/100</strong> — fatica <strong>${level}</strong>. ` +
    `Aggrega la deriva temporale del blink rate, la variabilità degli intervalli inter-blink ` +
    `e gli episodi di rebound tipici del disimpegno.`;
  if (trend >= 0.8) {
    tone = "red";
    body += ` La fatica è <strong>cresciuta</strong> di circa +${trend.toFixed(1)} pt/min: chiaro accumulo ` +
      `nel corso della sessione. È il momento ideale per una pausa di recupero (5–10 min).`;
  } else if (trend <= -0.8) {
    body += ` La fatica è <strong>diminuita</strong> di ${trend.toFixed(1)} pt/min: probabile ingresso ` +
      `in uno stato di flow dopo una fase iniziale di aggiustamento.`;
  } else {
    body += ` Andamento piatto (${trend >= 0 ? "+" : ""}${trend.toFixed(1)} pt/min): carico cognitivo ` +
      `costante, senza accumulo evidente.`;
  }
  return anaCard(tone, "Cognitive Fatigue — interpretazione", body);
}

function buildCogInsufficientCard() {
  return anaCard("cyan", "Metriche cognitive",
    `Sessione troppo breve o calibrazione incompleta: servono almeno 3–5 minuti di rilevamento continuo ` +
    `con volto visibile per rendere affidabili <strong>Focus Depth</strong> e <strong>Cognitive Fatigue</strong>. ` +
    `Le stime verranno calcolate automaticamente in sessioni più lunghe.`);
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
  deep:       "Focus profondo",
  stable:     "Focus stabile",
  drifting:   "Drifting",
  fatigue:    "Affaticamento",
  rebound:    "Rebound",
  disengaged: "Disimpegnato",
  calib:      "Calibrazione…",
  idle:       "In attesa",
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
    fdConf.textContent = calibrating ? "calibrazione in corso…" : "dati insufficienti";
  } else {
    fdEl.textContent = String(fd);
    fdBar.style.width = fd + "%";
    fdConf.textContent = `baseline ${cogEffectiveBaseline().toFixed(1)}/min`;
  }

  if (calibrating || cfLow) {
    cfEl.textContent = "—";
    cfBar.style.width = "0%";
    cfConf.textContent = calibrating ? "calibrazione in corso…" : elapsed_s < 180 ? "disponibile dopo 3 min" : "dati insufficienti";
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
    if (el2) el2.textContent = id.endsWith("Val") ? "—" : "in attesa";
  });
  ["fdBar", "cfBar"].forEach(id => {
    const el2 = document.getElementById(id);
    if (el2) el2.style.width = "0%";
  });
  const stEl = document.getElementById("stateLabel");
  if (stEl) { stEl.textContent = "In attesa"; stEl.className = "state-badge state-idle"; }
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
          title: cur.title || "(senza titolo)",
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
  let html = `<option value="">— classifica —</option>`;
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

function renderCalendarEvents() {
  const events = loadEvents().sort((a, b) => b.start - a.start);
  const sessions = loadSessions();
  calEventList.innerHTML = "";
  if (!events.length) {
    const p = document.createElement("p");
    p.className = "cal-empty";
    p.textContent = "Nessun evento importato. Carica un file .ics per iniziare.";
    calEventList.appendChild(p);
    renderCalendarStats();
    return;
  }
  for (const ev of events) {
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
        ? `<div class="cev-match">✓ collegato a sessione ${fmtDate(matched.startedAt)} · media ${matched.avgRate.toFixed(1)}/min</div>`
        : `<div class="cev-no-match">nessuna sessione sovrapposta</div>`}
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
    del.title = "Rimuovi evento";
    del.addEventListener("click", () => {
      const next = loadEvents().filter(e => e.uid !== ev.uid);
      saveEvents(next);
      renderCalendarEvents();
    });

    row.appendChild(info);
    row.appendChild(select);
    row.appendChild(del);
    calEventList.appendChild(row);
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
      <div class="cs-label">${c.label} · ${list.length} sess.</div>
      <div class="cs-row"><span>Rate medio</span><strong>${avg.toFixed(1)}/min</strong></div>
      <div class="cs-row"><span>Variabilità σ</span><strong>${sd.toFixed(2)}</strong></div>
      <div class="cs-row"><span>Focus Depth</span><strong>${fdAvg != null ? fdAvg.toFixed(0) + "/100" : "—"}</strong></div>
      <div class="cs-row"><span>Cognitive Fatigue</span><strong>${cfAvg != null ? cfAvg.toFixed(0) + "/100" : "—"}</strong></div>
    `;
    calStatsBody.appendChild(card);
  }
  calStats.hidden = calStatsBody.children.length === 0;
}

icsFileInput?.addEventListener("change", async () => {
  const file = icsFileInput.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = parseIcs(text);
    if (!parsed.length) {
      setStatus("Nessun evento trovato nel file .ics.", true);
    } else {
      const existing = loadEvents();
      const byUid = new Map(existing.map(e => [e.uid, e]));
      for (const ev of parsed) {
        if (!byUid.has(ev.uid)) byUid.set(ev.uid, ev);
      }
      saveEvents([...byUid.values()]);
      setStatus(`Importati ${parsed.length} eventi dal calendario.`);
      autoMatchSessionsToEvents();
      renderCalendarEvents();
      renderSessions();
    }
  } catch (e) {
    setStatus("Errore lettura .ics: " + e.message, true);
  } finally {
    icsFileInput.value = "";
  }
});

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
  if (!confirm("Cancellare tutti gli eventi importati?")) return;
  saveEvents([]);
  renderCalendarEvents();
});

renderCalendarEvents();
