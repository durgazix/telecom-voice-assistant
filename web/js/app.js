import { api } from "./api.js";
import { initVoice } from "./voice.js";
import { renderOverview } from "./dashboard.js";
import { initTelecomServices } from "./telecom-services.js";
import { initConversations, renderConversations } from "./conversations.js";
import { renderAnalytics } from "./analytics.js";
import { initSettings, renderSettings } from "./settings.js";
import { livekitState, voiceBus } from "./livekit.js";

const TITLES = {
  overview: ["Overview", "Live operations for Lauki Phones support"],
  voice: ["Voice Agent", "Lauki AI Support Assistant"],
  conversations: ["Customer Conversations", "Recorded sessions and tool history"],
  services: ["Telecom Services", "Plans, balance, coverage, escalation"],
  analytics: ["Analytics", "Metrics from recorded backend activity"],
  settings: ["Settings", "Workspace and connection preferences"],
};

function setDot(id, ok, warn = false) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove("ok", "warn", "err");
  el.classList.add(ok ? "ok" : warn ? "warn" : "err");
}

async function refreshHealth() {
  try {
    const health = await api.health();
    setDot("dot-backend", true);
    document.getElementById("label-backend").textContent = "Backend connected";
    setDot("dot-livekit", health.livekit.configured, !health.livekit.configured);
    document.getElementById("label-livekit").textContent = health.livekit.configured
      ? `LiveKit ${health.livekit.host}`
      : "LiveKit not configured";
    setDot("dot-agent", health.agent.available && health.tools_ready, !health.tools_ready);
    document.getElementById("label-agent").textContent = health.agent.available
      ? health.agent.name
      : "Agent marked unavailable";
    document.getElementById("profile-name").textContent = health.agent.name;
  } catch {
    setDot("dot-backend", false);
    document.getElementById("label-backend").textContent = "Backend offline";
    setDot("dot-livekit", false);
    setDot("dot-agent", false);
  }
}

function showPage(id) {
  document.querySelectorAll(".page").forEach((p) => p.classList.toggle("active", p.id === `page-${id}`));
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.page === id));
  const [title, subtitle] = TITLES[id] || TITLES.overview;
  document.getElementById("page-title").textContent = title;
  document.getElementById("page-subtitle").textContent = subtitle;
  location.hash = id;
  document.getElementById("sidebar")?.classList.remove("open");
  document.getElementById("scrim")?.classList.remove("open");
  if (window.lucide) window.lucide.createIcons();
  if (id === "overview") renderOverview();
  if (id === "conversations") renderConversations();
  if (id === "analytics") renderAnalytics();
  if (id === "settings") renderSettings().catch(() => {});
}

function initNav() {
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => showPage(btn.dataset.page));
  });
  document.getElementById("collapse-sidebar")?.addEventListener("click", () => {
    document.getElementById("app-shell").classList.toggle("collapsed");
  });
  document.getElementById("mobile-toggle")?.addEventListener("click", () => {
    document.getElementById("sidebar").classList.add("open");
    document.getElementById("scrim").classList.add("open");
  });
  document.getElementById("scrim")?.addEventListener("click", () => {
    document.getElementById("sidebar").classList.remove("open");
    document.getElementById("scrim").classList.remove("open");
  });
}

window.addEventListener("DOMContentLoaded", async () => {
  const theme = localStorage.getItem("lauki.theme");
  if (theme) document.documentElement.dataset.theme = theme;
  initNav();
  initVoice();
  initTelecomServices();
  initConversations();
  initSettings();
  await refreshHealth();
  setInterval(refreshHealth, 15000);
  voiceBus.addEventListener("status", () => {
    const live = ["connecting", "listening", "processing", "speaking"].includes(livekitState.status);
    setDot("dot-livekit", live || livekitState.status === "idle", livekitState.status === "disconnected");
  });
  const initial = (location.hash || "#overview").replace("#", "");
  showPage(TITLES[initial] ? initial : "overview");
  if (window.lucide) window.lucide.createIcons();
});
