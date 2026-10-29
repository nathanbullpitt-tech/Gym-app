// Kilo Coach runtime for Netlify.
// Provides the same small API the app was written against (window.claude.use("db" | "sample" | "assets" | "downloads")),
// backed by Netlify Identity, Netlify Database (via /api/data), the AI Gateway (via /api/ai) and Blobs (via /api/photo).
import {
  login, signup, logout, getUser, handleAuthCallback, requestPasswordRecovery,
  updateUser, refreshSession, getSettings, acceptInvite,
} from "@netlify/identity"

/* ---------------- helpers ---------------- */
const sleep = ms => new Promise(r => setTimeout(r, ms))
const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)))
const lsGet = k => { try { return JSON.parse(localStorage.getItem(k) || "null") } catch (e) { return null } }
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch (e) {} }
const lsDel = k => { try { localStorage.removeItem(k) } catch (e) {} }
const escH = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))

let me = null // { id, email }
let resolveReady
const ready = new Promise(r => (resolveReady = r))

async function api(path, init = {}, retried = false) {
  const res = await fetch(path, { credentials: "same-origin", ...init })
  if (res.status === 401 && !retried) {
    try { await refreshSession() } catch (e) {}
    return api(path, init, true)
  }
  if (res.status === 401) { showAuth("login", "Your session ended. Sign in again."); throw Object.assign(new Error("signed_out"), { code: "signed_out" }) }
  return res
}

/* ---------------- data store (db) ---------------- */
const store = {
  docs: {},            // path -> data
  docL: new Map(),     // path -> Set(listener)
  colL: new Map(),     // collection -> Set({cb, order, lim})
  outbox: [],          // pending ops
  flushing: false,
  timer: null,
  epoch: 0,            // bumps on every local write
}
const cacheKey = () => "kc-cache-" + (me && me.id)
const outboxKey = () => "kc-outbox-" + (me && me.id)

function docSnap(path) {
  const has = Object.prototype.hasOwnProperty.call(store.docs, path)
  const d = store.docs[path]
  return { id: path.split("/")[1], exists: has, data: () => clone(d) }
}
function colSnap(col, order, lim) {
  let docs = Object.keys(store.docs).filter(p => p.startsWith(col + "/")).map(p => ({ id: p.slice(col.length + 1), _d: store.docs[p] }))
  if (order) {
    const [f, dir] = order
    docs.sort((a, b) => { const x = a._d && a._d[f], y = b._d && b._d[f]; const c = x < y ? -1 : x > y ? 1 : 0; return dir === "desc" ? -c : c })
  }
  if (lim) docs = docs.slice(0, lim)
  return { docs: docs.map(x => ({ id: x.id, exists: true, data: () => clone(x._d) })), size: docs.length, empty: !docs.length }
}
let notifyQueued = new Set()
function notify(paths) {
  paths.forEach(p => notifyQueued.add(p))
  if (notify.t) return
  notify.t = setTimeout(() => {
    notify.t = null
    const ps = [...notifyQueued]; notifyQueued = new Set()
    const cols = new Set(ps.map(p => p.split("/")[0]))
    ps.forEach(p => (store.docL.get(p) || []).forEach(l => { try { l.cb(docSnap(p)) } catch (e) { console.error(e) } }))
    cols.forEach(c => (store.colL.get(c) || []).forEach(l => { try { l.cb(colSnap(c, l.order, l.lim)) } catch (e) { console.error(e) } }))
  }, 0)
}
function saveCache() { clearTimeout(saveCache.t); saveCache.t = setTimeout(() => lsSet(cacheKey(), store.docs), 400) }

