/* ============================================================
   Reading a CSV file the way spreadsheets write it (RFC 4180): a quoted
   cell may hold commas, line breaks and doubled quotes (""). Used by the
   teacher's "Add many learners at once" (teacher.js).
   ============================================================ */

/** The rows of a CSV text, each a list of trimmed cells; blank lines left out. */
export function parseCsv(text) {
  const s = String(text ?? "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const endCell = () => { row.push(cell.trim()); cell = ""; };
  const endRow = () => { endCell(); rows.push(row); row = []; };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (s[i + 1] === '"') { cell += '"'; i++; }
      else quoted = false;
    } else if (ch === '"' && cell.trim() === "") {
      quoted = true;
      cell = "";
    } else if (ch === ",") {
      endCell();
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      endRow();
    } else {
      cell += ch;
    }
  }
  if (cell.trim() !== "" || row.length) endRow();
  return rows.filter((r) => r.some((c) => c !== ""));
}
