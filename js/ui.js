// FortiHoot — small DOM helpers shared by the pages.
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
export function fmt(n) { return Number(n || 0).toLocaleString("en-US"); }
export function ordinal(n) { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
let toastTimer;
export function toast(msg, ms = 2600) {
  let t = document.getElementById("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}
export function show(id, all) { all.forEach(s => document.getElementById(s).classList.toggle("hidden", s !== id)); }
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); const ok = document.execCommand("copy"); ta.remove(); return ok; }
}
/** White answer-shape icons, Kahoot-style, so colors are never the only cue. */
export const SHAPES = [
  '<svg class="shape" viewBox="0 0 40 40" aria-hidden="true"><path d="M20 5 37 34H3z" fill="#fff"/></svg>',
  '<svg class="shape" viewBox="0 0 40 40" aria-hidden="true"><path d="M20 3 37 20 20 37 3 20z" fill="#fff"/></svg>',
  '<svg class="shape" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="16" fill="#fff"/></svg>',
  '<svg class="shape" viewBox="0 0 40 40" aria-hidden="true"><rect x="5" y="5" width="30" height="30" rx="3" fill="#fff"/></svg>'
];
/** Fills the header from config (app name). "FortiHoot" gets its two-tone wordmark in the header. */
export function brandHeader(cfg) {
  const name = (cfg && cfg.appName) || "FortiHoot";
  document.querySelectorAll("[data-app-name]").forEach(el => {
    if (el.classList.contains("app-name") && /^Forti/.test(name)) { el.textContent = "Forti"; const s = document.createElement("span"); s.className = "hoot"; s.textContent = name.slice(5); el.appendChild(s); }
    else el.textContent = name;
  });
}