function enqueue(op) {
  store.epoch++
  const p = op.path
  if (op.op === "delete") delete store.docs[p]
  else if (op.op === "update") store.docs[p] = { ...(store.docs[p] || {}), ...clone(op.data) }
  else store.docs[p] = clone(op.data)
  notify([p]); saveCache()
  store.outbox.push({ op: op.op, path: p, data: op.data === undefined ? undefined : clone(op.data) })
  lsSet(outboxKey(), store.outbox)
  // Resolve once applied locally: the outbox is saved on the device and retried until the server has it.
  scheduleFlush(250)
  return Promise.resolve()
}
function scheduleFlush(ms) { clearTimeout(store.timer); store.timer = setTimeout(flush, ms) }
async function flush() {
  if (store.flushing || !store.outbox.length || !me) return
  store.flushing = true
  const batch = store.outbox.slice(0, 150)
  const waiters = enqueue.waiters || []; enqueue.waiters = []
  try {
    const res = await api("/api/data", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ops: batch }) })
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      if (res.status === 400 || res.status === 413) {
        // Bad op: drop it so it can't block the queue forever.
        console.error("write rejected", j)
        store.outbox = store.outbox.slice(batch.length)
        waiters.forEach(w => w())
        window.dispatchEvent(new CustomEvent("kc-toast", { detail: j.error === "too_large" ? "That entry is too big to save." : "Couldn't save one change." }))
        return
      }
      throw new Error("http " + res.status)
    }
    store.outbox = store.outbox.slice(batch.length)
    lsSet(outboxKey(), store.outbox)
    setOffline(false)
    waiters.forEach(w => w())
    if (store.outbox.length) scheduleFlush(50)
  } catch (e) {
    // Keep the changes on this device and try again shortly.
    setOffline(true)
    waiters.forEach(w => w())
    scheduleFlush(8000)
  } finally {
    store.flushing = false
  }
}
window.addEventListener("online", () => scheduleFlush(100))

async function pull() {
  if (!me) return
  const epoch = store.epoch
  const res = await api("/api/data")
  if (!res.ok) throw new Error("http " + res.status)
  const { docs } = await res.json()
  if (store.epoch !== epoch || store.outbox.length || store.flushing) return false // local edits happened; try later
  const changed = new Set()
  for (const p of Object.keys(store.docs)) if (!(p in docs)) { changed.add(p); delete store.docs[p] }
  for (const [p, d] of Object.entries(docs)) if (JSON.stringify(store.docs[p]) !== JSON.stringify(d)) { changed.add(p); store.docs[p] = d }
  if (changed.size) { notify([...changed]); saveCache() }
  setOffline(false)
  return true
}
let pollT = null
function startSync() {
  const tick = async () => {
    clearTimeout(pollT)
    if (document.visibilityState === "visible") { try { await pull() } catch (e) {} }
  }
  // Sync when the app comes back to the foreground (no background polling, to save credits).
  let last = Date.now()
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { flush(); if (Date.now() - last > 60000) { last = Date.now(); tick() } }
    else flush()
  })
}

function makeQuery(col, order, lim) {
  return {
    orderBy: (f, dir) => makeQuery(col, [f, dir || "asc"], lim),
    limit: n => makeQuery(col, order, n),
    onSnapshot(cb) {
      const l = { cb, order, lim }
      if (!store.colL.has(col)) store.colL.set(col, new Set())
      store.colL.get(col).add(l)
      setTimeout(() => cb(colSnap(col, order, lim)), 0)
      return () => store.colL.get(col).delete(l)
    },
    async get() { return colSnap(col, order, lim) },
  }
}
const db = {
  doc(path) {
    path = String(path)
    return {
      id: path.split("/")[1],
      set: data => enqueue({ op: "set", path, data }),
      update: data => enqueue({ op: "update", path, data }),
      delete: () => enqueue({ op: "delete", path }),
      async get() { return docSnap(path) },
      onSnapshot(cb) {
        const l = { cb }
        if (!store.docL.has(path)) store.docL.set(path, new Set())
        store.docL.get(path).add(l)
        setTimeout(() => cb(docSnap(path)), 0)
        return () => store.docL.get(path).delete(l)
      },
    }
  },
  collection: col => makeQuery(String(col)),
}

let offlineBar = null
function setOffline(on) {
  if (!offlineBar) {
    offlineBar = document.createElement("div")
    offlineBar.className = "kc-offline"
    offlineBar.textContent = "Offline. Changes are saved on this phone and will sync."
    document.body.appendChild(offlineBar)
  }
  offlineBar.hidden = !on
}

