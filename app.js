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
const reportAnalysis = el("reportAnalysis");

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
}

function clearAllSessions() {
  if (!confirm("Cancellare tutte le sessioni salvate?")) return;
  localStorage.removeItem(SESSIONS_KEY);
  renderSessions();
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
    info.innerHTML = `
      <div class="s-date">${fmtDate(s.startedAt)}</div>
      <div class="s-meta">
        durata ${fmtTime(s.durationMs)} ·
        ${s.totalBlinks} blink ·
        media ${s.avgRate.toFixed(1)}/min
      </div>
    `;
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
  renderSessions();
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

function generateReport(session) {
  if (!session || session.samples.length < 4) return;

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

  drawReportChart(session, rates, slope, intercept);

  const peakIdx   = rates.indexOf(maxRate);
  const valleyIdx = rates.indexOf(minRate);
  const peakMin   = ((samples[peakIdx].t - session.startedAt) / 60000).toFixed(1);
  const valleyMin = ((samples[valleyIdx].t - session.startedAt) / 60000).toFixed(1);

  reportAnalysis.innerHTML = [
    buildFocusCard(avg),
    buildTrendCard(slopePerMin),
    buildVarCard(sd),
    buildPeaksCard(minRate, maxRate, valleyMin, peakMin),
    buildEyeHealthCard(avg, sd),
  ].join("");

  reportSection.hidden = false;
  requestAnimationFrame(() =>
    reportSection.scrollIntoView({ behavior: "smooth", block: "start" })
  );
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

