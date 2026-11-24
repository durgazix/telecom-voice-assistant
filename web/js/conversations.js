import { api, escapeHtml, formatDuration, formatTime } from "./api.js";

function matches(session, { q, category, date }) {
  const hay = `${session.id} ${session.phone_masked || ""} ${session.category || ""}`.toLowerCase();
  if (q && !hay.includes(q.toLowerCase())) return false;
  if (category && session.category !== category) return false;
  if (date && !(session.started_at || "").startsWith(date)) return false;
  return true;
}

function detailHtml(session) {
  const transcript = session.transcript?.length
    ? session.transcript
        .map((t) => `<div class="bubble ${t.role === "agent" || t.role === "assistant" ? "agent" : t.kind === "tool" ? "tool" : ""}"><div class="who"><span>${escapeHtml(t.role || t.kind || "speech")}</span><span>${escapeHtml(formatTime(t.ts))}</span></div><div>${escapeHtml(t.text || t.result || "")}</div></div>`)
        .join("")
    : `<div class="empty"><h4>No transcript stored</h4><p>Transcripts appear when LiveKit transcription or agent events are received during a session.</p></div>`;
  const tools = session.tools?.length
    ? session.tools
        .map((t) => `<div class="bubble tool"><div class="who"><span>${escapeHtml(t.name || t.tool || "tool")}</span><span>${t.ok === false ? "failed" : "ok"}</span></div><div>${escapeHtml(t.result || t.output || "")}</div></div>`)
        .join("")
    : `<div class="empty"><h4>No tool history</h4><p>Tool calls from this session will show here.</p></div>`;
  return `
    <div class="grid cards-2">
      <article class="card"><h3>Transcript</h3><div class="transcript-log">${transcript}</div></article>
      <article class="card"><h3>Tool execution</h3><div class="transcript-log">${tools}</div></article>
    </div>
  `;
}

export async function renderConversations() {
  const table = document.getElementById("conversations-table");
  const detail = document.getElementById("conversation-detail");
  if (!table) return;
  let sessions = [];
  try {
    ({ sessions } = await api.sessions());
  } catch (error) {
    table.innerHTML = `<div class="empty"><h4>Could not load conversations</h4><p>${error.message}</p></div>`;
    return;
  }

  const q = document.getElementById("conv-search")?.value || "";
  const category = document.getElementById("conv-category")?.value || "";
  const date = document.getElementById("conv-date")?.value || "";
  const rows = sessions.filter((s) => matches(s, { q, category, date }));

  if (!rows.length) {
    table.innerHTML = `<div class="empty"><h4>No conversations recorded</h4><p>Voice sessions and service lookups from this dashboard will appear here. Records are never invented.</p></div>`;
    if (detail) detail.innerHTML = "";
    return;
  }

  table.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Session</th>
            <th>Customer</th>
            <th>Category</th>
            <th>Duration</th>
            <th>Date</th>
            <th>Resolution</th>
            <th>Escalation</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (s) => `
            <tr data-id="${s.id}" style="cursor:pointer">
              <td>${escapeHtml(s.id)}</td>
              <td>${escapeHtml(s.phone_masked || "—")}</td>
              <td>${escapeHtml(s.category || "general")}</td>
              <td>${formatDuration(s.duration_seconds)}</td>
              <td>${escapeHtml(formatTime(s.started_at))}</td>
              <td>${escapeHtml(s.status || "in_progress")}</td>
              <td>${s.escalated ? "Escalated" : "—"}</td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;

  table.querySelectorAll("tr[data-id]").forEach((row) => {
    row.addEventListener("click", async () => {
      const session = await api.session(row.dataset.id);
      if (detail) detail.innerHTML = detailHtml(session);
      window.lucide?.createIcons();
    });
  });
}

export function initConversations() {
  ["conv-search", "conv-category", "conv-date"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", () => renderConversations());
    document.getElementById(id)?.addEventListener("change", () => renderConversations());
  });
  document.getElementById("conv-refresh")?.addEventListener("click", () => renderConversations());
}