/* ---------------- AI (sample) ---------------- */
async function toB64Image(file) {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image(); img.src = url; await img.decode()
    const k = Math.min(1, 1568 / Math.max(img.naturalWidth, img.naturalHeight))
    const c = document.createElement("canvas")
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k)
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height)
    return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: c.toDataURL("image/jpeg", 0.85).split(",")[1] } }
  } catch (e) {
    throw Object.assign(new Error("image"), { code: "image_rejected" })
  } finally { URL.revokeObjectURL(url) }
}
const asBlocks = c => (typeof c === "string" ? [{ type: "text", text: c }] : Array.isArray(c) ? c : [{ type: "text", text: String(c) }])
function normalise(msgs) {
  const out = []
  for (const m of msgs) {
    const role = m.role === "assistant" ? "assistant" : "user"
    const prev = out[out.length - 1]
    if (prev && prev.role === role) prev.content = [...asBlocks(prev.content), ...asBlocks(m.content)]
    else out.push({ role, content: m.content })
  }
  while (out.length && out[0].role !== "user") out.shift()
  return out
}

async function callAI(payload, signal, onDelta) {
  let res
  try {
    res = await api("/api/ai", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal })
  } catch (e) {
    if (e && e.name === "AbortError") throw Object.assign(new Error("cancelled"), { code: "cancelled" })
    throw e && e.code ? e : Object.assign(new Error("network"), { code: "network" })
  }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}))
    throw Object.assign(new Error(j.message || "ai"), { code: res.status === 429 ? "rate_limited" : j.error || "upstream", message: j.message })
  }
  const reader = res.body.getReader(), dec = new TextDecoder()
  let buf = "", done = null
  try {
    for (;;) {
      const { value, done: end } = await reader.read()
      if (end) break
      buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        if (!line.trim()) continue
        const ev = JSON.parse(line)
        if (ev.t === "text") onDelta && onDelta(ev.d)
        else if (ev.t === "done") done = ev
        else if (ev.t === "error") throw Object.assign(new Error(ev.message || "ai"), { code: ev.error || "upstream" })
      }
    }
  } catch (e) {
    if (e && e.name === "AbortError") throw Object.assign(new Error("cancelled"), { code: "cancelled" })
    throw e
  }
  if (!done) throw Object.assign(new Error("Connection dropped"), { code: "upstream" })
  return done
}

async function sample(input, opts = {}) {
  let messages = typeof input === "string" ? [{ role: "user", content: input }] : input.map(m => ({ role: m.role, content: m.content }))
  if (opts.images) {
    const files = Array.isArray(opts.images) ? opts.images : [opts.images]
    const imgs = []
    for (const f of files.slice(0, 6)) imgs.push(await toB64Image(f))
    const last = messages[messages.length - 1]
    last.content = [...imgs, ...asBlocks(last.content)]
  }
  messages = normalise(messages)
  const tools = Array.isArray(opts.tools) ? opts.tools : []
  const toolDefs = tools.map(t => ({ name: t.name, description: t.description || "", input_schema: t.inputSchema || t.input_schema || { type: "object", properties: {} } }))
  // Haiku for everything except calls that explicitly ask for the stronger model (plan building).
  const tier = opts.modelTier === "main" ? "main" : "quick"
  const parts = []
  let current = ""
  const emit = () => opts.onText && opts.onText({ text: [...parts, current].filter(Boolean).join("\n\n") })
  for (let turn = 0; turn < 10; turn++) {
    current = ""
    let r
    try {
      r = await callAI({ messages, tools: toolDefs, tier, max_tokens: opts.maxTokens || (tier === "main" ? 8000 : 3000), system: opts.system }, opts.signal, d => { current += d; emit() })
    } catch (e) {
      const partial = [...parts, current].filter(Boolean).join("\n\n")
      if (partial) e.text = partial
      throw e
    }
    const text = (r.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim()
    if (text) parts.push(text)
    current = ""
    if (r.stop_reason !== "tool_use" || !tools.length) break
    messages.push({ role: "assistant", content: r.content })
    const results = []
    for (const b of r.content.filter(x => x.type === "tool_use")) {
      const t = tools.find(x => x.name === b.name)
      try {
        if (!t) throw new Error("Unknown tool " + b.name)
        const out = await t.execute(b.input || {})
        results.push({ type: "tool_result", tool_use_id: b.id, content: typeof out === "string" ? out : JSON.stringify(out ?? "ok") })
      } catch (e) {
        results.push({ type: "tool_result", tool_use_id: b.id, is_error: true, content: String((e && e.message) || e) })
      }
    }
    messages.push({ role: "user", content: results })
  }
  const text = parts.join("\n\n")
  return { text }
}
function parseJSON(text) {
  let t = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "")
  try { return JSON.parse(t) } catch (e) {}
  const s = Math.min(...["[", "{"].map(c => { const i = t.indexOf(c); return i < 0 ? Infinity : i }))
  const e = Math.max(t.lastIndexOf("]"), t.lastIndexOf("}"))
  if (s !== Infinity && e > s) { try { return JSON.parse(t.slice(s, e + 1)) } catch (x) {} }
  throw Object.assign(new Error("invalid_json"), { code: "invalid_json" })
}
const AIC = "kc-aicache"
sample.json = async (prompt, opts = {}) => {
  const key = !opts.images && opts.cache !== false ? (opts.modelTier || "") + "|" + String(prompt) : null
  if (key) { const c = lsGet(AIC) || {}; if (c[key]) return clone(c[key].v) }
  const { text } = await sample(String(prompt) + "\n\nReply with the JSON only. No code fences, no other text.", { ...opts, tools: undefined, onText: undefined })
  const v = parseJSON(text)
  if (key) {
    const c = lsGet(AIC) || {}; c[key] = { v, t: Date.now() }
    const ks = Object.keys(c); if (ks.length > 150) ks.sort((a, b) => c[a].t - c[b].t).slice(0, ks.length - 150).forEach(k => delete c[k])
    lsSet(AIC, c)
  }
  return v
}
sample.limits = async () => ({ tools: true, images: true })

