import { api, escapeHtml, formatDuration, formatTime } from "./api.js";
import { livekitState } from "./livekit.js";

function metricCard(label, value, hint, unavailable) {
  return `
    <article class="card metric ${unavailable ? "unavailable" : ""}">
      <h3>${label}</h3>
      <div class="value">${value}</div>
      <div class="hint">${hint}</div>
    </article>
  `;
}

function statusBadge(ok, label) {
  return `<span class="badge ${ok ? "ok" : "warn"}">${label}</span>`;
}

export async function renderOverview() {
  const root = document.getElementById("overview-root");
  if (!root) return;
  root.innerHTML = `<div class="empty"><h4>Loading overview…</h4></div>`;
  let health;
  let analytics;
  let sessions = [];
  try {
    [health, analytics, { sessions }] = await Promise.all([
      api.health(),
      api.analytics(),
      api.sessions(),
    ]);
  } catch (error) {
    root.innerHTML = `<div class="empty"><h4>Overview unavailable</h4><p>${error.message}</p></div>`;
    return;
  }

  const latency = analytics.average_response_latency_ms;
  const agentLive = livekitState.agentPresent && !["idle", "disconnected", "error"].includes(livekitState.status);
  root.innerHTML = `
    <div class="grid cards-3" style="margin-bottom:16px">
      <article class="card">
        <h3>Agent status</h3>
        <p>${statusBadge(health.agent.available, health.agent.available ? "Available" : "Unavailable")}</p>
        <p class="hint" style="color:var(--muted);font-size:13px;margin-top:10px">${agentLive ? "Agent audio is in the current room." : health.agent.worker}</p>
      </article>
      <article class="card">
        <h3>Backend</h3>
        <p>${statusBadge(true, "Connected")}</p>
        <p class="hint" style="color:var(--muted);font-size:13px;margin-top:10px">Tools ${health.tools_ready ? "ready" : "not loaded"}${health.qdrant_ready ? " · plan search indexed" : " · Qdrant not ready"}</p>
      </article>
      <article class="card">
        <h3>LiveKit</h3>
        <p>${statusBadge(health.livekit.configured, health.livekit.configured ? health.livekit.host : "Not configured")}</p>
        <p class="hint" style="color:var(--muted);font-size:13px;margin-top:10px">Secrets stay on the server. This dashboard only receives a short-lived room token.</p>
      </article>
    </div>
    <div class="grid metrics">
      ${metricCard("Voice sessions", analytics.total_voice_sessions, "Completed and in-progress LiveKit sessions", analytics.total_voice_sessions === 0)}
      ${metricCard("Customers assisted", analytics.total_customers_assisted, "Unique masked numbers from balance lookups", analytics.total_customers_assisted === 0)}
      ${metricCard("Balance checks", analytics.account_balance_checks, "Successful check_account_balance results", false)}
      ${metricCard("Plan enquiries", analytics.plan_enquiries, "search_plans + get_plan_details", false)}
      ${metricCard("Network enquiries", analytics.network_enquiries, "check_network_status executions", false)}
      ${metricCard("Escalations", analytics.escalations, "escalate_to_support executions", false)}
      ${metricCard("Avg latency", latency == null ? "Unavailable" : `${latency} ms`, "From recorded tool and reply timings", latency == null)}
    </div>
    <article class="card" style="margin-top:16px">
      <h3>Recent customer interactions</h3>
      ${sessions.length ? `
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Session</th>
                <th>Customer</th>
                <th>Category</th>
                <th>Duration</th>
                <th>Status</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              ${sessions.slice(0, 8).map((s) => `
                <tr>
                  <td>${escapeHtml(s.id)}</td>
                  <td>${escapeHtml(s.phone_masked || "—")}</td>
                  <td>${escapeHtml(s.category || "general")}</td>
                  <td>${formatDuration(s.duration_seconds)}</td>
                  <td>${escapeHtml(s.status || "in_progress")}</td>
                  <td>${escapeHtml(formatTime(s.started_at))}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>` : `<div class="empty"><h4>No sessions yet</h4><p>Start a voice session or run a telecom service to record activity. Nothing is simulated.</p></div>`}
      ${analytics.unavailable?.length ? `<p class="hint" style="color:var(--muted);font-size:12px;margin-top:12px">${analytics.unavailable.join(" ")}</p>` : ""}
    </article>
  `;
}
