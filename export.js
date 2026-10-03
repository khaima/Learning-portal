/* Report files, written in the browser: Excel (.xlsx), CSV and PDF.

   No libraries — nothing extra to download on a slow school connection.
   A report is what GET /reports/:id returns:
     { title, scope, limitedTo, generatedAt, generatedBy, role, description,
       sections: [{ title, columns: [{ key, label, type }], rows }] }
   Column types: text, number, percent (0–100), date, datetime. The rows
   are already limited to what this person may see — the server decides;
   this file only formats them. */

const enc = new TextEncoder();
const pad = (n) => String(n).padStart(2, "0");
const round = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

function asDate(v) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localStamp = (d) => `${isoDay(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** How a value reads in a PDF or on screen. */
export function cellText(v, type) {
  if (v == null || v === "") return "";
  if (type === "date") return String(v).slice(0, 10);
  if (type === "datetime") { const d = asDate(v); return d ? localStamp(d) : String(v); }
  if (typeof v === "number" && type === "percent") return `${round(v)}%`;
  if (typeof v === "number") return v.toLocaleString("en-GB", { maximumFractionDigits: 2 });
  return String(v);
}

/** "Learner Register - Narok County - 2026-10-03.xlsx" */
export function fileName(report, ext) {
  const place = String(report.scope || "").split(" · ")[0];
  const parts = [report.title, place && place !== "All schools" ? place : "", isoDay(asDate(report.generatedAt) || new Date())];
  return `${parts.filter(Boolean).join(" - ").replace(/[\\/:*?"<>|]+/g, "-")}.${ext}`;
}

const aboutLines = (r) => [
  ["Covers", r.scope || ""],
  ["Limited to", r.limitedTo || ""],
  ["Filters", r.filterText || "None"],
  ["Generated", asDate(r.generatedAt) ? localStamp(asDate(r.generatedAt)) : ""],
  ["By", r.generatedBy ? `${r.generatedBy}${r.role ? ` (${r.role})` : ""}` : ""],
  ["Rows", String(r.sections.reduce((t, s) => t + s.rows.length, 0))],
];

/* ------------------------------------------------------------------ CSV */

/* A formula-looking text cell (=, +, -, @) would run when the file is
   opened in a spreadsheet — prefixed with ' so it stays text. Real numbers
   are written as numbers. */
function csvValue(v, type) {
  if (v == null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (type === "datetime") return cellText(v, type);
  if (type === "date") return String(v).slice(0, 10);
  const s = String(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}
const csvRow = (cells) => cells.map((c) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",");

/** One table per report; a report with several parts has each under its title. */
export function toCsv(report) {
  const multi = report.sections.length > 1;
  const lines = [];
  report.sections.forEach((s, i) => {
    if (multi) { if (i) lines.push(""); lines.push(csvRow([csvValue(s.title)])); }
    lines.push(csvRow(s.columns.map((c) => csvValue(c.label))));
    for (const r of s.rows) lines.push(csvRow(s.columns.map((c) => csvValue(r[c.key], c.type))));
  });
  // The BOM makes Excel read it as UTF-8 (names with accents survive).
  return new Blob(["﻿" + lines.join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" });
}

/* ------------------------------------------------------------------ ZIP (for .xlsx) */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Compressed with the browser's own zlib where it has one; otherwise null. */
async function compress(bytes, format) {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const out = new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream(format)));
    return new Uint8Array(await out.arrayBuffer());
  } catch {
    return null;
  }
}

async function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
    const packed = await compress(data, "deflate-raw");
    const deflated = !!packed && packed.length < data.length;
    const body = deflated ? packed : data;
    const crc = crc32(data);
    const head = (sig, size) => {
      const b = new Uint8Array(size + name.length);
      const v = new DataView(b.buffer);
      v.setUint32(0, sig, true);
      return { b, v };
    };
    const { b: local, v: l } = head(0x04034b50, 30);
    l.setUint16(4, 20, true); l.setUint16(6, 0x0800, true); l.setUint16(8, deflated ? 8 : 0, true);
    l.setUint16(10, time, true); l.setUint16(12, date, true); l.setUint32(14, crc, true);
    l.setUint32(18, body.length, true); l.setUint32(22, data.length, true); l.setUint16(26, name.length, true);
    local.set(name, 30);
    const { b: cen, v: c } = head(0x02014b50, 46);
    c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, deflated ? 8 : 0, true);
    c.setUint16(12, time, true); c.setUint16(14, date, true); c.setUint32(16, crc, true);
    c.setUint32(20, body.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    cen.set(name, 46);
    parts.push(local, body);
    central.push(cen);
    offset += local.length + body.length;
  }
  const size = central.reduce((t, b) => t + b.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, size, true); e.setUint32(16, offset, true);
  return [...parts, ...central, end];
}

/* ------------------------------------------------------------------ Excel (.xlsx) */

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const xmlEsc = (s) => String(s)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
  .replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
const colName = (i) => { let s = ""; for (let n = i + 1; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const EPOCH = Date.UTC(1899, 11, 30);
// Styles (cellXfs below): 0 plain, 1 header, 2 date, 3 date+time, 4 percent, 5 title, 6 bold, 7 wrapped.
const S = { header: 1, date: 2, datetime: 3, percent: 4, title: 5, bold: 6, wrap: 7 };

function xlCell(ref, v, type, style) {
  if (v == null || v === "") return "";
  if (typeof v === "number" && Number.isFinite(v)) {
    if (type === "percent") return `<c r="${ref}" s="${S.percent}"><v>${v / 100}</v></c>`;
    return `<c r="${ref}"${style ? ` s="${style}"` : ""}><v>${v}</v></c>`;
  }
  if (type === "date" && /^\d{4}-\d{2}-\d{2}/.test(String(v))) {
    const [y, m, d] = String(v).slice(0, 10).split("-").map(Number);
    return `<c r="${ref}" s="${S.date}"><v>${(Date.UTC(y, m - 1, d) - EPOCH) / 864e5}</v></c>`;
  }
  if (type === "datetime" && asDate(v)) {
    const d = asDate(v);
    const serial = (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()) - EPOCH) / 864e5;
    return `<c r="${ref}" s="${S.datetime}"><v>${serial}</v></c>`;
  }
  const text = String(v).slice(0, 32767);
  return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ""}><is><t xml:space="preserve">${xmlEsc(text)}</t></is></c>`;
}

function sheetXml(section) {
  const cols = section.columns;
  const widths = cols.map((c) => {
    let w = c.label.length;
    for (const r of section.rows.slice(0, 500)) w = Math.max(w, cellText(r[c.key], c.type).length);
    return Math.min(60, Math.max(8, w + 2));
  });
  const rows = [`<row r="1">${cols.map((c, i) => xlCell(`${colName(i)}1`, c.label, "text", S.header)).join("")}</row>`];
  section.rows.forEach((r, n) => {
    const at = n + 2;
    rows.push(`<row r="${at}">${cols.map((c, i) =>
      xlCell(`${colName(i)}${at}`, r[c.key], c.type, String(r[c.key] ?? "").length > 60 ? S.wrap : 0)).join("")}</row>`);
  });
  const last = `${colName(Math.max(cols.length, 1) - 1)}${section.rows.length + 1}`;
  return {
    range: `$A$1:$${last.replace(/(\d+)$/, "$$$1")}`,
    xml: `${XML}<worksheet ${NS}>` +
      `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
      `<sheetFormatPr defaultRowHeight="15"/>` +
      `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` +
      `<sheetData>${rows.join("")}</sheetData>` +
      (cols.length ? `<autoFilter ref="A1:${last}"/>` : "") +
      `</worksheet>`,
  };
}