/* ---------------- photos (assets) ---------------- */
const assets = {
  async upload(blob, o = {}) {
    const res = await api("/api/photo", { method: "POST", headers: { "content-type": o.type || blob.type || "image/jpeg" }, body: blob })
    if (res.status === 413) throw Object.assign(new Error("too_large"), { code: "too_large" })
    if (!res.ok) throw new Error("upload failed")
    return res.json()
  },
  async delete(id) { await api("/api/photo/" + encodeURIComponent(id), { method: "DELETE" }) },
  url: id => "/api/photo/" + encodeURIComponent(id),
}

/* ---------------- downloads ---------------- */
const downloads = {
  async save({ filename, data, type }) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: type || (/\.json$/.test(filename) ? "application/json" : /\.csv$/.test(filename) ? "text/csv" : "text/plain") })
    const file = new File([blob], filename, { type: blob.type })
    if (navigator.canShare && navigator.canShare({ files: [file] }) && /iPhone|iPad|Android/i.test(navigator.userAgent)) {
      try { await navigator.share({ files: [file], title: filename }); return } catch (e) { if (e && e.name === "AbortError") throw Object.assign(e, { code: "declined" }) }
    }
    const a = document.createElement("a")
    a.href = URL.createObjectURL(blob); a.download = filename
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 4000)
  },
}

/* ---------------- shares ---------------- */
const KC = {
  get email() { return me && me.email },
  async share(kind, title, payload) {
    const res = await api("/api/share", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, title, payload }) })
    if (!res.ok) throw new Error("share failed")
    const { code } = await res.json()
    const url = location.origin + "/?share=" + code
    if (navigator.share) {
      try { await navigator.share({ title: "Kilo Coach: " + title, text: `Copy "${title}" into your Kilo Coach`, url }); return url } catch (e) { if (e && e.name === "AbortError") return url }
    }
    try { await navigator.clipboard.writeText(url); window.dispatchEvent(new CustomEvent("kc-toast", { detail: "Link copied. Send it to them." })) } catch (e) { prompt("Copy this link", url) }
    return url
  },
  async getShare(code) {
    const res = await fetch("/api/share/" + encodeURIComponent(code))
    if (!res.ok) return null
    return res.json()
  },
  pendingShare() {
    const c = new URLSearchParams(location.search).get("share")
    return c && /^[a-z0-9]{6,12}$/.test(c) ? c : null
  },
  clearShare() { const u = new URL(location.href); u.searchParams.delete("share"); history.replaceState(null, "", u.pathname + u.search + u.hash) },
  async signOut() {
    try { await flush() } catch (e) {}
    try { await logout() } catch (e) {}
    lsDel(cacheKey()); lsDel(outboxKey())
    location.reload()
  },
  async changePassword(pw) { await updateUser({ password: pw }) },
}
window.KC = KC

