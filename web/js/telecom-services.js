import { api, escapeHtml, maskPhone, maskText } from "./api.js";
import { livekitState } from "./livekit.js";

let serviceSessionId = null;

function setResult(id, text, ok = true) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = maskText(text);
  el.style.color = ok ? "" : "#fca5a5";
}

async function sessionId() {
  if (livekitState.sessionId) return livekitState.sessionId;
  if (serviceSessionId) return serviceSessionId;
  const session = await api.createSession({
    source: "service",
    category: "general",
    status: "in_progress",
  });
  serviceSessionId = session.id;
  return session.id;
}

async function run(button, fn, resultId) {
  button.disabled = true;
  const prev = button.textContent;
  button.textContent = "Working…";
  try {
    await fn();
  } catch (err) {
    setResult(resultId, err.message, false);
  } finally {
    button.disabled = false;
    button.textContent = prev;
  }
}

export async function initTelecomServices() {
  const planSelects = document.querySelectorAll("[data-plan-select]");
  const regionSelect = document.getElementById("network-region");
  try {
    const [{ plans }, { regions }] = await Promise.all([api.plans(), api.regions()]);
    planSelects.forEach((select) => {
      select.innerHTML = plans
        .map((p) => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)} · ₹${escapeHtml(p.price)}</option>`)
        .join("");
    });
    if (regionSelect) {
      regionSelect.innerHTML =
        regions.map((r) => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join("") +
        `<option value="default">Other / unspecified</option>`;
    }
    const compare = document.getElementById("plan-compare");
    if (compare) {
      compare.innerHTML = plans.length
        ? plans
            .map(
              (p) =>
                `<div class="card" style="padding:12px"><strong>${escapeHtml(p.name)}</strong><p>₹${escapeHtml(p.price)} · ${escapeHtml(p.data)} · ${escapeHtml(p.validity)}<br>${escapeHtml(p.voice)} · ${escapeHtml(p.sms)}</p></div>`
            )
            .join("")
        : `<div class="empty"><p>The agent plan registry is empty.</p></div>`;
    }
  } catch (error) {
    setResult("plans-result", error.message, false);
    setResult("details-result", error.message, false);
    setResult("network-result", error.message, false);
  }

  document.getElementById("search-plans-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const query = document.getElementById("plans-query").value.trim();
    const btn = e.submitter;
    run(btn, async () => {
      const data = await api.searchPlans(query, await sessionId());
      setResult("plans-result", data.result || "The tool returned an empty response.");
    }, "plans-result");
  });

  document.getElementById("balance-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const phone = document.getElementById("balance-phone").value.trim();
    if (!/^\d{10}$/.test(phone)) {
      setResult("balance-result", "Enter exactly 10 digits. OTP, PIN and passwords are never requested.", false);
      return;
    }
    const btn = e.submitter;
    run(btn, async () => {
      const data = await api.checkBalance(phone, await sessionId());
      setResult("balance-result", `${maskPhone(phone)}\n${data.result || "No balance information returned."}`);
    }, "balance-result");
  });

  document.getElementById("network-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const region = document.getElementById("network-region").value;
    const btn = e.submitter;
    run(btn, async () => {
      const data = await api.network(region, await sessionId());
      setResult("network-result", data.result || "No coverage information returned.");
    }, "network-result");
  });

  document.getElementById("recommend-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const payload = {
      usage_type: document.getElementById("usage-type").value,
      data_gb: Number(document.getElementById("data-gb").value || 0),
      voice_min: Number(document.getElementById("voice-min").value || 0),
    };
    const btn = e.submitter;
    run(btn, async () => {
      const data = await api.recommend(payload, await sessionId());
      setResult("recommend-result", data.result || "No recommendation returned.");
    }, "recommend-result");
  });

  document.getElementById("details-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const plan = document.getElementById("details-plan").value;
    const btn = e.submitter;
    run(btn, async () => {
      const data = await api.planDetails(plan, await sessionId());
      setResult("details-result", data.result || "No plan details returned.");
    }, "details-result");
  });

  document.getElementById("escalate-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const reason = document.getElementById("escalate-reason").value.trim();
    const btn = e.submitter;
    run(btn, async () => {
      const data = await api.escalate(reason, await sessionId());
      setResult("escalate-result", data.result || "Escalation returned an empty response.");
      await renderEscalations();
    }, "escalate-result");
  });

  renderEscalations();
}

async function renderEscalations() {
  const host = document.getElementById("escalate-history");
  if (!host) return;
  try {
    const [{ events }, { sessions }] = await Promise.all([api.toolEvents(), api.sessions()]);
    const tickets = (events || []).filter((event) => event.tool === "escalate_to_support");
    const openSessions = (sessions || []).filter((session) => session.escalated && session.status !== "resolved");
    if (!tickets.length && !openSessions.length) {
      host.innerHTML = `<div class="empty"><h4>No escalations recorded</h4><p>Unresolved issues appear here after escalate_to_support runs.</p></div>`;
      return;
    }
    host.innerHTML = [
      ...openSessions.map(
        (session) =>
          `<div class="bubble tool"><div class="who"><span>Open ${escapeHtml(session.id)}</span><span>${escapeHtml(session.status || "escalated")}</span></div><div>${escapeHtml(session.phone_masked || "Number not captured")} · ${escapeHtml(session.category || "escalation")}</div></div>`
      ),
      ...tickets.slice(0, 6).map(
        (event) =>
          `<div class="bubble tool"><div class="who"><span>${escapeHtml(event.id)}</span><span>${event.ok ? "reference issued" : "failed"}</span></div><div>${escapeHtml(event.result || "")}</div></div>`
      ),
    ].join("");
  } catch (error) {
    host.innerHTML = `<div class="empty"><p>${escapeHtml(error.message)}</p></div>`;
  }
}