function aboutXml(report) {
  const rows = [`<row r="1">${xlCell("A1", report.title, "text", S.title)}</row>`];
  aboutLines(report).forEach(([k, v], i) => {
    rows.push(`<row r="${i + 3}">${xlCell(`A${i + 3}`, k, "text", S.bold)}${xlCell(`B${i + 3}`, v, "text", 0)}</row>`);
  });
  const n = aboutLines(report).length + 4;
  rows.push(`<row r="${n}">${xlCell(`A${n}`, report.description || "", "text", 0)}</row>`);
  rows.push(`<row r="${n + 1}">${xlCell(`A${n + 1}`, "From the HPF Digital Learning Portal. It holds only what this account may see, and the export is recorded.", "text", 0)}</row>`);
  return `${XML}<worksheet ${NS}><cols><col min="1" max="1" width="14" customWidth="1"/><col min="2" max="2" width="80" customWidth="1"/></cols>` +
    `<sheetData>${rows.join("")}</sheetData></worksheet>`;
}

const STYLES = `${XML}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<numFmts count="3"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm"/><numFmt numFmtId="166" formatCode="0.0%"/></numFmts>` +
  `<fonts count="3"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="14"/><name val="Calibri"/><family val="2"/></font></fonts>` +
  `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE6EDF3"/><bgColor indexed="64"/></patternFill></fill></fills>` +
  `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF8A99A8"/></bottom><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="8">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>` +
  `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
  `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>` +
  `</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/** Sheet names: at most 31 characters, none of []:*?/\' and no repeats. */
