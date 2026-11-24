import { api } from "./api.js";

function metric(label, value, missing) {
  return `<article class="card metric ${missing ? "unavailable" : ""}"><h3>${label}</h3><div class="value">${missing ? "Unavailable" : value}</div></article>`;
}

function barChart(svg, rows, color = "#60a5fa") {
  const w = 640;
  const h = 220;
  if (!rows.length) {
    svg.innerHTML = "";
    return;
  }
  const max = Math.max(...rows.map((r) => r.count), 1);
  const gap = 10;
  const barW = Math.max(8, (w - 40) / rows.length - gap);
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.innerHTML = rows
    .map((row, i) => {
      const bh = (row.count / max) * 160;
      const x = 20 + i * (barW + gap);
      const y = 180 - bh;
      return `<rect x="${x}" y="${y}" width="${barW}" height="${bh}" rx="6" fill="${color}"></rect>
        <text x="${x + barW / 2}" y="200" text-anchor="middle" fill="#8b9bb8" font-size="10">${row.label}</text>`;
    })
    .join("");
}

function donut(svg, slices) {
  const total = slices.reduce((s, x) => s + x.count, 0);
  if (!total) {
    svg.innerHTML = "";
    return;
  }
  let acc = 0;
  const cx = 90;
  const cy = 90;
  const r = 62;
  const c = 2 * Math.PI * r;
  svg.setAttribute("viewBox", "0 0 280 180");
  svg.innerHTML = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="18"/>` +
    slices
      .map((slice) => {
        const len = (slice.count / total) * c;
        const dash = `${len} ${c - len}`;
        const offset = c * 0.25 - acc;
        acc += len;
        return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${slice.color}" stroke-width="18" stroke-dasharray="${dash}" stroke-dashoffset="${offset}" transform="rotate(-90 ${cx} ${cy})"/>`;
      })
      .join("");
}

export async function renderAnalytics() {
  const root = document.getElementById("analytics-root");
  if (!root) return;
  let data;
  try {
    data = await api.analytics();
  } catch (error) {
    root.innerHTML = `<div class="empty"><h4>Analytics unavailable</h4><p>${error.message}</p></div>`;
    return;
  }

  root.querySelector("#analytics-metrics").innerHTML = [
    metric("Voice sessions", data.total_voice_sessions, false),
    metric("Unique customers", data.total_customers_assisted, data.total_customers_assisted === 0 && data.total_voice_sessions === 0),
    metric("Plan enquiries", data.plan_enquiries, false),
    metric("Balance checks", data.account_balance_checks, false),
    metric("Network checks", data.network_enquiries, false),
    metric("Recommendations", data.plan_recommendations, false),
    metric("Escalations", data.escalations, false),
    metric("Avg response", data.average_response_latency_ms == null ? null : `${data.average_response_latency_ms} ms`, data.average_response_latency_ms == null),
    metric("Resolution rate", data.session_resolution_rate == null ? null : `${data.session_resolution_rate}%`, data.session_resolution_rate == null),
  ].join("");

  barChart(
    root.querySelector("#chart-daily"),
    (data.daily_interactions || []).map((d) => ({ label: d.date.slice(5), count: d.count }))
  );
  barChart(
    root.querySelector("#chart-category"),
    (data.category_distribution || []).map((d) => ({ label: d.category, count: d.count })),
    "#a78bfa"
  );
  donut(root.querySelector("#chart-outcome"), [
    { count: data.successful_vs_escalated.resolved, color: "#34d399" },
    { count: data.successful_vs_escalated.escalated, color: "#fbbf24" },
    { count: data.successful_vs_escalated.other, color: "#60a5fa" },
  ]);
  barChart(
    root.querySelector("#chart-activity"),
    (data.daily_interactions || []).map((d) => ({ label: d.date.slice(5), count: d.count })),
    "#38bdf8"
  );

  const notes = root.querySelector("#analytics-notes");
  if (notes) {
    notes.innerHTML = data.unavailable?.length
      ? data.unavailable.map((n) => `<p>${n}</p>`).join("")
      : "<p>All metrics below are derived from recorded backend activity.</p>";
  }
  const dailyEmpty = !(data.daily_interactions || []).length;
  const categoryEmpty = !(data.category_distribution || []).length;
  const outcome = data.successful_vs_escalated || { resolved: 0, escalated: 0, other: 0 };
  const outcomeEmpty = outcome.resolved + outcome.escalated + outcome.other === 0;
  const dailyCard = root.querySelector("#chart-daily")?.parentElement?.querySelector("[data-empty-chart]");
  const categoryCard = root.querySelector("#chart-category")?.parentElement?.querySelector("[data-empty-chart]");
  const activityCard = root.querySelector("#chart-activity")?.parentElement?.querySelector("[data-empty-chart]");
  if (dailyCard) dailyCard.style.display = dailyEmpty ? "block" : "none";
  if (categoryCard) categoryCard.style.display = categoryEmpty ? "block" : "none";
  if (activityCard) activityCard.style.display = dailyEmpty ? "block" : "none";
  const outcomeEmptyEl = root.querySelector("#chart-outcome-empty");
  if (outcomeEmptyEl) outcomeEmptyEl.style.display = outcomeEmpty ? "block" : "none";
}