/* ---------------- claude.use shim ---------------- */
window.claude = {
  async use(name) {
    await ready
    if (name === "db") return db
    if (name === "sample") return sample
    if (name === "assets") return assets
    if (name === "downloads") return downloads
    throw Object.assign(new Error("unknown capability"), { code: "unavailable" })
  },
}

/* ---------------- sign-in screen ---------------- */
const css = `
.kc-auth{position:fixed;inset:0;z-index:1000;background:var(--bg);color:var(--ink);overflow:auto;display:flex;align-items:flex-start;justify-content:center;padding:max(48px,env(safe-area-inset-top)) 16px 32px}
.kc-auth[hidden]{display:none}
.kc-auth .box{width:100%;max-width:420px;display:flex;flex-direction:column;gap:14px}
.kc-auth .brand{font-family:'Saira Semi Condensed',sans-serif;font-weight:700;font-size:40px;line-height:1;text-transform:uppercase;letter-spacing:.03em;margin:8px 0 0}
.kc-auth .brand span{color:var(--accent)}
.kc-auth .sub{color:var(--muted);margin:0 0 6px}
.kc-auth .msg{font-size:14px;padding:10px 12px;border-radius:12px;background:var(--surface);border:1px solid var(--line)}
.kc-auth .msg.err{border-color:#a33;color:#ffb4b4}
.kc-auth .links{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}
.kc-auth .lnk{background:none;border:0;color:var(--accent);font:inherit;font-size:14px;padding:8px 0;min-height:44px;cursor:pointer}
.kc-offline{position:fixed;left:12px;right:12px;top:calc(env(safe-area-inset-top) + 8px);z-index:900;background:#3a2a07;color:#ffd98a;border-radius:12px;padding:8px 12px;font-size:13px;text-align:center}
.kc-offline[hidden]{display:none}
`
const style = document.createElement("style"); style.textContent = css; document.head.appendChild(style)
const host = document.createElement("div"); host.className = "kc-auth"; host.hidden = true
document.addEventListener("DOMContentLoaded", () => document.body.appendChild(host))
if (document.body) document.body.appendChild(host)

