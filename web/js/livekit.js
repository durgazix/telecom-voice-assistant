import { api } from "./api.js";

let Room;
let RoomEvent;
let ConnectionState;
let ParticipantKind;
let Track;

export const voiceBus = new EventTarget();

export const livekitState = {
  status: "idle",
  roomName: null,
  identity: null,
  sessionId: null,
  muted: false,
  error: null,
  agentPresent: false,
  permission: "unknown",
  startedAt: null,
  localStream: null,
  remoteStream: null,
  devices: { inputs: [], outputs: [] },
};

let room = null;
let durationTimer = null;

function emit(name, detail) {
  voiceBus.dispatchEvent(new CustomEvent(name, { detail }));
}

function setStatus(status, extra = {}) {
  livekitState.status = status;
  Object.assign(livekitState, extra);
  emit("status", { ...livekitState });
}

async function loadSdk() {
  if (Room) return;
  const mod = await import("https://cdn.jsdelivr.net/npm/livekit-client@2.15.8/dist/livekit-client.esm.mjs");
  Room = mod.Room;
  RoomEvent = mod.RoomEvent;
  ConnectionState = mod.ConnectionState;
  ParticipantKind = mod.ParticipantKind;
  Track = mod.Track;
}

async function refreshDevices() {
  if (!Room) return;
  try {
    livekitState.devices.inputs = await Room.getLocalDevices("audioinput");
    livekitState.devices.outputs = await Room.getLocalDevices("audiooutput");
  } catch {
    livekitState.devices.inputs = [];
    livekitState.devices.outputs = [];
  }
  emit("devices", livekitState.devices);
}

function streamFromTrack(track) {
  if (!track) return null;
  if (track.mediaStream) return track.mediaStream;
  if (track.mediaStreamTrack) return new MediaStream([track.mediaStreamTrack]);
  return null;
}

function isAgentParticipant(participant) {
  if (!participant) return false;
  return (
    participant.kind === ParticipantKind?.AGENT ||
    String(participant.identity || "").toLowerCase().includes("agent")
  );
}

function applyAgentState(participant) {
  if (!room) return;
  const agentState = participant?.attributes?.["lk.agent.state"];
  if (!agentState) return;
  livekitState.agentPresent = true;
  const map = {
    initializing: "connecting",
    listening: "listening",
    thinking: "processing",
    speaking: "speaking",
  };
  if (map[agentState]) setStatus(map[agentState]);
}

function attachRemoteAudio(track) {
  const el = track.attach();
  el.autoplay = true;
  el.playsInline = true;
  el.dataset.lkAgent = "true";
  document.body.appendChild(el);
  livekitState.remoteStream = streamFromTrack(track) || el.srcObject;
  emit("remote-audio", livekitState.remoteStream);
}

function detachRemoteAudio() {
  document.querySelectorAll("[data-lk-agent]").forEach((el) => {
    el.remove();
  });
  livekitState.remoteStream = null;
}

function decodeData(payload) {
  try {
    return JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return null;
  }
}

