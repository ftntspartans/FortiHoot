// FortiHoot — small, dependency-free .xlsx / .csv reader and .xlsx writer.
// Reading uses the browser's built-in DecompressionStream (Chrome/Edge 103+, Firefox 113+, Safari 16.4+; Node 18+).

// ---------------- zip ----------------
function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

async function inflateRaw(data) {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([data]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Returns Map<filename, Promise<Uint8Array>> for the entries whose names pass `want`. */
export async function unzip(bytes, want = () => true) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) { if (u32(b, i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error("Not a valid .xlsx file (zip directory not found).");
  const count = u16(b, eocd + 10);
  let p = u32(b, eocd + 16);
  const out = new Map();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (u32(b, p) !== 0x02014b50) throw new Error("Corrupt .xlsx file (bad zip entry).");
    const method = u16(b, p + 10), csize = u32(b, p + 20), nlen = u16(b, p + 28), xlen = u16(b, p + 30), clen = u16(b, p + 32), loff = u32(b, p + 42);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (!want(name)) continue;
    const start = loff + 30 + u16(b, loff + 26) + u16(b, loff + 28);
    const data = b.subarray(start, start + csize);
    if (method === 0) out.set(name, data.slice());
    else if (method === 8) out.set(name, await inflateRaw(data));
    else throw new Error(`Unsupported compression in ${name}.`);
  }
  return out;
}

// ---------------- xml helpers ----------------
function decodeXml(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[e];
  });
}
function attr(attrs, name) {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs);
  return m ? decodeXml(m[1]) : null;
}
function textOf(xml) {
  // concatenates every <t> run, skipping phonetic runs
  const clean = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let s = "";
  const re = /<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g;
  let m;
  while ((m = re.exec(clean))) s += m[1] ? decodeXml(m[1]) : "";
  return s;
}
function colIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref)[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Reads an .xlsx (ArrayBuffer/Uint8Array). Picks the sheet named "Questions", else the first sheet. Returns array of rows. */
export async function readXlsx(bytes, preferSheet = "Questions") {
  const files = await unzip(bytes, n => n === "xl/workbook.xml" || n === "xl/_rels/workbook.xml.rels" || n === "xl/sharedStrings.xml" || n.startsWith("xl/worksheets/"));
  const dec = new TextDecoder();
  const txt = n => (files.has(n) ? dec.decode(files.get(n)) : null);
  const wb = txt("xl/workbook.xml");
  if (!wb) throw new Error("Not a valid .xlsx file (no workbook).");
  const sheets = [];
  const sre = /<sheet\b([^>]*)\/?>/g;
  let m;
  while ((m = sre.exec(wb))) sheets.push({ name: attr(m[1], "name"), rid: attr(m[1], "r:id") });
  if (!sheets.length) throw new Error("The workbook has no sheets.");
  const rels = {};
  const rx = txt("xl/_rels/workbook.xml.rels") || "";
  const rre = /<Relationship\b([^>]*)\/?>/g;
  while ((m = rre.exec(rx))) rels[attr(m[1], "Id")] = attr(m[1], "Target");
  const pick = sheets.find(s => (s.name || "").toLowerCase() === preferSheet.toLowerCase()) || sheets[0];
  let target = rels[pick.rid] || "worksheets/sheet1.xml";
  target = target.replace(/^\/?xl\//, "").replace(/^\//, "");
  const sheetXml = txt("xl/" + target);
  if (!sheetXml) throw new Error(`Couldn't read sheet "${pick.name}".`);
  const shared = [];
  const ss = txt("xl/sharedStrings.xml");
  if (ss) { const sire = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g; while ((m = sire.exec(ss))) shared.push(m[1] ? textOf(m[1]) : ""); }
  const rows = [];
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rowAuto = 0;
  while ((m = rowRe.exec(sheetXml))) {
    const rAttr = attr(m[1], "r");
    const ri = rAttr ? Number(rAttr) - 1 : rowAuto;
    rowAuto = ri + 1;
    if (!m[2]) continue;
    const row = [];
    const cre = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let c, auto = 0;
    while ((c = cre.exec(m[2]))) {
      const ref = attr(c[1], "r");
      const ci = ref ? colIndex(ref) : auto;
      auto = ci + 1;
      const t = attr(c[1], "t") || "n";
      const inner = c[2] || "";
      const vm = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
      const v = vm ? decodeXml(vm[1]) : "";
      let val = "";
      if (t === "s") val = shared[Number(v)] ?? "";
      else if (t === "inlineStr") val = textOf(inner);
      else if (t === "b") val = v === "1" ? "TRUE" : "FALSE";
      else if (t === "str" || t === "e") val = v;
      else val = v === "" ? "" : (Number.isFinite(Number(v)) ? Number(v) : v);
      row[ci] = val;
    }
    for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = "";
    rows[ri] = row;
  }
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return rows;
}

/** RFC 4180 CSV (also handles ; and tab delimiters and a UTF-8 BOM). */
export function readCsv(text) {
  text = String(text).replace(/^﻿/, "");
  const first = text.split(/\r?\n/, 1)[0] || "";
  const counts = { ",": (first.match(/,/g) || []).length, ";": (first.match(/;/g) || []).length, "\t": (first.match(/\t/g) || []).length };
  const d = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0 ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ",";
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === d) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** Reads a File/Blob by extension. */
export async function readTableFile(file) {
  const name = (file.name || "").toLowerCase();
  if (name.endsWith(".csv") || name.endsWith(".txt")) return readCsv(await file.text());
  if (name.endsWith(".xls")) throw new Error("Old .xls format isn't supported — in Excel use File › Save As › Excel Workbook (.xlsx).");
  return readXlsx(new Uint8Array(await file.arrayBuffer()));
}

// ---------------- writer ----------------
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

function zipStore(entries) { // entries: [{name, data:Uint8Array}]
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  const w16 = v => [v & 0xff, (v >>> 8) & 0xff], w32 = v => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  for (const e of entries) {
    const name = enc.encode(e.name), crc = crc32(e.data), size = e.data.length;
    const local = new Uint8Array([...w32(0x04034b50), ...w16(20), ...w16(0x0800), ...w16(0), ...w16(0), ...w16(0x21), ...w32(crc), ...w32(size), ...w32(size), ...w16(name.length), ...w16(0)]);
    parts.push(local, name, e.data);
    central.push(new Uint8Array([...w32(0x02014b50), ...w16(20), ...w16(20), ...w16(0x0800), ...w16(0), ...w16(0), ...w16(0x21), ...w32(crc), ...w32(size), ...w32(size), ...w16(name.length), ...w16(0), ...w16(0), ...w16(0), ...w16(0), ...w32(0), ...w32(offset)]), name);
    offset += local.length + name.length + size;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const end = new Uint8Array([...w32(0x06054b50), ...w16(0), ...w16(0), ...w16(entries.length), ...w16(entries.length), ...w32(cdSize), ...w32(offset), ...w16(0)]);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let o = 0; for (const p of all) { out.set(p, o); o += p.length; }
  return out;
}

function esc(s) {
  return String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function colName(i) { let s = ""; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }

/** sheets: [{name, rows:[[...]], widths?:[chars], bold?:[rowIndex], table?:bool}] → Uint8Array (.xlsx) */
export function writeXlsx(sheets) {
  const enc = new TextEncoder();
  const files = [];
  const names = [];
  sheets.forEach((s, i) => {
    let nm = String(s.name || `Sheet${i + 1}`).replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || `Sheet${i + 1}`;
    while (names.includes(nm)) nm = nm.slice(0, 28) + "_" + i;
    names.push(nm);
  });
  files.push({ name: "[Content_Types].xml", xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>` });
  files.push({ name: "_rels/.rels", xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` });
  files.push({ name: "xl/workbook.xml", xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>` });
  files.push({ name: "xl/_rels/workbook.xml.rels", xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` });
  files.push({ name: "xl/styles.xml", xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF8E1B1F"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>` });
  sheets.forEach((s, si) => {
    const rows = s.rows || [];
    const bold = new Set(s.bold || [0]);
    const maxCols = rows.reduce((mx, r) => Math.max(mx, (r || []).length), 1);
    const cols = (s.widths || []).length ? `<cols>${s.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "";
    const table = s.table !== false && rows.length > 1 && (s.bold || [0]).length === 1;
    const views = table ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` : `<sheetViews><sheetView workbookViewId="0"/></sheetViews>`;
    let body = "";
    rows.forEach((r, ri) => {
      if (!r || !r.length) { body += `<row r="${ri + 1}"/>`; return; }
      body += `<row r="${ri + 1}">`;
      r.forEach((v, ci) => {
        if (v === "" || v == null) return;
        const ref = colName(ci) + (ri + 1);
        const st = bold.has(ri) ? ' s="1"' : (typeof v === "string" && v.length > 60 ? ' s="2"' : "");
        if (typeof v === "number" && Number.isFinite(v)) body += `<c r="${ref}"${st}><v>${v}</v></c>`;
        else body += `<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
      });
      body += `</row>`;
    });
    const filter = table ? `<autoFilter ref="A1:${colName(maxCols - 1)}${rows.length}"/>` : "";
    files.push({ name: `xl/worksheets/sheet${si + 1}.xml`, xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${views}<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${body}</sheetData>${filter}</worksheet>` });
  });
  return zipStore(files.map(f => ({ name: f.name, data: enc.encode(f.xml) })));
}