let signupOpen = true
function showAuth(view, note, isErr) {
  host.hidden = false
  const field = (id, label, type, ac, val = "") => `<label class="f" for="${id}">${label}<input class="i" id="${id}" type="${type}" autocomplete="${ac}" value="${escH(val)}" required></label>`
  const email = (host.querySelector("#kcE") || {}).value || ""
  const msg = note ? `<div class="msg${isErr ? " err" : ""}" role="${isErr ? "alert" : "status"}">${escH(note)}</div>` : ""
  let h = `<div class="box"><h1 class="brand">Kilo<span>Coach</span></h1>`
  if (view === "login") h += `<p class="sub">Sign in to your account. Your logs are private to you.</p>${msg}<form id="kcF" class="ex">${field("kcE", "Email", "email", "email", email)}${field("kcP", "Password", "password", "current-password")}<button class="btn wide" type="submit">Sign in</button></form><div class="links">${signupOpen ? `<button class="lnk" data-v="signup">Create an account</button>` : ""}<button class="lnk" data-v="forgot">Forgot password?</button></div>`
  if (view === "signup") h += `<p class="sub">Create your own account. Nobody else can see your stats.</p>${msg}<form id="kcF" class="ex">${field("kcN", "First name", "text", "given-name")}${field("kcE", "Email", "email", "email", email)}${field("kcP", "Password (8+ characters)", "password", "new-password")}<button class="btn wide" type="submit">Create account</button></form><div class="links"><button class="lnk" data-v="login">I already have an account</button></div>`
  if (view === "forgot") h += `<p class="sub">We'll email you a link to set a new password.</p>${msg}<form id="kcF" class="ex">${field("kcE", "Email", "email", "email", email)}<button class="btn wide" type="submit">Send reset link</button></form><div class="links"><button class="lnk" data-v="login">Back to sign in</button></div>`
  if (view === "reset" || view === "invite") h += `<p class="sub">${view === "invite" ? "Welcome. Pick a password to finish setting up." : "Pick a new password."}</p>${msg}<form id="kcF" class="ex">${field("kcP", "New password (8+ characters)", "password", "new-password")}<button class="btn wide" type="submit">Save password</button></form>`
  if (view === "sent") h += `${msg}<div class="links"><button class="lnk" data-v="login">Back to sign in</button></div>`
  h += `</div>`
  host.innerHTML = h
  host.querySelectorAll("[data-v]").forEach(b => (b.onclick = () => showAuth(b.dataset.v)))
  const f = host.querySelector("#kcF")
  if (!f) return
  const first = f.querySelector("input"); if (first && !first.value) setTimeout(() => first.focus(), 50)
  f.onsubmit = async ev => {
    ev.preventDefault()
    const btn = f.querySelector("button[type=submit]"), label = btn.textContent
    btn.disabled = true; btn.textContent = "One sec…"
    const E = (f.querySelector("#kcE") || {}).value, P = (f.querySelector("#kcP") || {}).value, N = (f.querySelector("#kcN") || {}).value
    try {
      if (view === "login") { const u = await login(E.trim(), P); await signedIn(u) }
      if (view === "signup") {
        if ((P || "").length < 8) throw new Error("Use at least 8 characters for the password.")
        const u = await signup(E.trim(), P, { full_name: (N || "").trim() })
        const cur = await getUser()
        if (cur) await signedIn(cur)
        else showAuth("sent", `Check ${E.trim()} for a confirmation link, then come back here. It can take a minute, and check spam too.`)
      }
      if (view === "forgot") { await requestPasswordRecovery(E.trim()); showAuth("sent", "If that email has an account, a reset link is on its way.") }
      if (view === "reset") { if ((P || "").length < 8) throw new Error("Use at least 8 characters."); await updateUser({ password: P }); const u = await getUser(); await signedIn(u) }
      if (view === "invite") { if ((P || "").length < 8) throw new Error("Use at least 8 characters."); const u = await acceptInvite(showAuth.inviteToken, P); await signedIn(u) }
    } catch (e) {
      btn.disabled = false; btn.textContent = label
      showAuth(view, friendly(e), true)
    }
  }
}
function friendly(e) {
  const m = String((e && (e.message || e.error_description)) || e || "")
  if (/invalid.*(grant|login|credentials|password)|no user found|email or password/i.test(m)) return "That email and password don't match."
  if (/not confirmed|confirm/i.test(m)) return "Confirm your email first. The link is in your inbox."
  if (/already.*registered|exists/i.test(m)) return "That email already has an account. Sign in instead."
  if (/signups? not allowed|disabled/i.test(m)) return "New sign-ups are switched off. Ask Nathan to invite you."
  if (/MissingIdentity|identity/i.test(m) && /not|missing|configured/i.test(m)) return "Logins aren't switched on for this site yet (Netlify Identity)."
  if (/network|fetch/i.test(m)) return "No connection. Try again."
  return m || "Something went wrong. Try again."
}

async function signedIn(user) {
  if (!user) { showAuth("login"); return }
  me = { id: user.id, email: user.email || "" }
  // Load cached data first so the app opens instantly, then fetch fresh.
  const cached = lsGet(cacheKey())
  if (cached && typeof cached === "object") store.docs = cached
  store.outbox = lsGet(outboxKey()) || []
  host.hidden = true
  try { await pull() } catch (e) { if (!cached) { /* first load offline */ setOffline(true) } }
  if (store.outbox.length) scheduleFlush(50)
  startSync()
  resolveReady()
}

async function start() {
  try { const s = await getSettings(); signupOpen = !s.disableSignup } catch (e) {}
  try {
    const cb = await handleAuthCallback()
    if (cb) {
      history.replaceState(null, "", location.pathname + location.search)
      if (cb.type === "recovery") { showAuth("reset"); return }
      if (cb.type === "invite" && cb.token) { showAuth.inviteToken = cb.token; showAuth("invite"); return }
      if (cb.user) { await signedIn(cb.user); return }
    }
  } catch (e) {
    showAuth("login", friendly(e), true); return
  }
  const u = await getUser().catch(() => null)
  if (u) await signedIn(u)
  else showAuth(new URLSearchParams(location.search).get("share") ? "signup" : "login", new URLSearchParams(location.search).get("share") ? "Someone shared a workout with you. Sign in or create an account to copy it." : "")
}
start()
