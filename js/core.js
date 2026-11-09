// FortiHoot — core logic (no DOM, no Firebase). Runs in the browser and in Node tests.
export const APP_VERSION = "1.1.0";

export const LETTERS = ["A", "B", "C", "D"];
export const TEAM_PRESETS = [
  { name: "Red", color: "#cc2027" }, { name: "Blue", color: "#1273c6" },
  { name: "Gold", color: "#bd8b4f" }, { name: "Green", color: "#1e7a45" },
  { name: "Purple", color: "#6b3fa0" }, { name: "Orange", color: "#d4661c" },
  { name: "Teal", color: "#13827f" }, { name: "Gray", color: "#5b6470" }
];
export const LIMITS = { minTime: 5, maxTime: 120, defTime: 20, defPoints: 1000, maxPoints: 2000, maxQuestions: 100, nameMax: 24 };

// ---------- join codes ----------
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I, L, O, 0, 1
export function makeCode(rand = Math.random) {
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
  return s;
}
export function normalizeCode(s) {
  return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}
export function isValidCode(s) { return /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(s); }

export function cleanName(s) {
  return String(s || "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, LIMITS.nameMax);
}

/** Parses a co-host list typed by the host: commas, semicolons, spaces or new lines. Lowercased, de-duplicated, max 10. */
export function parseEmails(text) {
  const out = [], bad = [];
  for (const raw of String(text || "").split(/[\s,;]+/)) {
    const e = raw.trim().toLowerCase();
    if (!e) continue;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) { bad.push(raw.trim()); continue; }
    if (!out.includes(e)) out.push(e);
  }
  return { emails: out.slice(0, 10), bad, tooMany: out.length > 10 };
}

// ---------- question bank ----------
const HEADER_ALIASES = {
  question: ["question", "question text", "q"],
  type: ["type", "question type"],
  a: ["answer a", "a", "option a", "choice a"],
  b: ["answer b", "b", "option b", "choice b"],
  c: ["answer c", "c", "option c", "choice c"],
  d: ["answer d", "d", "option d", "choice d"],
  correct: ["correct", "correct answer", "correct answer(s)", "answer", "correct answers"],
  time: ["time", "time (sec)", "time (seconds)", "seconds", "time limit", "timer"],
  points: ["points", "pts", "max points"],
  image: ["image", "image url", "picture", "image link"]
};
function norm(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }

function findHeader(rows) {
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const map = {};
    (rows[r] || []).forEach((cell, ci) => {
      const h = norm(cell).toLowerCase();
      for (const [key, names] of Object.entries(HEADER_ALIASES)) if (names.includes(h) && map[key] == null) map[key] = ci;
    });
    if (map.question != null && map.a != null && map.b != null && map.correct != null) return { row: r, map };
  }
  return null;
}

function parseType(raw, opts) {
  const t = norm(raw).toLowerCase().replace(/[^a-z]/g, "");
  if (["tf", "truefalse", "tf2", "boolean", "yesno"].includes(t)) return "tf";
  if (["multi", "multiple", "multiselect", "ms", "multipleanswer", "multipleanswers", "selectall"].includes(t)) return "multi";
  if (["mc", "multiplechoice", "single", "singlechoice", ""].includes(t)) {
    if (t === "" && opts.filter(Boolean).length === 2 && /^true$/i.test(opts[0]) && /^false$/i.test(opts[1])) return "tf";
    return "mc";
  }
  return null;
}

function parseCorrect(raw, type, opts) {
  const s = norm(raw);
  if (!s) return { idx: [], err: "Correct answer is blank" };
  if (type === "tf") {
    if (/^(a|true|t|yes)$/i.test(s)) return { idx: [0] };
    if (/^(b|false|f|no)$/i.test(s)) return { idx: [1] };
    return { idx: [], err: `Correct answer "${s}" isn't True/False (or A/B)` };
  }
  const parts = s.split(/[\s,;/&+]+|(?<=[A-Da-d])(?=[A-Da-d])/).map(p => p.trim()).filter(Boolean);
  const idx = [];
  for (const p of parts) {
    let i = -1;
    if (/^[A-Da-d]$/.test(p)) i = p.toUpperCase().charCodeAt(0) - 65;
    else if (/^[1-4]$/.test(p)) i = Number(p) - 1;
    else i = opts.findIndex(o => o && o.toLowerCase() === p.toLowerCase());
    if (i < 0) {
      // maybe the whole cell is the answer text
      const whole = opts.findIndex(o => o && o.toLowerCase() === s.toLowerCase());
      if (whole >= 0) return { idx: [whole] };
      return { idx: [], err: `Correct answer "${s}" doesn't match a letter A–D` };
    }
    if (!opts[i]) return { idx: [], err: `Correct answer ${LETTERS[i]} points to a blank answer` };
    if (!idx.includes(i)) idx.push(i);
  }
  idx.sort((a, b) => a - b);
  return { idx };
}