function sheetNames(titles) {
  const used = new Set();
  return titles.map((t) => {
    const base = (String(t).replace(/[[\]:*?/\\']/g, "-").trim() || "Sheet").slice(0, 31);
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base.slice(0, 31 - ` (${n})`.length)} (${n})`;
    used.add(name.toLowerCase());
    return name;
  });
}

/** One sheet per part of the report, frozen header and filters on each, and an About sheet. */
export async function toXlsx(report) {
  const names = sheetNames([...report.sections.map((s) => s.title), "About"]);
  const sheets = report.sections.map((s) => sheetXml(s));
  const n = sheets.length + 1;
  const files = [
    { name: "[Content_Types].xml", data: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      Array.from({ length: n }, (_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>` },
    { name: "_rels/.rels", data: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>` },
    { name: "docProps/core.xml", data: `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
      `<dc:title>${xmlEsc(report.title)}</dc:title><dc:creator>${xmlEsc(report.generatedBy || "HPF Digital Learning Portal")}</dc:creator>` +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${xmlEsc(report.generatedAt || new Date().toISOString()).replace(/\.\d+Z$/, "Z")}</dcterms:created></cp:coreProperties>` },
    { name: "xl/workbook.xml", data: `${XML}<workbook ${NS}><bookViews><workbookView/></bookViews><sheets>` +
      names.map((nm, i) => `<sheet name="${xmlEsc(nm)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") + `</sheets>` +
      (sheets.some((s, i) => report.sections[i].columns.length) ? `<definedNames>${sheets.map((s, i) => report.sections[i].columns.length
        ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xmlEsc(names[i])}'!${s.range}</definedName>` : "").join("")}</definedNames>` : "") +
      `</workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      Array.from({ length: n }, (_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
      `<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", data: STYLES },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: s.xml })),
    { name: `xl/worksheets/sheet${n}.xml`, data: aboutXml(report) },
  ];
  return new Blob(await zip(files), { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

/* ------------------------------------------------------------------ PDF */

/* Helvetica and Helvetica-Bold are built into every PDF reader, so nothing
   is embedded. Their character widths (from the standard font metrics) let
   columns be sized and text wrapped; text is written in WinAnsi, which
   covers English and Western European letters. */
const W_REG = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,
  1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,
  333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,
  975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,
  333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
const W_HIGH = { 0x85: 1000, 0x91: 222, 0x92: 222, 0x93: 333, 0x94: 333, 0x95: 350, 0x96: 556, 0x97: 1000, 0xa0: 278, 0xb0: 400, 0xb7: 278, 0xd7: 584 };
const WIN_ANSI = { 0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89,
  0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96,
  0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f };

/** Unicode -> a string of WinAnsi byte values (anything else becomes "?"). */
function winAnsi(s) {
  let out = "";
  for (const ch of String(s).normalize("NFC")) {
    const u = ch.codePointAt(0);
    if (u === 9 || u === 10 || u === 13) out += " ";
    else if (u >= 32 && u < 127) out += ch;
    else if (u >= 160 && u <= 255) out += ch;
    else if (WIN_ANSI[u]) out += String.fromCharCode(WIN_ANSI[u]);
    else if (u >= 32) out += "?";
  }
  return out;
}
function charWidth(code, bold) {
  if (code >= 32 && code < 127) return (bold ? W_BOLD : W_REG)[code - 32];
  if (W_HIGH[code]) return bold && code >= 0x91 && code <= 0x94 ? W_HIGH[code] + 56 : W_HIGH[code];
  return code < 0xdf ? 722 : bold ? 611 : 556;
}
function textWidth(s, size, bold) {
  let w = 0;
  for (let i = 0; i < s.length; i++) w += charWidth(s.charCodeAt(i), bold);
  return (w * size) / 1000;
}
const pdfStr = (s) => `(${s.replace(/[\\()]/g, (c) => `\\${c}`)})`;
const num = (n) => (Math.round(n * 100) / 100).toString();

/** Lines of at most `width` points; a word too long for a line is broken. */
function wrap(text, width, size, bold, maxLines = 8) {
  const fits = (s) => textWidth(s, size, bold) <= width + 0.01; // allow for rounding
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (fits(next)) { line = next; continue; }
    if (line) lines.push(line);
    if (fits(word)) { line = word; continue; }
    line = "";
    for (const ch of word) {
      if (line && !fits(line + ch)) { lines.push(line); line = ch; } else line += ch;
    }
  }
  if (line || !lines.length) lines.push(line);
  if (lines.length > maxLines) {
    const cut = lines.slice(0, maxLines);
    let last = cut[maxLines - 1];
    while (last && !fits(`${last}\x85`)) last = last.slice(0, -1);
    cut[maxLines - 1] = `${last}\x85`;
    return cut;
  }
  return lines;
}

const PAGE_W = 842, PAGE_H = 595, MARGIN = 32, BOTTOM = 40;
const SIZE = 7.5, LEAD = 9, PAD_X = 3.5, PAD_Y = 3;

/** Column widths: what the text wants, shrunk (and wrapped) to fit the page. */
function columnWidths(cols, rows, avail) {
  const want = [], min = [];
  cols.forEach((c, i) => {
    const head = winAnsi(c.label);
    const longestWord = Math.max(...head.split(" ").map((w) => textWidth(w, SIZE, true)));
    let w = textWidth(head, SIZE, true);
    for (const r of rows.slice(0, 400)) w = Math.max(w, textWidth(winAnsi(cellText(r[c.key], c.type)), SIZE, false));
    want[i] = Math.max(Math.min(w, 200), longestWord) + PAD_X * 2;
    // Short columns (codes, dates, numbers) keep their width; long text wraps.
    min[i] = Math.min(want[i], Math.max(longestWord, 64) + PAD_X * 2);
  });
  const sumWant = want.reduce((a, b) => a + b, 0), sumMin = min.reduce((a, b) => a + b, 0);
  if (sumWant <= avail) return want;
  if (sumMin >= avail) return min.map((m) => (m * avail) / sumMin);
  const k = (avail - sumMin) / (sumWant - sumMin);
  return want.map((w, i) => min[i] + (w - min[i]) * k);
}

function layoutPdf(report) {
  const pages = [];
  let ops = null, y = 0;
  const newPage = () => { ops = []; pages.push(ops); y = PAGE_H - MARGIN; };
  const text = (s, x, yy, size, bold, gray = 0) => {
    ops.push(`${gray} g BT /${bold ? "F2" : "F1"} ${size} Tf ${num(x)} ${num(yy)} Td ${pdfStr(s)} Tj ET`);
  };
  const rect = (x, yy, w, h, gray) => ops.push(`${gray} g ${num(x)} ${num(yy)} ${num(w)} ${num(h)} re f`);
  const rule = (x1, yy, x2, gray = 0.75) => ops.push(`${gray} G 0.5 w ${num(x1)} ${num(yy)} m ${num(x2)} ${num(yy)} l S`);
  const avail = PAGE_W - MARGIN * 2;

  newPage();
  y -= 16;
  text(winAnsi(report.title), MARGIN, y, 16, true);
  y -= 6;
  const meta = [
    report.scope,
    [`Limited to: ${report.limitedTo || "—"}`, report.filterText ? `Filters: ${report.filterText}` : ""].filter(Boolean).join("   ·   "),
    `Generated ${asDate(report.generatedAt) ? localStamp(asDate(report.generatedAt)) : ""}${report.generatedBy ? ` by ${report.generatedBy}${report.role ? ` (${report.role})` : ""}` : ""}`,
  ].filter(Boolean);
  for (const line of meta) {
    for (const l of wrap(winAnsi(line), avail, 8.5, false)) { y -= 11; text(l, MARGIN, y, 8.5, false, 0.35); }
  }
  y -= 10;

  for (const sec of report.sections) {
    const cols = sec.columns;
    const widths = columnWidths(cols, sec.rows, avail);
    const xs = widths.reduce((acc, w, i) => { acc.push(i ? acc[i - 1] + widths[i - 1] : MARGIN); return acc; }, []);
    const right = (c) => c.type === "number" || c.type === "percent";
    const headLines = cols.map((c, i) => wrap(winAnsi(c.label), widths[i] - PAD_X * 2, SIZE, true, 3));
    const headH = Math.max(...headLines.map((l) => l.length)) * LEAD + PAD_Y * 2;
    const drawHead = () => {
      rect(MARGIN, y - headH, avail, headH, 0.9);
      cols.forEach((c, i) => headLines[i].forEach((l, k) => {
        const x = right(c) ? xs[i] + widths[i] - PAD_X - textWidth(l, SIZE, true) : xs[i] + PAD_X;
        text(l, x, y - PAD_Y - (k + 1) * LEAD + 2, SIZE, true);
      }));
      y -= headH;
    };
    const title = (s) => { y -= 14; text(winAnsi(s), MARGIN, y, 10.5, true); y -= 5; };
    // Title, header and a first row stay together.
    if (y - 14 - 5 - headH - (LEAD + PAD_Y * 2) < BOTTOM) newPage();
    title(sec.title);
    if (!sec.rows.length) {
      y -= 12;
      text("Nothing to show for this choice.", MARGIN, y, 8.5, false, 0.4);
      y -= 12;
      continue;
    }
    drawHead();
    sec.rows.forEach((r, n) => {
      const cells = cols.map((c, i) => wrap(winAnsi(cellText(r[c.key], c.type)), widths[i] - PAD_X * 2, SIZE, false));
      const h = Math.max(...cells.map((l) => l.length)) * LEAD + PAD_Y * 2;
      if (y - h < BOTTOM) {
        newPage();
        title(`${sec.title} (continued)`);
        drawHead();
      }
      if (n % 2) rect(MARGIN, y - h, avail, h, 0.965);
      cols.forEach((c, i) => cells[i].forEach((l, k) => {
        const x = right(c) ? xs[i] + widths[i] - PAD_X - textWidth(l, SIZE, false) : xs[i] + PAD_X;
        text(l, x, y - PAD_Y - (k + 1) * LEAD + 2, SIZE, false, 0.1);
      }));
      y -= h;
      rule(MARGIN, y, MARGIN + avail, 0.85);
    });
    y -= 8;
  }

  const foot = winAnsi(`HPF Digital Learning Portal · ${report.title}`);
  pages.forEach((p, i) => {
    ops = p;
    rule(MARGIN, 30, PAGE_W - MARGIN, 0.8);
    text(foot, MARGIN, 20, 7.5, false, 0.4);
    const label = `Page ${i + 1} of ${pages.length}`;
    text(label, PAGE_W - MARGIN - textWidth(label, 7.5, false), 20, 7.5, false, 0.4);
  });
  return pages;
}

const bytes = (s) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return b; };
const utf16Hex = (s) => `<FEFF${[...String(s)].map((ch) => {
  const u = ch.codePointAt(0);
  if (u < 0x10000) return u.toString(16).padStart(4, "0");
  const v = u - 0x10000;
  return (0xd800 + (v >> 10)).toString(16) + (0xdc00 + (v & 0x3ff)).toString(16);
}).join("").toUpperCase()}>`;

/** A4 landscape; the header row repeats on every page; "Page n of N" at the foot. */
export async function toPdf(report) {
  const pages = layoutPdf(report);
  const objs = []; // index = object number - 1
  const pageIds = pages.map((_, i) => 6 + i * 2);
  objs[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objs[2] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  const d = asDate(report.generatedAt) || new Date();
  const stamp = `D:${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  objs[4] = `<< /Title ${utf16Hex(report.title)} /Author ${utf16Hex(report.generatedBy || "HPF Digital Learning Portal")} ` +
    `/Creator (HPF Digital Learning Portal) /Producer (HPF Digital Learning Portal) /CreationDate (${stamp}) >>`;
  for (let i = 0; i < pages.length; i++) {
    const raw = bytes(pages[i].join("\n"));
    const packed = await compress(raw, "deflate");
    const body = packed && packed.length < raw.length ? packed : raw;
    objs[5 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${7 + i * 2} 0 R >>`;
    objs[6 + i * 2] = { dict: `<< /Length ${body.length}${body === raw ? "" : " /Filter /FlateDecode"} >>`, body };
  }
  const out = [bytes("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")];
  let offset = out[0].length;
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(offset);
    const chunk = typeof o === "string"
      ? [bytes(`${i + 1} 0 obj\n${o}\nendobj\n`)]
      : [bytes(`${i + 1} 0 obj\n${o.dict}\nstream\n`), o.body, bytes("\nendstream\nendobj\n")];
    for (const c of chunk) { out.push(c); offset += c.length; }
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f\r\n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n\r\n`).join("")}` +
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  out.push(bytes(xref));
  return new Blob(out, { type: "application/pdf" });
}

/* ------------------------------------------------------------------ saving */

export const FORMATS = {
  xlsx: { label: "Excel", ext: "xlsx", write: toXlsx },
  csv: { label: "CSV", ext: "csv", write: async (r) => toCsv(r) },
  pdf: { label: "PDF", ext: "pdf", write: toPdf },
};

/** Write the report in a format and hand it to the browser as a download. */
export async function saveReport(report, format) {
  const f = FORMATS[format];
  const blob = await f.write(report);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileName(report, f.ext);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  return { name: a.download, size: blob.size };
}
