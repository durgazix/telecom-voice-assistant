import { api, formatDuration } from "./api.js";
import {
  livekitState,
  voiceBus,
  startVoiceSession,
  endVoiceSession,
  setMuted,
  switchInput,
  switchOutput,
} from "./livekit.js";

const STATE_COPY = {
  idle: "Ready for a customer call",
  connecting: "Connecting to LiveKit…",
  listening: "Listening",
  processing: "Processing",
  speaking: "Speaking",
  disconnected: "Disconnected",
  error: "Connection error",
};

let orbCanvas;
let waveCanvas;
let orbCtx;
let waveCtx;
let localAnalyser;
let remoteAnalyser;
let audioCtx;
let animating = false;
let level = 0;
let liveLevels = { local: 0, remote: 0 };
let currentStatus = "idle";
let transcriptEl;
let pendingUserId = null;
let lastBubble = null;

function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function connectStream(stream, kind) {
  if (!stream) return;
  const ctx = ensureAudio();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  if (kind === "local") localAnalyser = analyser;
  else remoteAnalyser = analyser;
}

function rms(analyser) {
  if (!analyser) return 0;
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (const v of data) {
    const n = (v - 128) / 128;
    sum += n * n;
  }
  return Math.sqrt(sum / data.length);
}

function draw() {
  if (!orbCanvas || !waveCanvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = orbCanvas.clientWidth;
  const h = orbCanvas.clientHeight;
  orbCanvas.width = w * dpr;
  orbCanvas.height = h * dpr;
  orbCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  orbCtx.clearRect(0, 0, w, h);

  const speaking = currentStatus === "speaking";
  const listening = currentStatus === "listening";
  const processing = currentStatus === "processing";
  const measured = speaking
    ? Math.max(rms(remoteAnalyser) * 3.2, liveLevels.remote)
    : listening
      ? Math.max(rms(localAnalyser) * 2.6, liveLevels.local)
      : processing
        ? 0.18
        : currentStatus === "connecting"
          ? 0.12
          : 0.08;
  level += (Math.min(measured, 1) - level) * 0.18;

  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(w, h) * 0.22;
  const glow = orbCtx.createRadialGradient(cx, cy, radius * 0.2, cx, cy, radius * 2.2);
  glow.addColorStop(0, speaking ? "rgba(124,92,255,0.45)" : listening ? "rgba(59,130,246,0.4)" : "rgba(56,189,248,0.18)");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  orbCtx.fillStyle = glow;
  orbCtx.fillRect(0, 0, w, h);

  const bars = 64;
  for (let i = 0; i < bars; i += 1) {
    const a = (i / bars) * Math.PI * 2;
    const amp = radius + 18 + Math.sin(Date.now() / 240 + i) * 6 + level * 48;
    const x1 = cx + Math.cos(a) * (radius + 10);
    const y1 = cy + Math.sin(a) * (radius + 10);
    const x2 = cx + Math.cos(a) * amp;
    const y2 = cy + Math.sin(a) * amp;
    orbCtx.strokeStyle = `hsla(${214 + i * 1.2}, 90%, 68%, 0.55)`;
    orbCtx.lineWidth = 2;
    orbCtx.beginPath();
    orbCtx.moveTo(x1, y1);
    orbCtx.lineTo(x2, y2);
    orbCtx.stroke();
  }

  const core = orbCtx.createRadialGradient(cx - 12, cy - 16, 8, cx, cy, radius);
  core.addColorStop(0, "#dbeafe");
  core.addColorStop(0.45, currentStatus === "error" ? "#f87171" : "#60a5fa");
  core.addColorStop(1, "#312e81");
  orbCtx.fillStyle = core;
  orbCtx.beginPath();
  orbCtx.arc(cx, cy, radius, 0, Math.PI * 2);
  orbCtx.fill();

  const ww = waveCanvas.clientWidth;
  const wh = waveCanvas.clientHeight;
  waveCanvas.width = ww * dpr;
  waveCanvas.height = wh * dpr;
  waveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  waveCtx.clearRect(0, 0, ww, wh);
  waveCtx.beginPath();
  const analyser = speaking ? remoteAnalyser : localAnalyser;
  const bins = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
  if (bins) analyser.getByteFrequencyData(bins);
  const steps = 48;
  for (let i = 0; i < steps; i += 1) {
    const v = bins ? bins[Math.floor((i / steps) * bins.length)] / 255 : level;
    const barH = 8 + v * (wh - 16);
    const x = (ww / steps) * i + 2;
    waveCtx.fillStyle = `rgba(96,165,250,${0.25 + v * 0.6})`;
    waveCtx.fillRect(x, (wh - barH) / 2, Math.max(ww / steps - 4, 2), barH);
  }

  if (animating) requestAnimationFrame(draw);
}

function addBubble({ role, text, ts, kind }) {
  if (!transcriptEl || !text) return;
  const signature = `${role}:${text}`;
  if (lastBubble && lastBubble.signature === signature && Date.now() - lastBubble.at < 4000) return;
  const empty = transcriptEl.querySelector(".empty");
  if (empty) empty.remove();
  const node = document.createElement("div");
  node.className = `bubble ${role === "agent" ? "agent" : role === "tool" ? "tool" : ""}`;
  const when = new Date(ts || Date.now()).toLocaleTimeString();
  const who = kind === "tool" ? "Tool" : role === "agent" ? "Lauki AI" : "Customer";
  const whoEl = document.createElement("div");
  whoEl.className = "who";
  whoEl.innerHTML = `<span></span><span></span>`;
  whoEl.children[0].textContent = who;
  whoEl.children[1].textContent = when;
  const body = document.createElement("div");
  body.textContent = text;
  node.append(whoEl, body);
  transcriptEl.appendChild(node);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  lastBubble = { signature, at: Date.now(), body };
}

function renderStatus() {
  const statusEl = document.getElementById("voice-state");
  const connEl = document.getElementById("voice-connection");
  const permEl = document.getElementById("mic-permission");
  const errEl = document.getElementById("voice-error");
  if (statusEl) statusEl.textContent = STATE_COPY[currentStatus] || currentStatus;
  if (connEl) connEl.textContent = livekitState.roomName ? `Room ${livekitState.roomName}` : "Not connected";
  if (permEl) permEl.textContent = `Microphone: ${livekitState.permission}`;
  if (errEl) {
    errEl.textContent = livekitState.error || "";
    errEl.style.display = livekitState.error ? "block" : "none";
  }
  const startBtn = document.getElementById("start-session");
  const endBtn = document.getElementById("end-session");
  const muteBtn = document.getElementById("mute-session");
  const live = ["connecting", "listening", "processing", "speaking"].includes(currentStatus);
  if (startBtn) startBtn.disabled = live;
  if (endBtn) endBtn.disabled = !live && currentStatus !== "disconnected";
  if (muteBtn) {
    muteBtn.disabled = !live;
    muteBtn.textContent = livekitState.muted ? "Unmute microphone" : "Mute microphone";
  }
  document.querySelector(".orb-stage")?.setAttribute("data-state", currentStatus);
}

function fillDevices() {
  const input = document.getElementById("audio-input");
  const output = document.getElementById("audio-output");
  const fill = (select, list) => {
    if (!select) return;
    const current = select.value;
    select.innerHTML = list.length
      ? list.map((d) => `<option value="${d.deviceId}">${d.label || "Device"}</option>`).join("")
      : `<option value="">No devices reported</option>`;
    if (current) select.value = current;
  };
  fill(input, livekitState.devices.inputs);
  fill(output, livekitState.devices.outputs);
}

async function persistTranscript(entry) {
  if (!livekitState.sessionId) return;
  try {
    await api.patchSession(livekitState.sessionId, { append_transcript: [entry] });
  } catch {
    /* ignore */
  }
}

export function initVoice() {
  orbCanvas = document.getElementById("orb-canvas");
  waveCanvas = document.getElementById("wave-canvas");
  if (!orbCanvas || !waveCanvas) return;
  orbCtx = orbCanvas.getContext("2d");
  waveCtx = waveCanvas.getContext("2d");
  transcriptEl = document.getElementById("transcript-log");
  animating = true;
  draw();

  document.getElementById("start-session")?.addEventListener("click", async () => {
    const ctx = ensureAudio();
    ctx.resume?.();
    try {
      await startVoiceSession();
    } catch {
      renderStatus();
    }
  });
  document.getElementById("end-session")?.addEventListener("click", () => endVoiceSession("resolved"));
  document.getElementById("mute-session")?.addEventListener("click", () => setMuted(!livekitState.muted));
  document.getElementById("audio-input")?.addEventListener("change", (e) => switchInput(e.target.value));
  document.getElementById("audio-output")?.addEventListener("change", (e) => switchOutput(e.target.value));

  voiceBus.addEventListener("status", (e) => {
    currentStatus = e.detail.status;
    renderStatus();
  });
  voiceBus.addEventListener("duration", (event) => {
    const el = document.getElementById("session-duration");
    if (el) el.textContent = formatDuration(event.detail);
  });
  voiceBus.addEventListener("levels", (event) => {
    liveLevels = event.detail || liveLevels;
  });
  voiceBus.addEventListener("devices", fillDevices);
  voiceBus.addEventListener("local-audio", (e) => connectStream(e.detail, "local"));
  voiceBus.addEventListener("remote-audio", (e) => connectStream(e.detail, "remote"));
  voiceBus.addEventListener("transcript", (e) => {
    const { role, text, final } = e.detail;
    if (!final && role === "customer") {
      if (!pendingUserId) {
        addBubble({ role, text, kind: "speech" });
        pendingUserId = true;
      } else {
        const last = transcriptEl?.querySelector(".bubble:last-child div:last-child");
        if (last) last.textContent = text;
        if (lastBubble) lastBubble.signature = `${role}:${text}`;
      }
      return;
    }
    pendingUserId = null;
    addBubble({ role, text, kind: "speech" });
    persistTranscript({ role, text, ts: new Date().toISOString(), kind: "speech" });
  });
  voiceBus.addEventListener("agent-event", (e) => {
    const msg = e.detail;
    if (msg.type === "transcript") {
      addBubble({ role: msg.role === "user" ? "customer" : "agent", text: msg.text, kind: "speech" });
      persistTranscript({ role: msg.role, text: msg.text, ts: new Date().toISOString(), kind: "speech" });
    }
    if (msg.type === "tool") {
      for (const tool of msg.tools || []) {
        addBubble({
          role: "tool",
          kind: "tool",
          text: `${tool.name} ${tool.ok ? "completed" : "failed"} — ${tool.result || ""}`.slice(0, 400),
        });
      }
      if (livekitState.sessionId) {
        api.patchSession(livekitState.sessionId, { append_tools: msg.tools || [] }).catch(() => {});
      }
    }
  });
  renderStatus();
}