/** rows: array of arrays (first sheet). Returns { questions, errors:[{row,msg}], warnings:[{row,msg}] } */
export function parseBank(rows) {
  const out = { questions: [], errors: [], warnings: [] };
  if (!Array.isArray(rows) || !rows.length) { out.errors.push({ row: 0, msg: "The file is empty." }); return out; }
  const h = findHeader(rows);
  if (!h) {
    out.errors.push({ row: 0, msg: "Couldn't find the header row. It needs at least: Question, Answer A, Answer B, Correct. Start from the template." });
    return out;
  }
  const m = h.map;
  for (let r = h.row + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const get = k => (m[k] == null ? "" : norm(row[m[k]]));
    const text = get("question");
    const opts = [get("a"), get("b"), get("c"), get("d")];
    if (!text && !opts.some(Boolean) && !get("correct")) continue; // blank row
    const rowNo = r + 1; // spreadsheet row number
    if (!text) { out.errors.push({ row: rowNo, msg: "Question text is blank" }); continue; }
    let type = parseType(get("type"), opts);
    if (!type) { out.errors.push({ row: rowNo, msg: `Type "${get("type")}" isn't MC, TF or Multi` }); continue; }
    if (type === "tf") {
      if (!opts[0] && !opts[1]) { opts[0] = "True"; opts[1] = "False"; }
      opts[2] = ""; opts[3] = "";
    }
    // answers must be filled from A downward with no gaps
    const lastFilled = opts.reduce((acc, o, i) => (o ? i : acc), -1);
    if (opts.filter(Boolean).length < 2) { out.errors.push({ row: rowNo, msg: "Needs at least two answers (A and B)" }); continue; }
    if (opts.slice(0, lastFilled + 1).some(o => !o)) { out.errors.push({ row: rowNo, msg: "Answers must be filled from A down with no gaps" }); continue; }
    const options = opts.slice(0, lastFilled + 1);
    const corr = parseCorrect(get("correct"), type, options);
    if (corr.err) { out.errors.push({ row: rowNo, msg: corr.err }); continue; }
    if (type === "mc" && corr.idx.length > 1) { out.errors.push({ row: rowNo, msg: `${corr.idx.length} correct answers listed — set Type to Multi for select-all questions` }); continue; }
    if (type === "multi" && corr.idx.length === options.length) out.warnings.push({ row: rowNo, msg: "Every answer is marked correct" });
    let time = LIMITS.defTime;
    const tRaw = get("time");
    if (tRaw) {
      const t = Math.round(Number(tRaw));
      if (!Number.isFinite(t)) out.warnings.push({ row: rowNo, msg: `Time "${tRaw}" isn't a number — using ${LIMITS.defTime}s` });
      else if (t < LIMITS.minTime || t > LIMITS.maxTime) { time = Math.min(LIMITS.maxTime, Math.max(LIMITS.minTime, t)); out.warnings.push({ row: rowNo, msg: `Time ${t}s is outside ${LIMITS.minTime}–${LIMITS.maxTime}s — using ${time}s` }); }
      else time = t;
    }
    let points = LIMITS.defPoints;
    const pRaw = get("points");
    if (pRaw) {
      const p = Math.round(Number(pRaw));
      if (!Number.isFinite(p) || p < 0) out.warnings.push({ row: rowNo, msg: `Points "${pRaw}" isn't valid — using ${LIMITS.defPoints}` });
      else if (p > LIMITS.maxPoints) { points = LIMITS.maxPoints; out.warnings.push({ row: rowNo, msg: `Points capped at ${LIMITS.maxPoints}` }); }
      else points = p;
    }
    let image = get("image");
    if (image && !/^https:\/\/\S+$/i.test(image)) { out.warnings.push({ row: rowNo, msg: "Image URL must start with https:// — image skipped" }); image = ""; }
    if (text.length > 300) out.warnings.push({ row: rowNo, msg: "Question is over 300 characters — it may be hard to read" });
    out.questions.push({ text, type, options, correct: corr.idx, time, points, image, row: rowNo });
  }
  if (out.questions.length > LIMITS.maxQuestions) {
    out.warnings.push({ row: 0, msg: `Only the first ${LIMITS.maxQuestions} questions are used` });
    out.questions = out.questions.slice(0, LIMITS.maxQuestions);
  }
  if (!out.questions.length && !out.errors.length) out.errors.push({ row: 0, msg: "No questions found under the header row." });
  return out;
}

/** The part of a question players may see (no answer key). */
export function publicQuestion(q) {
  const p = { text: q.text, type: q.type, options: q.options.slice(), time: q.time, points: q.points };
  if (q.image) p.image = q.image;
  return p;
}

