const DEFAULT_BASE = "";

export function backendBase() {
  return localStorage.getItem("lauki.backendUrl") || DEFAULT_BASE;
}

export function setBackendBase(url) {
  const value = (url || "").replace(/\/$/, "");
  localStorage.setItem("lauki.backendUrl", value);
}

async function request(path, options = {}) {
  const url = `${backendBase()}${path}`;
  let response;
  try {
    response = await fetch(url, {
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch (error) {
    throw new Error("Backend unreachable. Start the dashboard API on this origin.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.detail;
    const message =
      typeof detail === "string"
        ? detail
        : detail?.message || data.message || `Request failed (${response.status})`;
    const err = new Error(message);
    err.status = response.status;
    err.payload = data;
    throw err;
  }
  return data;
}

export const api = {
  health: () => request("/api/health"),
  token: (body) => request("/api/livekit/token", { method: "POST", body: body || {} }),
  plans: () => request("/api/catalog/plans"),
  regions: () => request("/api/catalog/regions"),
  searchPlans: (query, sessionId) =>
    request("/api/tools/search_plans", { method: "POST", body: { query, session_id: sessionId } }),
  checkBalance: (phoneNumber, sessionId) =>
    request("/api/tools/check_account_balance", {
      method: "POST",
      body: { phone_number: phoneNumber, session_id: sessionId },
    }),
  network: (region, sessionId) =>
    request("/api/tools/check_network_status", { method: "POST", body: { region, session_id: sessionId } }),
  recommend: (payload, sessionId) =>
    request("/api/tools/get_plan_recommendation", { method: "POST", body: { ...payload, session_id: sessionId } }),
  planDetails: (planName, sessionId) =>
    request("/api/tools/get_plan_details", { method: "POST", body: { plan_name: planName, session_id: sessionId } }),
  escalate: (reason, sessionId) =>
    request("/api/tools/escalate_to_support", { method: "POST", body: { reason, session_id: sessionId } }),
  sessions: () => request("/api/sessions"),
  session: (id) => request(`/api/sessions/${id}`),
  createSession: (body) => request("/api/sessions", { method: "POST", body }),
  patchSession: (id, body) => request(`/api/sessions/${id}`, { method: "PATCH", body }),
  toolEvents: () => request("/api/tools/events"),
  analytics: () => request("/api/analytics"),
  settings: () => request("/api/settings"),
  saveSettings: (body) => request("/api/settings", { method: "PUT", body }),
};

export function maskPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length !== 10) return null;
  return `${digits.slice(0, 3)}****${digits.slice(-3)}`;
}

export function maskText(value) {
  return String(value ?? "").replace(/\b\d{10}\b/g, (digits) => maskPhone(digits) || digits);
}

export function escapeHtml(value) {
  return maskText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatDuration(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

export function formatTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}
