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

const el = (id) => document.getElementById(id);
const startBtn = el("startBtn");
const stopBtn = el("stopBtn");
const pipBtn = el("pipBtn");
const wakeBtn = el("wakeBtn");
const previewChk = el("previewChk");
const videoWrap = el("videoWrap");
const video = el("video");
const pipCanvas = el("pipCanvas");
const chart = el("chart");
const rateVal = el("rateVal");
const varVal = el("varVal");
const totalVal = el("totalVal");
const sessionVal = el("sessionVal");
const statusEl = el("status");

const state = {
  landmarker: null,
  stream: null,
  rafId: null,
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
};

function setStatus(msg, isErr = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("err", isErr);
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

function detectLoop() {
  if (!state.landmarker || !state.stream) return;
  if (video.readyState >= 2) {
    const res = state.landmarker.detectForVideo(video, performance.now());
    const bs = res?.faceBlendshapes?.[0]?.categories;
    if (bs) {
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
          state.blinkTimes.push(Date.now());
          totalBlinkCount++;
        }
      }
    }
  }
  state.rafId = requestAnimationFrame(detectLoop);
}

function sample() {
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  while (state.blinkTimes.length && state.blinkTimes[0] < cutoff) state.blinkTimes.shift();
  const elapsedSec = Math.min((now - state.startedAt) / 1000, 60);
  const rate = elapsedSec > 0
    ? state.blinkTimes.length * (60 / Math.max(elapsedSec, 1))
    : 0;

  state.rateHistory.push({ t: now, v: rate });
  const chartCutoff = now - CHART_WINDOW_MS;
  while (state.rateHistory.length && state.rateHistory[0].t < chartCutoff) state.rateHistory.shift();

  const recent = state.rateHistory.slice(-VAR_WINDOW_SAMPLES).map((p) => p.v);
  const variation = stddev(recent);
  state.varHistory.push({ t: now, v: variation });
  while (state.varHistory.length && state.varHistory[0].t < chartCutoff) state.varHistory.shift();
}

function stddev(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const s = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
  return Math.sqrt(s);
}

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function updateUI() {
  const last = state.rateHistory.at(-1)?.v ?? 0;
  const lastVar = state.varHistory.at(-1)?.v ?? 0;
  rateVal.textContent = last.toFixed(1);
  varVal.textContent = lastVar.toFixed(2);
  totalVal.textContent = String(totalBlinkCount);
  sessionVal.textContent = fmtTime(Date.now() - state.startedAt);
  drawChart();
  drawPipCanvas(last, lastVar);
}

let totalBlinkCount = 0;

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

  ctx.strokeStyle = "#252b3a";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(pad.l, pad.t, w, h);
  ctx.stroke();

  const now = Date.now();
  const tMin = now - CHART_WINDOW_MS;
  const rates = state.rateHistory;
  const vars = state.varHistory;

  const rateMaxData = Math.max(20, ...rates.map((p) => p.v));
  const rateMax = Math.ceil(rateMaxData / 5) * 5;
  const varMaxData = Math.max(5, ...vars.map((p) => p.v));
  const varMax = Math.ceil(varMaxData);

  ctx.fillStyle = "#8a93a6";
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (h * i) / 4;
    const v = rateMax * (1 - i / 4);
    ctx.fillText(v.toFixed(0), pad.l - 6, y);
    ctx.strokeStyle = "#1b2030";
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

  if (rates.length > 1) {
    ctx.strokeStyle = "#60a5fa";
    ctx.lineWidth = 2;
    ctx.beginPath();
    rates.forEach((p, i) => {
      const x = toX(p.t), y = toYRate(p.v);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
  if (vars.length > 1) {
    ctx.strokeStyle = "#f472b6";
    ctx.lineWidth = 2;
    ctx.beginPath();
    vars.forEach((p, i) => {
      const x = toX(p.t), y = toYVar(p.v);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
}

function drawPipCanvas(rate, variation) {
  const ctx = pipCanvas.getContext("2d");
  const W = pipCanvas.width, H = pipCanvas.height;
  ctx.fillStyle = "#0b0d12";
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = "#8a93a6";
  ctx.font = "18px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText("Blink rate", 24, 24);
  ctx.fillText("Variazione", W / 2 + 12, 24);

  ctx.fillStyle = "#e8ecf4";
  ctx.font = "bold 78px system-ui, sans-serif";
  ctx.fillText(rate.toFixed(1), 24, 48);
  ctx.fillText(variation.toFixed(2), W / 2 + 12, 48);

  ctx.fillStyle = "#8a93a6";
  ctx.font = "16px system-ui, sans-serif";
  ctx.fillText("blink / min", 24, 140);
  ctx.fillText("σ (15 s)", W / 2 + 12, 140);

  const pad = 24;
  const top = 190;
  const h = H - top - 20;
  const w = W - 2 * pad;
  ctx.strokeStyle = "#252b3a";
  ctx.strokeRect(pad, top, w, h);

  const now = Date.now();
  const rateMax = Math.max(20, ...state.rateHistory.map((p) => p.v));
  if (state.rateHistory.length > 1) {
    ctx.strokeStyle = "#60a5fa";
    ctx.lineWidth = 3;
    ctx.beginPath();
    state.rateHistory.forEach((p, i) => {
      const x = pad + w * (1 - (now - p.t) / CHART_WINDOW_MS);
      const y = top + h * (1 - Math.min(p.v, rateMax) / rateMax);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
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
  } catch (e) {
    setStatus("Picture-in-Picture non disponibile: " + e.message, true);
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
  totalBlinkCount = 0;
  state.rafId = requestAnimationFrame(detectLoop);
  state.sampleTimer = setInterval(sample, SAMPLE_INTERVAL_MS);
  state.uiTimer = setInterval(updateUI, 250);
  stopBtn.disabled = false;
  pipBtn.disabled = !("pictureInPictureEnabled" in document) || !document.pictureInPictureEnabled;
  setStatus("In esecuzione — guarda la webcam normalmente.");
}

function stop() {
  if (state.rafId) cancelAnimationFrame(state.rafId);
  if (state.sampleTimer) clearInterval(state.sampleTimer);
  if (state.uiTimer) clearInterval(state.uiTimer);
  state.rafId = state.sampleTimer = state.uiTimer = null;
  stopCamera();
  startBtn.disabled = false;
  stopBtn.disabled = true;
  pipBtn.disabled = true;
  setStatus("Fermato.");
}

previewChk.addEventListener("change", () => {
  videoWrap.hidden = !previewChk.checked;
});
startBtn.addEventListener("click", start);
stopBtn.addEventListener("click", stop);
pipBtn.addEventListener("click", togglePip);
wakeBtn.addEventListener("click", toggleWakeLock);

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && state.wakeLock === null && wakeBtn.getAttribute("aria-pressed") === "true") {
    try { state.wakeLock = await navigator.wakeLock.request("screen"); } catch {}
  }
});