export function shuffled(arr, rand = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ---------- scoring ----------
export function isCorrect(correctIdx, choice) {
  if (!Array.isArray(choice) || !choice.length) return false;
  const a = [...new Set(correctIdx)].sort((x, y) => x - y), b = [...new Set(choice)].sort((x, y) => x - y);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Kahoot-style: a correct answer earns between 50% and 100% of the question's points, by speed. */
export function pointsFor({ correct, rtMs, timeSec, points, speed = true }) {
  if (!correct) return 0;
  if (!speed) return points;
  const T = timeSec * 1000;
  const rt = Math.min(Math.max(rtMs || 0, 0), T);
  return Math.round(points * (1 - (rt / T) / 2));
}

/**
 * Score one question.
 * answers: [{u, c:[...], at:ms}] ; qStart: ms ; q: full question with correct[]
 * players: { uid: {name, team} } — answers from uids not in players are ignored (kicked / stray).
 * Returns { perPlayer: { uid: {c, rt, pts, ok} }, counts:[n per option], answered }
 */
export function scoreQuestion({ answers, qStart, q, players, speed }) {
  const perPlayer = {}, counts = q.options.map(() => 0);
  let answered = 0;
  const T = q.time * 1000;
  for (const a of answers) {
    if (!players[a.u] || perPlayer[a.u]) continue;
    const choice = (a.c || []).filter(i => Number.isInteger(i) && i >= 0 && i < q.options.length);
    if (!choice.length) continue;
    const rt = Math.min(Math.max((a.at || qStart) - qStart, 0), T);
    const ok = isCorrect(q.correct, choice);
    const pts = pointsFor({ correct: ok, rtMs: rt, timeSec: q.time, points: q.points, speed });
    perPlayer[a.u] = { c: choice, rt, pts, ok };
    answered++;
    for (const i of new Set(choice)) counts[i]++;
  }
  return { perPlayer, counts, answered };
}

/** results: { [qIndex]: { perPlayer } } → totals { uid: {score, correct, answered, rtSum} } */
export function totalsFrom(results, players) {
  const t = {};
  for (const uid of Object.keys(players)) t[uid] = { score: 0, correct: 0, answered: 0, rtSum: 0 };
  for (const r of Object.values(results || {})) {
    for (const [uid, p] of Object.entries(r.perPlayer || {})) {
      if (!t[uid]) continue;
      t[uid].score += p.pts; t[uid].answered++; t[uid].rtSum += p.rt; if (p.ok) t[uid].correct++;
    }
  }
  return t;
}

/** Standard competition ranking (1, 2, 2, 4). Ties broken for display order by name. */
export function rankPlayers(totals, players) {
  const list = Object.keys(players).map(uid => ({ uid, name: players[uid].name, team: players[uid].team ?? null, score: totals[uid]?.score || 0, correct: totals[uid]?.correct || 0 }));
  list.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  let prev = null, rank = 0;
  list.forEach((p, i) => { if (p.score !== prev) { rank = i + 1; prev = p.score; } p.rank = rank; });
  return list;
}

/** method: 'avg' (default, fair for uneven teams) or 'sum'. Teams with no players score 0. */
export function teamStandings(teams, ranked, method = "avg") {
  const rows = teams.map(t => {
    const members = ranked.filter(p => p.team === t.id);
    const sum = members.reduce((s, p) => s + p.score, 0);
    const score = method === "sum" ? sum : (members.length ? Math.round(sum / members.length) : 0);
    return { id: t.id, name: t.name, color: t.color, players: members.length, sum, score };
  });
  rows.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  let prev = null, rank = 0;
  rows.forEach((r, i) => { if (r.score !== prev) { rank = i + 1; prev = r.score; } r.rank = rank; });
  return rows;
}

/** Compact public payloads written to the game doc after each reveal. */
export function publicBoard(ranked, teamRows, topN = 10) {
  return {
    top: ranked.slice(0, topN).map(p => ({ n: p.name, t: p.team, s: p.score, r: p.rank })),
    teams: teamRows.map(t => ({ id: t.id, n: t.name, c: t.color, s: t.score, p: t.players, r: t.rank })),
    total: ranked.length
  };
}
export function publicScores(ranked, lastResult) {
  const s = {};
  for (const p of ranked) {
    const last = lastResult?.perPlayer?.[p.uid];
    s[p.uid] = [p.score, last ? last.pts : 0, p.rank, last ? (last.ok ? 1 : 0) : -1];
  }
  return s;
}

// ---------- clock ----------
/** server-time offset from a write: t0 = before send, t1 = ack received, serverMs = the server timestamp written. */
export function clockOffset(t0, t1, serverMs) { return Math.round(serverMs - (t0 + t1) / 2); }
export function remainingMs(qStartMs, timeSec, offsetMs, now = Date.now()) {
  if (qStartMs == null) return timeSec * 1000;
  return qStartMs + timeSec * 1000 - (now + offsetMs);
}

// ---------- export ----------
/** Builds the sheets for the results workbook. Returns [{name, rows, widths}] */
export function buildExport({ title, startedAt, mode, teams, teamMethod, questions, order, results, players, speed }) {
  const qs = order.map(i => questions[i]);
  const totals = totalsFrom(results, players);
  const ranked = rankPlayers(totals, players);
  const teamRows = mode === "teams" ? teamStandings(teams, ranked, teamMethod) : [];
  const teamName = id => teams.find(t => t.id === id)?.name || "";
  const asked = qs.map((q, i) => (results && results[i] ? i : -1)).filter(i => i >= 0);
  const sec = ms => Math.round(ms / 100) / 10;

  const summary = [
    ["FortiHoot results"], ["Game", title], ["Played", startedAt || ""],
    ["Mode", mode === "teams" ? `Teams (${teamMethod === "sum" ? "total" : "average"} score)` : "Everyone individually"],
    ["Players", ranked.length], ["Questions asked", asked.length], ["Speed scoring", speed ? "On" : "Off"], []
  ];
  if (mode === "teams") {
    summary.push(["Team rank", "Team", "Players", "Team score", "Total of member scores"]);
    for (const t of teamRows) summary.push([t.rank, t.name, t.players, t.score, t.sum]);
    summary.push([]);
  }
  summary.push(["Top players"], ["Rank", "Name", ...(mode === "teams" ? ["Team"] : []), "Score"]);
  for (const p of ranked.slice(0, 10)) summary.push([p.rank, p.name, ...(mode === "teams" ? [teamName(p.team)] : []), p.score]);

  const pHead = ["Rank", "Name", ...(mode === "teams" ? ["Team"] : []), "Score", "Correct", "Answered", "Avg response (s)", ...asked.map(i => `Q${i + 1} pts`)];
  const pRows = [pHead];
  for (const p of ranked) {
    const t = totals[p.uid];
    pRows.push([p.rank, p.name, ...(mode === "teams" ? [teamName(p.team)] : []), t.score, t.correct, t.answered,
      t.answered ? sec(t.rtSum / t.answered) : "", ...asked.map(i => results[i].perPlayer[p.uid]?.pts ?? "")]);
  }

  const qRows = [["#", "Question", "Type", "Correct answer", "Answered", "% correct", "Avg response (s)", "A", "B", "C", "D"]];
  asked.forEach(i => {
    const q = qs[i], r = results[i];
    const pp = Object.entries(r.perPlayer).filter(([u]) => players[u]);
    const ok = pp.filter(([, p]) => p.ok).length;
    const counts = q.options.map((_, oi) => pp.filter(([, p]) => p.c.includes(oi)).length);
    qRows.push([i + 1, q.text, q.type === "tf" ? "True/False" : q.type === "multi" ? "Multi-select" : "Multiple choice",
      q.correct.map(ci => `${LETTERS[ci]}: ${q.options[ci]}`).join("; "), pp.length,
      pp.length ? Math.round((ok / pp.length) * 100) : 0,
      pp.length ? sec(pp.reduce((s, [, p]) => s + p.rt, 0) / pp.length) : "", ...[0, 1, 2, 3].map(oi => (oi < counts.length ? counts[oi] : ""))]);
  });

  const aRows = [["Name", ...(mode === "teams" ? ["Team"] : []), "Q#", "Answer", "Correct?", "Response (s)", "Points"]];
  for (const p of ranked) for (const i of asked) {
    const a = results[i].perPlayer[p.uid];
    if (!a) continue;
    aRows.push([p.name, ...(mode === "teams" ? [teamName(p.team)] : []), i + 1, a.c.map(ci => LETTERS[ci]).join(","), a.ok ? "Yes" : "No", sec(a.rt), a.pts]);
  }
  const w = mode === "teams";
  const bold = [0];
  summary.forEach((r, i) => { if (["Team rank", "Top players", "Rank"].includes(r[0])) bold.push(i); });
  return [
    { name: "Summary", rows: summary, widths: [14, 34, 12, 14, 22], bold, table: false },
    { name: "Players", rows: pRows, widths: [7, 26, ...(w ? [14] : []), 9, 9, 10, 16, ...asked.map(() => 9)] },
    { name: "Questions", rows: qRows, widths: [5, 60, 15, 40, 10, 10, 16, 6, 6, 6, 6] },
    { name: "Answers", rows: aRows, widths: [26, ...(w ? [14] : []), 6, 9, 10, 13, 8] }
  ];
}
