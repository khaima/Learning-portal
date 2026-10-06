/* ============================================================
   HPF Digital Learning Portal — how an M&E value and its achievement
   are written. Shared by the M&E pages (mel-ui.js) and the impact
   dashboards (impact-ui.js); its own small file so a dashboard can show
   indicators without downloading the whole M&E module.
   ============================================================ */

/** Achievement against target: its label and pill colour. */
export const STATUS = {
  met: { label: "Met", cls: "ok" }, close: { label: "Close", cls: "warm" },
  not_met: { label: "Not met", cls: "danger" }, no_data: { label: "No data", cls: "" },
};

export function fmtValue(v, unit) {
  if (v == null || v === "") return "—";
  const n = Math.round(Number(v) * 10) / 10;
  return unit === "percent" ? `${n}%` : String(n);
}
export const ragPill = (a) => `<span class="pill ${STATUS[a.status].cls}">${STATUS[a.status].label}${a.percent != null ? ` · ${Math.round(a.percent)}%` : ""}</span>`;