export async function startVoiceSession() {
  if (livekitState.status === "connecting" || livekitState.status === "listening" || livekitState.status === "speaking" || livekitState.status === "processing") {
    return;
  }
  setStatus("connecting", { error: null, agentPresent: false });
  try {
    await loadSdk();
  } catch (error) {
    setStatus("error", { error: "Could not load the LiveKit JavaScript SDK." });
    throw error;
  }

  let creds;
  try {
    creds = await api.token();
  } catch (error) {
    setStatus("error", { error: error.message });
    throw error;
  }

  const session = await api.createSession({
    room: creds.room,
    identity: creds.identity,
    source: "voice",
    status: "in_progress",
  });

  livekitState.roomName = creds.room;
  livekitState.identity = creds.identity;
  livekitState.sessionId = session.id;
  livekitState.startedAt = Date.now();

  room = new Room({
    adaptiveStream: true,
    dynacast: true,
    audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });

  room.on(RoomEvent.ConnectionStateChanged, (state) => {
    if (state === ConnectionState.Disconnected) {
      if (livekitState.status !== "idle") setStatus("disconnected");
    }
  });

  room.on(RoomEvent.ParticipantConnected, (participant) => {
    if (isAgentParticipant(participant)) {
      livekitState.agentPresent = true;
      applyAgentState(participant);
      emit("agent", { present: true, identity: participant.identity });
    }
  });

  room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
    const isMic = track.kind === "audio" || publication?.source === Track?.Source?.Microphone;
    if (isMic && !participant?.isLocal) {
      livekitState.agentPresent = true;
      attachRemoteAudio(track);
      emit("agent", { present: true, identity: participant.identity });
    }
  });

  room.on(RoomEvent.TrackUnsubscribed, (track) => {
    if (track.kind === "audio") track.detach();
  });

  room.on(RoomEvent.ParticipantAttributesChanged, (_changed, participant) => {
    if (isAgentParticipant(participant) || participant?.attributes?.["lk.agent.state"]) {
      applyAgentState(participant);
    }
  });

  room.on(RoomEvent.TranscriptionReceived, (segments, participant) => {
    for (const segment of segments) {
      const role = participant?.isLocal ? "customer" : "agent";
      emit("transcript", {
        role,
        text: segment.text,
        final: segment.final,
        ts: Date.now(),
      });
    }
  });

  room.on(RoomEvent.DataReceived, (payload, _p, _kind, topic) => {
    if (topic && topic !== "lauki.events") return;
    const message = decodeData(payload);
    if (!message) return;
    emit("agent-event", message);
  });

  room.on(RoomEvent.Disconnected, () => {
    cleanupRoom(false);
    setStatus("disconnected");
  });

  room.on(RoomEvent.MediaDevicesError, (error) => {
    livekitState.permission = "denied";
    setStatus("error", { error: error.message || "Microphone permission denied." });
  });

  try {
    await room.connect(creds.url, creds.token);
    await room.localParticipant.setMicrophoneEnabled(true);
    livekitState.permission = "granted";
    livekitState.muted = false;
    const micPub = room.localParticipant.getTrackPublication?.("microphone") ||
      [...room.localParticipant.audioTrackPublications.values()][0];
    const micTrack = micPub?.track;
    livekitState.localStream = micTrack?.mediaStream || null;
    emit("local-audio", livekitState.localStream);
    await refreshDevices();
    room.remoteParticipants.forEach((participant) => {
      if (isAgentParticipant(participant)) {
        livekitState.agentPresent = true;
        applyAgentState(participant);
      }
    });
    if (!livekitState.agentPresent) setStatus("connecting");
    else if (livekitState.status === "connecting") setStatus("listening");
    startDurationClock();
  } catch (error) {
    cleanupRoom(true);
    setStatus("error", { error: error.message || "LiveKit connection failed." });
    throw error;
  }
}

function startDurationClock() {
  clearInterval(durationTimer);
  durationTimer = setInterval(() => {
    if (!livekitState.startedAt || !room) return;
    emit("duration", Math.floor((Date.now() - livekitState.startedAt) / 1000));
    let remote = 0;
    room.remoteParticipants.forEach((participant) => {
      remote = Math.max(remote, participant.audioLevel || 0);
    });
    emit("levels", { local: room.localParticipant?.audioLevel || 0, remote });
  }, 100);
}

function cleanupRoom(disconnect) {
  clearInterval(durationTimer);
  detachRemoteAudio();
  if (disconnect && room) {
    try {
      room.disconnect();
    } catch {
      /* ignore */
    }
  }
  room = null;
  livekitState.localStream = null;
  livekitState.remoteStream = null;
}

export async function endVoiceSession(status = "resolved") {
  const duration = livekitState.startedAt ? Math.floor((Date.now() - livekitState.startedAt) / 1000) : 0;
  const sessionId = livekitState.sessionId;
  cleanupRoom(true);
  livekitState.startedAt = null;
  livekitState.sessionId = null;
  livekitState.agentPresent = false;
  setStatus("idle");
  if (sessionId) {
    try {
      await api.patchSession(sessionId, {
        duration_seconds: duration,
        status,
        ended_at: new Date().toISOString(),
      });
    } catch {
      /* session persistence should not block hangup */
    }
  }
}

export async function setMuted(muted) {
  if (!room) return;
  await room.localParticipant.setMicrophoneEnabled(!muted);
  livekitState.muted = muted;
  emit("mute", muted);
}

export async function switchInput(deviceId) {
  if (!room) return;
  await room.switchActiveDevice("audioinput", deviceId);
}

export async function switchOutput(deviceId) {
  if (!room) return;
  if (room.switchActiveDevice) await room.switchActiveDevice("audiooutput", deviceId);
}

export function getRoom() {
  return room;
}
