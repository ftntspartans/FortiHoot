// FortiHoot — data layer. Every page talks to Firebase only through this file.
// Paths look like "games/<id>", "games/<id>/players/<uid>", "codes/<CODE>".
// Timestamps come back as milliseconds; write SERVER_TIME to stamp server time, DELETE to remove a field.
import * as F from "./firebase-sdk.js";

export const SERVER_TIME = { __serverTime: true };
export const DELETE = { __delete: true };

/** Opens the store. `appName` gives a separate sign-in per name (the test-bot page uses one per bot). */
export async function openStore(config, opts = {}) {
  const backend = new URLSearchParams(location.search).get("backend");
  if (backend && backend.startsWith("local")) {
    // Test harness only (tests/local-backend). The file does not exist on the live site.
    const mod = await import("./store-local.js");
    return mod.openLocalStore(backend, opts);
  }
  if (!config || !config.firebase || !config.firebase.apiKey || String(config.firebase.apiKey).includes("PASTE")) {
    throw Object.assign(new Error("config.js still has the placeholder Firebase settings. See setup guide step 4."), { code: "not-configured" });
  }
  return openFirebaseStore(config, opts);
}

function isTs(v) { return v && typeof v.toMillis === "function" && typeof v.seconds === "number"; }
function fromFs(v) {
  if (isTs(v)) return v.toMillis();
  if (Array.isArray(v)) return v.map(fromFs);
  if (v && typeof v === "object") { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = fromFs(x); return o; }
  return v;
}
function toFs(v) {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    if (v.__serverTime) return F.serverTimestamp();
    if (v.__delete) return F.deleteField();
    const o = {}; for (const [k, x] of Object.entries(v)) o[k] = toFs(x); return o;
  }
  if (Array.isArray(v)) return v.map(toFs);
  return v;
}

function openFirebaseStore(config, { appName } = {}) {
  const name = appName || "[DEFAULT]";
  const app = F.getApps().find(a => a.name === name) || (appName ? F.initializeApp(config.firebase, appName) : F.initializeApp(config.firebase));
  const auth = F.getAuth(app);
  const db = F.getFirestore(app);
  const ref = p => F.doc(db, p);
  const view = u => (u ? { uid: u.uid, email: u.email || null, anonymous: u.isAnonymous, name: u.displayName || null } : null);

  return {
    kind: "firebase",
    onAuth(cb) { return F.onAuthStateChanged(auth, u => cb(view(u))); },
    async signInHost() {
      const p = new F.GoogleAuthProvider();
      p.setCustomParameters({ prompt: "select_account" });
      await F.signInWithPopup(auth, p);
    },
    async ready() { await auth.authStateReady(); return view(auth.currentUser); },
    async signInPlayer() {
      await auth.authStateReady(); // reuse this browser's saved player identity instead of making a new one
      if (auth.currentUser) return auth.currentUser.uid;
      const c = await F.signInAnonymously(auth);
      return c.user.uid;
    },
    async signOut() { await F.signOut(auth); },
    uid() { return auth.currentUser ? auth.currentUser.uid : null; },
    newId() { return F.doc(F.collection(db, "games")).id; },
    async get(p) { const s = await F.getDoc(ref(p)); return s.exists() ? fromFs(s.data()) : null; },
    async getFromServer(p) { const s = await F.getDocFromServer(ref(p)); return s.exists() ? fromFs(s.data()) : null; },
    async set(p, data, opts = {}) { await F.setDoc(ref(p), toFs(data), opts.merge ? { merge: true } : {}); },
    async update(p, data) { await F.updateDoc(ref(p), toFs(data)); },
    async del(p) { await F.deleteDoc(ref(p)); },
    async batch(ops) {
      const b = F.writeBatch(db);
      for (const o of ops) {
        if (o.type === "set") b.set(ref(o.path), toFs(o.data), o.merge ? { merge: true } : {});
        else if (o.type === "update") b.update(ref(o.path), toFs(o.data));
        else if (o.type === "delete") b.delete(ref(o.path));
      }
      await b.commit();
    },
    /** One-time query: filters are [field, "==", value] triples. Returns [{id, ...data}]. */
    async query(col, filters) {
      const q = F.query(F.collection(db, col), ...filters.map(([f, op, v]) => F.where(f, op, v)));
      const snap = await F.getDocs(q);
      return snap.docs.map(d => ({ id: d.id, ...fromFs(d.data()) }));
    },
    watch(p, cb, onErr) {
      return F.onSnapshot(ref(p), s => cb(s.exists() ? fromFs(s.data({ serverTimestamps: "estimate" })) : null, { pending: s.metadata.hasPendingWrites }), e => onErr && onErr(e));
    },
    watchQuery(col, filters, cb, onErr) {
      const q = F.query(F.collection(db, col), ...filters.map(([f, op, v]) => F.where(f, op, v)));
      return F.onSnapshot(q, s => cb(s.docs.map(d => ({ id: d.id, ...fromFs(d.data({ serverTimestamps: "estimate" })) }))), e => onErr && onErr(e));
    },
    close() { /* the SDK keeps one connection per app; nothing to do */ }
  };
}

/** For tests. */
export const _internal = { toFs, fromFs };

/** Measures this browser's clock offset to server time with one write + one read of `path` (a doc we may write). */
export async function syncClock(store, path, field, writeFn) {
  const t0 = Date.now();
  await writeFn();
  const t1 = Date.now();
  const d = await store.getFromServer(path);
  const server = d && typeof d[field] === "number" ? d[field] : null;
  if (server == null) return 0;
  return Math.round(server - (t0 + t1) / 2);
}

/** Friendly text for common errors. */
export function errText(e) {
  const c = (e && e.code) || "";
  if (c === "permission-denied") return "Not allowed (security rules said no).";
  if (c === "not-configured") return e.message;
  if (c === "unavailable" || c === "deadline-exceeded") return "Can't reach the game server — check the internet connection.";
  if (c === "resource-exhausted") return "The free daily limit for the game server has been reached. It resets at midnight Pacific time.";
  if (c === "auth/popup-blocked") return "The sign-in popup was blocked. Allow popups for this site and try again.";
  if (c === "auth/popup-closed-by-user" || c === "auth/cancelled-popup-request") return "Sign-in was cancelled.";
  if (c === "auth/unauthorized-domain") return "This website address isn't authorized for sign-in yet (setup guide step 6).";
  if (c === "auth/operation-not-allowed" || c === "auth/admin-restricted-operation") return "That sign-in method isn't turned on in Firebase (setup guide step 2).";
  if (c === "auth/too-many-requests") return "Too many new sign-ins from this network in the last hour (Firebase allows 100 per hour per network). Try again later or use a different network.";
  if (c === "auth/network-request-failed") return "Network error during sign-in — check the internet connection.";
  return (e && e.message) || String(e);
}
