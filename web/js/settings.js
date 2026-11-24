import { api, backendBase, setBackendBase } from "./api.js";
import { livekitState, switchInput, switchOutput, voiceBus } from "./livekit.js";

export async function renderSettings() {
  const health = await api.health().catch((e) => ({ error: e.message }));
  const remote = await api.settings().catch(() => ({}));
  document.getElementById("setting-agent-name").value =
    remote.agent_name || health.agent?.name || "Lauki AI Support Assistant";
  document.getElementById("setting-available").checked = remote.agent_available !== false;
  document.getElementById("setting-backend-url").value = backendBase() || window.location.origin;
  document.getElementById("setting-livekit").textContent = health.livekit?.configured
    ? `Connected configuration on ${health.livekit.host}`
    : health.error || "LiveKit is not configured on the server.";
  document.getElementById("setting-theme").value = document.documentElement.dataset.theme || "dark";
}

export function initSettings() {
  document.getElementById("settings-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const result = document.getElementById("settings-result");
    try {
      setBackendBase(document.getElementById("setting-backend-url").value.trim());
      await api.saveSettings({
        agent_name: document.getElementById("setting-agent-name").value.trim(),
        agent_available: document.getElementById("setting-available").checked,
      });
      document.documentElement.dataset.theme = document.getElementById("setting-theme").value;
      localStorage.setItem("lauki.theme", document.documentElement.dataset.theme);
      result.textContent = "Settings saved. Agent instructions are not editable from this dashboard.";
    } catch (error) {
      result.textContent = error.message;
    }
  });

  const fill = () => {
    const input = document.getElementById("setting-input");
    const output = document.getElementById("setting-output");
    if (input) {
      input.innerHTML = livekitState.devices.inputs.map((d) => `<option value="${d.deviceId}">${d.label || "Input"}</option>`).join("") || `<option>Available after a voice session requests microphone access</option>`;
    }
    if (output) {
      output.innerHTML = livekitState.devices.outputs.map((d) => `<option value="${d.deviceId}">${d.label || "Output"}</option>`).join("") || `<option>Available after a voice session starts</option>`;
    }
  };
  voiceBus.addEventListener("devices", fill);
  document.getElementById("setting-input")?.addEventListener("change", (event) => {
    if (event.target.value) switchInput(event.target.value).catch(() => {});
  });
  document.getElementById("setting-output")?.addEventListener("change", (event) => {
    if (event.target.value) switchOutput(event.target.value).catch(() => {});
  });
  fill();
}
