'use strict';
/*
 * SailDeck - self-hosted sailing centre manager.
 * Zero npm dependencies: Node 22+ (built-in node:sqlite, node:http, node:crypto).
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CENTRE_NAME = process.env.CENTRE_NAME || 'Harbour Sailing Centre';
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_HOURS = 12;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'saildeck.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff', pass_hash TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS boats (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'dinghy', class TEXT, sail_no TEXT,
  status TEXT NOT NULL DEFAULT 'available', notes TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS defects (
  id INTEGER PRIMARY KEY, boat_id INTEGER NOT NULL REFERENCES boats(id) ON DELETE CASCADE,
  description TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'minor', reported_by TEXT,
  reported_at TEXT NOT NULL, resolved_at TEXT, resolution TEXT);
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'member', email TEXT, phone TEXT,
  emergency_contact TEXT, qualifications TEXT, first_aid_expiry TEXT, membership_expiry TEXT, notes TEXT,
  created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY, boat_id INTEGER REFERENCES boats(id) ON DELETE SET NULL,
  member_id INTEGER REFERENCES members(id) ON DELETE SET NULL, title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'hire',
  start TEXT NOT NULL, end TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'confirmed', notes TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS signouts (
  id INTEGER PRIMARY KEY, boat_id INTEGER NOT NULL REFERENCES boats(id), helm_name TEXT NOT NULL,
  member_id INTEGER REFERENCES members(id) ON DELETE SET NULL, crew INTEGER NOT NULL DEFAULT 1,
  destination TEXT, out_at TEXT NOT NULL, due_back TEXT NOT NULL, in_at TEXT, notes TEXT,
  signed_out_by TEXT, signed_in_by TEXT, override_reason TEXT);
CREATE TABLE IF NOT EXISTS conditions (
  id INTEGER PRIMARY KEY, recorded_at TEXT NOT NULL, wind_kts REAL, gust_kts REAL, wind_dir TEXT,
  flag TEXT NOT NULL DEFAULT 'green', tide TEXT, notes TEXT, recorded_by TEXT);
CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY, occurred_at TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'near_miss',
  type TEXT, description TEXT NOT NULL, injuries TEXT, action_taken TEXT,
  boat_id INTEGER REFERENCES boats(id) ON DELETE SET NULL, status TEXT NOT NULL DEFAULT 'open', reported_by TEXT);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, user TEXT, action TEXT NOT NULL, entity TEXT, entity_id INTEGER);
CREATE INDEX IF NOT EXISTS idx_signouts_open ON signouts(in_at);
CREATE INDEX IF NOT EXISTS idx_bookings_start ON bookings(start);
CREATE INDEX IF NOT EXISTS idx_defects_open ON defects(resolved_at);
`);

/* ---------- helpers ---------- */
const now = () => new Date().toISOString();
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const q = (sql, ...p) => db.prepare(sql).all(...p);
const q1 = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
const audit = (user, action, entity, id) =>
  run('INSERT INTO audit(at,user,action,entity,entity_id) VALUES (?,?,?,?,?)', now(), user ? user.username : null, action, entity, id ?? null);
function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/* ---------- schema migrations (safe to run on every start) ---------- */
function addColumn(table, col, def) {
  if (!q(`PRAGMA table_info(${table})`).some(c => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('bookings', 'source', "TEXT NOT NULL DEFAULT 'local'");
addColumn('bookings', 'external_id', 'TEXT');
addColumn('bookings', 'external_item', 'TEXT');
addColumn('bookings', 'boat_class', 'TEXT');
db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_ext ON bookings(source, external_id) WHERE external_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS item_map (
  item_key TEXT PRIMARY KEY, item_label TEXT NOT NULL,
  boat_id INTEGER REFERENCES boats(id) ON DELETE CASCADE, boat_class TEXT);
`);

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const a = Buffer.from(hash, 'hex');
  const b = crypto.scryptSync(pw, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------- first run: admin account ---------- */
if (!q1('SELECT id FROM users LIMIT 1')) {
  const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  run('INSERT INTO users(username,name,role,pass_hash,created_at) VALUES (?,?,?,?,?)',
    'admin', 'Administrator', 'admin', hashPassword(pw), now());
  console.log('==================================================');
  console.log(' SailDeck first run: created user "admin"');
  if (!process.env.ADMIN_PASSWORD) console.log(' Generated password: ' + pw + '   (change it under Admin > Change my password)');
  console.log('==================================================');
}

/* ---------- optional demo data ---------- */
if (process.env.SEED_DEMO === 'true' && !q1('SELECT id FROM boats LIMIT 1')) {
  const boats = [
    ['Wanderer', 'dinghy', 'RS Quest', '1201'], ['Osprey', 'dinghy', 'RS Quest', '1202'],
    ['Kestrel', 'dinghy', 'Laser Pico', '4410'], ['Gannet', 'dinghy', 'Laser Pico', '4411'],
    ['Petrel', 'dinghy', 'RS Feva', '3307'], ['Albatross', 'keelboat', 'Sonar', '88'],
    ['Rescue 1', 'rib', 'Humber 5.0m RIB', null], ['Rescue 2', 'rib', 'Ribcraft 4.8m', null],
    ['Paddle A', 'paddleboard', 'Inflatable SUP', null], ['Kayak A', 'kayak', 'Sit-on-top', null]];
  boats.forEach(b => run('INSERT INTO boats(name,kind,class,sail_no,created_at) VALUES (?,?,?,?,?)', ...b, now()));
  const inDays = d => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
  [['Sam Taylor', 'instructor', 'RYA Dinghy Instructor; Powerboat L2', inDays(200), inDays(300)],
   ['Priya Nair', 'instructor', 'RYA Senior Instructor; Powerboat L2; VHF', inDays(12), inDays(120)],
   ['Jo Mitchell', 'member', 'Start Racing; Powerboat L1', inDays(-5), inDays(25)],
   ['Alex Chen', 'student', 'Stage 2', null, inDays(60)],
   ['Morgan Reid', 'volunteer', 'Safety boat crew', inDays(90), inDays(200)]]
    .forEach(m => run('INSERT INTO members(name,type,qualifications,first_aid_expiry,membership_expiry,created_at) VALUES (?,?,?,?,?,?)', ...m, now()));
  run("INSERT INTO defects(boat_id,description,severity,reported_by,reported_at) VALUES (3,'Frayed mainsheet','minor','Sam Taylor',?)", now());
  run("INSERT INTO conditions(recorded_at,wind_kts,gust_kts,wind_dir,flag,tide,recorded_by) VALUES (?,?,?,?,?,?,?)", now(), 8, 12, 'SW', 'green', 'Flooding, HW 15:40', 'admin');
  console.log('Seeded demo data.');
}

/* ---------- resource definitions ---------- */
const ENUM = {
  'boats.kind': ['dinghy', 'keelboat', 'rib', 'kayak', 'paddleboard', 'other'],
  'boats.status': ['available', 'on_water', 'out_of_service', 'maintenance'],
  'defects.severity': ['minor', 'major', 'critical'],
  'members.type': ['member', 'student', 'instructor', 'volunteer', 'visitor'],
  'bookings.kind': ['hire', 'lesson', 'course', 'race', 'other'],
  'bookings.status': ['confirmed', 'cancelled', 'completed'],
  'conditions.flag': ['green', 'yellow', 'red'],
  'incidents.severity': ['near_miss', 'minor', 'serious', 'critical'],
  'incidents.status': ['open', 'investigating', 'closed'],
};
const RES = {
  boats: { fields: ['name', 'kind', 'class', 'sail_no', 'status', 'notes'], required: ['name'] },
  members: { fields: ['name', 'type', 'email', 'phone', 'emergency_contact', 'qualifications', 'first_aid_expiry', 'membership_expiry', 'notes'], required: ['name'] },
  bookings: { fields: ['boat_id', 'member_id', 'title', 'kind', 'start', 'end', 'status', 'notes'], required: ['title', 'start', 'end'] },
  conditions: { fields: ['recorded_at', 'wind_kts', 'gust_kts', 'wind_dir', 'flag', 'tide', 'notes'], required: ['flag'], noUpdate: true },
  incidents: { fields: ['occurred_at', 'severity', 'type', 'description', 'injuries', 'action_taken', 'boat_id', 'status'], required: ['description'] },
  defects: { fields: ['boat_id', 'description', 'severity'], required: ['boat_id', 'description'], noUpdate: true },
};
const LIST_SQL = {
  boats: `SELECT b.*, (SELECT COUNT(*) FROM defects d WHERE d.boat_id=b.id AND d.resolved_at IS NULL) AS open_defects
          FROM boats b ORDER BY b.kind, b.name`,
  members: 'SELECT * FROM members ORDER BY name',
  bookings: `SELECT k.*, b.name AS boat_name, m.name AS member_name FROM bookings k
             LEFT JOIN boats b ON b.id=k.boat_id LEFT JOIN members m ON m.id=k.member_id ORDER BY k.start DESC LIMIT 500`,
  conditions: 'SELECT * FROM conditions ORDER BY recorded_at DESC LIMIT 100',
  incidents: `SELECT i.*, b.name AS boat_name FROM incidents i LEFT JOIN boats b ON b.id=i.boat_id ORDER BY i.occurred_at DESC LIMIT 300`,
  defects: `SELECT d.*, b.name AS boat_name FROM defects d JOIN boats b ON b.id=d.boat_id
            ORDER BY (d.resolved_at IS NOT NULL), CASE d.severity WHEN 'critical' THEN 0 WHEN 'major' THEN 1 ELSE 2 END, d.reported_at DESC LIMIT 300`,
  signouts: `SELECT s.*, b.name AS boat_name, b.kind AS boat_kind FROM signouts s JOIN boats b ON b.id=s.boat_id
             ORDER BY (s.in_at IS NOT NULL), s.out_at DESC LIMIT 300`,
};

function clean(resName, body, partial) {
  const def = RES[resName];
  const out = {};
  for (const f of def.fields) {
    if (!(f in body)) continue;
    let v = body[f];
    if (typeof v === 'string') { v = v.trim(); if (v === '') v = null; }
    if (v !== null && typeof v !== 'string' && typeof v !== 'number') throw new HttpError(400, `Invalid value for ${f}`);
    if (typeof v === 'string' && v.length > 4000) throw new HttpError(400, `${f} is too long`);
    const allowed = ENUM[`${resName}.${f}`];
    if (v !== null && allowed && !allowed.includes(v)) throw new HttpError(400, `Invalid ${f}: ${v}`);
    out[f] = v;
  }
  for (const f of def.required) {
    const missing = partial ? (f in out && out[f] == null) : out[f] == null;
    if (missing) throw new HttpError(400, `${f} is required`);
  }
  for (const f of ['start', 'end', 'recorded_at', 'occurred_at'])
    if (out[f] && Number.isNaN(Date.parse(out[f]))) throw new HttpError(400, `${f} is not a valid date`);
  for (const f of ['wind_kts', 'gust_kts'])
    if (out[f] != null && !Number.isFinite(Number(out[f]))) throw new HttpError(400, `${f} must be a number`);
  return out;
}

function bookingConflict(b, ignoreId) {
  if (!b.boat_id || b.status === 'cancelled') return null;
  return q1(`SELECT id, title, start, end FROM bookings WHERE boat_id=? AND status!='cancelled' AND id!=?
             AND start < ? AND end > ?`, b.boat_id, ignoreId || 0, b.end, b.start);
}

/* ---------- website bookings feed (read-only import from another site) ---------- */
let EXT_URL = process.env.EXTERNAL_BOOKINGS_URL || '';
const EXT_TOKEN = process.env.EXTERNAL_BOOKINGS_TOKEN || '';
const EXT_MINUTES = Math.max(1, Number(process.env.EXTERNAL_SYNC_MINUTES) || 5);
let EXT_HOST = '';
if (EXT_URL) {
  try {
    const u = new URL(EXT_URL);
    if (!/^https?:$/.test(u.protocol)) throw new Error('not http(s)');
    EXT_HOST = u.host;
  } catch { console.warn('EXTERNAL_BOOKINGS_URL is not a valid http(s) URL; website feed disabled'); EXT_URL = ''; }
}
let FIELD_MAP = {};
try { if (process.env.EXTERNAL_FIELD_MAP) FIELD_MAP = JSON.parse(process.env.EXTERNAL_FIELD_MAP); }
catch { console.warn('EXTERNAL_FIELD_MAP is not valid JSON; ignoring it'); }
// Where to look for each field in a feed row. Override any with EXTERNAL_FIELD_MAP, e.g. {"id":"booking_id","title":"customer.name"}
const FIELD_CANDIDATES = {
  id: ['id', 'booking_id', 'bookingId', 'code', 'booking_code', 'ref', 'reference'],
  title: ['title', 'name', 'customer_name', 'customer', 'summary', 'description'],
  item: ['item', 'item_name', 'boat', 'resource', 'product', 'sku', 'equipment'],
  start: ['start', 'start_date', 'startDate', 'from', 'begin', 'start_time'],
  end: ['end', 'end_date', 'endDate', 'to', 'finish', 'end_time'],
  status: ['status', 'state', 'status_name'],
};
const CANCEL_RE = /^(canc|void|decl|stop|del|refund|expire|reject|no.?show|abandon)/i;
const getPath = (o, p) => String(p).split('.').reduce((v, k) => (v == null ? undefined : v[k]), o);
function pick(row, field) {
  const paths = FIELD_MAP[field] ? [FIELD_MAP[field]] : FIELD_CANDIDATES[field];
  for (const p of paths) {
    let v = getPath(row, p);
    if (Array.isArray(v)) continue;
    if (v && typeof v === 'object') v = v.name ?? v.title ?? v.code ?? v.id;
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
}
function parseWhen(v, isEnd) {
  if (v == null) return null;
  if (typeof v === 'number' || /^\d{9,13}$/.test(String(v))) { const n = Number(v); return new Date(n < 1e12 ? n * 1000 : n).toISOString(); }
  const s = String(v).trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
  const ms = Date.parse(dateOnly ? s + 'T00:00:00' : s); // no timezone in the text = container TZ
  if (Number.isNaN(ms)) return null;
  return new Date(dateOnly && isEnd ? ms + 864e5 : ms).toISOString(); // date-only end = end of that day
}
function resolveTarget(item) {
  if (!item) return { boat_id: null, boat_class: null };
  const key = String(item).trim().toLowerCase();
  const m = q1('SELECT boat_id, boat_class FROM item_map WHERE item_key=?', key);
  if (m) return { boat_id: m.boat_id, boat_class: m.boat_class };
  const boat = q1('SELECT id FROM boats WHERE lower(name)=? OR lower(sail_no)=?', key, key);
  return { boat_id: boat ? boat.id : null, boat_class: null };
}

const ext = { ok: null, error: null, lastRun: null, total: 0, imported: 0, updated: 0, cancelled: 0, skipped: 0 };
let extRunning = false, lastManualSync = 0;

function applyFeed(rows) {
  const st = { imported: 0, updated: 0, cancelled: 0, skipped: 0 };
  const seen = new Set();
  tx(() => {
    for (const r of rows) {
      if (!r || typeof r !== 'object') { st.skipped++; continue; }
      const id = pick(r, 'id');
      const start = parseWhen(pick(r, 'start'), false), end = parseWhen(pick(r, 'end'), true);
      if (id == null || !start || !end || end <= start) { st.skipped++; continue; }
      const extId = String(id).trim().slice(0, 100);
      const itemRaw = pick(r, 'item');
      const item = itemRaw == null ? null : String(itemRaw).trim().slice(0, 200);
      const title = String(pick(r, 'title') ?? item ?? `Booking ${extId}`).trim().slice(0, 200);
      const status = CANCEL_RE.test(String(pick(r, 'status') ?? '').trim()) ? 'cancelled' : 'confirmed';
      const t = resolveTarget(item);
      seen.add(extId);
      const cur = q1("SELECT * FROM bookings WHERE source='external' AND external_id=?", extId);
      if (cur) {
        const next = { title, start, end, status, boat_id: t.boat_id, boat_class: t.boat_class, external_item: item };
        if (Object.keys(next).some(k => (cur[k] ?? null) !== (next[k] ?? null))) {
          run('UPDATE bookings SET title=?, start=?, end=?, status=?, boat_id=?, boat_class=?, external_item=? WHERE id=?',
            title, start, end, status, t.boat_id, t.boat_class, item, cur.id);
          st.updated++;
        }
      } else {
        run(`INSERT INTO bookings(title,kind,start,end,status,boat_id,boat_class,created_at,source,external_id,external_item)
             VALUES (?,?,?,?,?,?,?,?,'external',?,?)`, title, 'other', start, end, status, t.boat_id, t.boat_class, now(), extId, item);
        st.imported++;
      }
    }
    // A future booking that vanished from a non-empty feed was cancelled/removed on the website.
    if (seen.size) {
      for (const b of q("SELECT id, external_id FROM bookings WHERE source='external' AND status='confirmed' AND start > ?", now()))
        if (!seen.has(b.external_id)) { run("UPDATE bookings SET status='cancelled' WHERE id=?", b.id); st.cancelled++; }
    }
  });
  return st;
}

async function syncExternal() {
  if (!EXT_URL || extRunning) return;
  extRunning = true;
  try {
    const res = await fetch(EXT_URL, {
      headers: { Accept: 'application/json', ...(EXT_TOKEN ? { Authorization: `Bearer ${EXT_TOKEN}` } : {}) },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Feed returned HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > 5e6) throw new Error('Feed is larger than 5 MB');
    let data; try { data = JSON.parse(text); } catch { throw new Error('Feed is not valid JSON'); }
    const rows = Array.isArray(data) ? data : ['bookings', 'data', 'results', 'items'].map(k => data && data[k]).find(Array.isArray);
    if (!rows) throw new Error('Feed JSON has no list of bookings (expected an array, or {"bookings":[...]})');
    Object.assign(ext, applyFeed(rows), { ok: true, error: null, total: rows.length, lastRun: now() });
  } catch (e) {
    Object.assign(ext, { ok: false, error: e.name === 'TimeoutError' ? 'Feed timed out after 15s' : (e.cause && e.cause.code) ? `Cannot reach feed (${e.cause.code})` : e.message, lastRun: now() });
  } finally { extRunning = false; }
}

function externalStatus() {
  if (!EXT_URL) return { configured: false };
  return {
    configured: true, host: EXT_HOST, minutes: EXT_MINUTES, ...ext,
    unmapped: q(`SELECT external_item AS item, COUNT(*) AS count FROM bookings
                 WHERE source='external' AND boat_id IS NULL AND boat_class IS NULL AND external_item IS NOT NULL
                 AND status='confirmed' AND end > ? GROUP BY lower(external_item) ORDER BY count DESC`, now()),
    mappings: q(`SELECT m.item_key, m.item_label, m.boat_id, m.boat_class, b.name AS boat_name
                 FROM item_map m LEFT JOIN boats b ON b.id=m.boat_id ORDER BY m.item_label`),
  };
}

// Overlaps on a specific boat, plus pooled ("any RS Quest") bookings that exceed the boats available in that class.
function findClashes() {
  const horizon = new Date(Date.now() + 60 * 864e5).toISOString();
  const rows = q(`SELECT k.id, k.title, k.start, k.end, k.boat_id, k.boat_class, b.name AS boat_name FROM bookings k
                  LEFT JOIN boats b ON b.id=k.boat_id WHERE k.status='confirmed' AND k.end > ? AND k.start < ? ORDER BY k.start`, now(), horizon);
  const out = [], byBoat = new Map(), pools = new Map();
  for (const r of rows) {
    if (r.boat_id) { if (!byBoat.has(r.boat_id)) byBoat.set(r.boat_id, []); byBoat.get(r.boat_id).push(r); }
    else if (r.boat_class) { const k = r.boat_class.toLowerCase(); if (!pools.has(k)) pools.set(k, { name: r.boat_class, list: [] }); pools.get(k).list.push(r); }
  }
  for (const list of byBoat.values())
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length && list[j].start < list[i].end; j++)
        out.push({ type: 'boat', label: list[i].boat_name, a: list[i].title, b: list[j].title, when: list[j].start });
  for (const p of pools.values()) {
    const cap = q1("SELECT COUNT(*) c FROM boats WHERE lower(class)=? AND status NOT IN ('out_of_service','maintenance')", p.name.toLowerCase()).c;
    const ev = [];
    for (const r of p.list) ev.push([r.start, 1], [r.end, -1]);
    ev.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1]));
    let cur = 0;
    for (const [at, d] of ev) {
      cur += d;
      if (d === 1 && cur > cap) { out.push({ type: 'pool', label: p.name, a: `${cur} bookings at once`, b: `only ${cap} boat${cap === 1 ? '' : 's'} available`, when: at }); break; }
    }
  }
  return out.sort((x, y) => x.when.localeCompare(y.when)).slice(0, 10);
}

/* ---------- API handlers ---------- */
function latestConditions() { return q1('SELECT * FROM conditions ORDER BY recorded_at DESC LIMIT 1'); }

function dashboard() {
  const t = now();
  const onWater = q(`SELECT s.*, b.name AS boat_name, b.kind AS boat_kind FROM signouts s JOIN boats b ON b.id=s.boat_id
                     WHERE s.in_at IS NULL ORDER BY s.due_back`).map(s => ({ ...s, overdue: s.due_back < t }));
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const horizon = new Date(Date.now() + 36 * 3600e3).toISOString();
  const upcoming = q(`SELECT k.*, b.name AS boat_name, m.name AS member_name FROM bookings k
                      LEFT JOIN boats b ON b.id=k.boat_id LEFT JOIN members m ON m.id=k.member_id
                      WHERE k.status='confirmed' AND k.end > ? AND k.start < ? ORDER BY k.start LIMIT 30`, t, horizon);
  const soon = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const today = t.slice(0, 10);
  const expiring = [];
  for (const m of q('SELECT * FROM members ORDER BY name')) {
    for (const [field, label] of [['first_aid_expiry', 'First aid'], ['membership_expiry', 'Membership']]) {
      const d = m[field];
      if (d && d <= soon) expiring.push({ id: m.id, name: m.name, type: m.type, what: label, date: d, expired: d < today });
    }
  }
  expiring.sort((a, b) => a.date.localeCompare(b.date));
  const fleet = Object.fromEntries(q('SELECT status, COUNT(*) c FROM boats GROUP BY status').map(r => [r.status, r.c]));
  return {
    centre: CENTRE_NAME,
    conditions: latestConditions(),
    onWater,
    overdueCount: onWater.filter(s => s.overdue).length,
    peopleOnWater: onWater.reduce((n, s) => n + (s.crew || 1), 0),
    fleet,
    openDefects: q(`SELECT d.*, b.name AS boat_name FROM defects d JOIN boats b ON b.id=d.boat_id
                    WHERE d.resolved_at IS NULL ORDER BY CASE d.severity WHEN 'critical' THEN 0 WHEN 'major' THEN 1 ELSE 2 END LIMIT 20`),
    upcoming,
    expiring,
    clashes: findClashes(),
    incidents30: q1("SELECT COUNT(*) c FROM incidents WHERE occurred_at > ?", new Date(Date.now() - 30 * 864e5).toISOString()).c,
    openIncidents: q1("SELECT COUNT(*) c FROM incidents WHERE status!='closed'").c,
  };
}

function signOut(ctx) {
  const b = ctx.body;
  const boatId = Number(b.boat_id);
  const helm = (b.helm_name || '').trim();
  if (!boatId || !helm) throw new HttpError(400, 'Boat and helm name are required');
  const due = b.due_back;
  if (!due || Number.isNaN(Date.parse(due))) throw new HttpError(400, 'Expected return time is required');
  if (Date.parse(due) <= Date.now()) throw new HttpError(400, 'Expected return must be in the future');
  const crew = Math.max(1, Math.min(50, Number(b.crew) || 1));
  return tx(() => {
    const boat = q1('SELECT * FROM boats WHERE id=?', boatId);
    if (!boat) throw new HttpError(404, 'Boat not found');
    if (boat.status !== 'available') throw new HttpError(409, `${boat.name} is not available (${boat.status.replace(/_/g, ' ')})`);
    const cond = latestConditions();
    const redFlag = cond && cond.flag === 'red' && Date.now() - Date.parse(cond.recorded_at) < 6 * 3600e3;
    let reason = null;
    if (redFlag) {
      reason = (b.override_reason || '').trim();
      if (!reason) throw new HttpError(409, 'RED FLAG is flying. Launching is blocked unless a duty manager records an override reason.');
    }
    const member = b.member_id ? Number(b.member_id) : null;
    const r = run(`INSERT INTO signouts(boat_id,helm_name,member_id,crew,destination,out_at,due_back,notes,signed_out_by,override_reason)
                   VALUES (?,?,?,?,?,?,?,?,?,?)`, boatId, helm, member, crew, (b.destination || '').trim() || null, now(), due,
      (b.notes || '').trim() || null, ctx.user.username, reason);
    run("UPDATE boats SET status='on_water' WHERE id=?", boatId);
    audit(ctx.user, reason ? 'signout_red_flag_override' : 'signout', 'signouts', Number(r.lastInsertRowid));
    return { id: Number(r.lastInsertRowid) };
  });
}

function signIn(ctx) {
  return tx(() => {
    const s = q1('SELECT * FROM signouts WHERE id=?', ctx.params.id);
    if (!s) throw new HttpError(404, 'Sign-out not found');
    if (s.in_at) throw new HttpError(409, 'Already signed in');
    const note = (ctx.body.notes || '').trim();
    run('UPDATE signouts SET in_at=?, signed_in_by=?, notes=COALESCE(?, notes) WHERE id=?', now(), ctx.user.username, note || null, s.id);
    const boat = q1('SELECT * FROM boats WHERE id=?', s.boat_id);
    if (boat.status === 'on_water') run("UPDATE boats SET status='available' WHERE id=?", s.boat_id);
    if (ctx.body.defect) {
      run('INSERT INTO defects(boat_id,description,severity,reported_by,reported_at) VALUES (?,?,?,?,?)', s.boat_id,
        String(ctx.body.defect).trim().slice(0, 1000), 'minor', ctx.user.username, now());
    }
    audit(ctx.user, 'signin', 'signouts', s.id);
    return { ok: true };
  });
}

function createDefect(ctx) {
  const d = clean('defects', ctx.body, false);
  if (!q1('SELECT id FROM boats WHERE id=?', d.boat_id)) throw new HttpError(404, 'Boat not found');
  return tx(() => {
    const r = run('INSERT INTO defects(boat_id,description,severity,reported_by,reported_at) VALUES (?,?,?,?,?)',
      d.boat_id, d.description, d.severity || 'minor', ctx.user.username, now());
    if ((d.severity || 'minor') === 'critical') {
      run("UPDATE boats SET status='out_of_service' WHERE id=?", d.boat_id);
    }
    audit(ctx.user, 'defect_' + (d.severity || 'minor'), 'defects', Number(r.lastInsertRowid));
    return { id: Number(r.lastInsertRowid) };
  });
}

function resolveDefect(ctx) {
  return tx(() => {
    const d = q1('SELECT * FROM defects WHERE id=?', ctx.params.id);
    if (!d) throw new HttpError(404, 'Defect not found');
    if (d.resolved_at) throw new HttpError(409, 'Already resolved');
    run('UPDATE defects SET resolved_at=?, resolution=? WHERE id=?', now(), (ctx.body.resolution || '').trim() || 'Fixed', d.id);
    const boat = q1('SELECT * FROM boats WHERE id=?', d.boat_id);
    const crit = q1("SELECT COUNT(*) c FROM defects WHERE boat_id=? AND resolved_at IS NULL AND severity='critical'", d.boat_id).c;
    if (boat.status === 'out_of_service' && !crit) run("UPDATE boats SET status='available' WHERE id=?", d.boat_id);
    audit(ctx.user, 'defect_resolved', 'defects', d.id);
    return { ok: true };
  });
}

function genericCreate(name) {
  return ctx => {
    const row = clean(name, ctx.body, false);
    if (name === 'bookings') {
      const c = bookingConflict(row);
      if (c) throw new HttpError(409, `Boat already booked: "${c.title}" ${c.start} to ${c.end}`);
      if (row.end <= row.start) throw new HttpError(400, 'End must be after start');
    }
    if (name === 'conditions') { row.recorded_at = row.recorded_at || now(); row.recorded_by = ctx.user.username; }
    if (name === 'incidents') { row.occurred_at = row.occurred_at || now(); row.reported_by = ctx.user.username; }
    if (name === 'boats' && row.status === 'on_water') throw new HttpError(400, 'Use the safety board to put boats on the water');
    const hasCreated = ['boats', 'members', 'bookings'].includes(name);
    const keys = Object.keys(row);
    if (hasCreated) { keys.push('created_at'); row.created_at = now(); }
    const r = run(`INSERT INTO ${name}(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map(k => row[k]));
    audit(ctx.user, 'create', name, Number(r.lastInsertRowid));
    return { id: Number(r.lastInsertRowid) };
  };
}
function genericUpdate(name) {
  return ctx => {
    const existing = q1(`SELECT * FROM ${name} WHERE id=?`, ctx.params.id);
    if (!existing) throw new HttpError(404, 'Not found');
    if (name === 'bookings' && existing.source === 'external') throw new HttpError(409, 'This booking comes from the website feed. Change it on the website.');
    const row = clean(name, ctx.body, true);
    if (name === 'bookings') {
      const merged = { ...existing, ...row };
      const c = bookingConflict(merged, existing.id);
      if (c) throw new HttpError(409, `Boat already booked: "${c.title}" ${c.start} to ${c.end}`);
      if (merged.end <= merged.start) throw new HttpError(400, 'End must be after start');
    }
    if (name === 'boats' && row.status === 'on_water' && existing.status !== 'on_water') throw new HttpError(400, 'Use the safety board to put boats on the water');
    if (name === 'boats' && row.status && row.status !== 'out_of_service' && existing.status !== 'on_water') {
      const crit = q1("SELECT COUNT(*) c FROM defects WHERE boat_id=? AND resolved_at IS NULL AND severity='critical'", existing.id).c;
      if (crit) throw new HttpError(409, 'Boat has an unresolved critical defect; resolve it first');
    }
    const keys = Object.keys(row);
    if (!keys.length) throw new HttpError(400, 'Nothing to update');
    run(`UPDATE ${name} SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`, ...keys.map(k => row[k]), existing.id);
    audit(ctx.user, 'update', name, existing.id);
    return { ok: true };
  };
}
function genericDelete(name) {
  return ctx => {
    if (name === 'bookings' && q1("SELECT 1 x FROM bookings WHERE id=? AND source='external'", ctx.params.id))
      throw new HttpError(409, 'This booking comes from the website feed. Cancel or remove it on the website.');
    if (name === 'boats' && q1('SELECT COUNT(*) c FROM signouts WHERE boat_id=?', ctx.params.id).c)
      throw new HttpError(409, 'Boat has sign-out history. Set it to "maintenance" instead of deleting.');
    const r = run(`DELETE FROM ${name} WHERE id=?`, ctx.params.id);
    if (!r.changes) throw new HttpError(404, 'Not found');
    audit(ctx.user, 'delete', name, Number(ctx.params.id));
    return { ok: true };
  };
}

/* ---------- routing ---------- */
const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, ...opts });
}

route('GET', '/api/health', () => ({ ok: true }), { auth: false });
route('GET', '/api/config', () => ({ centre: CENTRE_NAME, enums: ENUM }), { auth: false });
route('GET', '/api/dashboard', () => dashboard());
route('GET', '/api/me', ctx => ({ username: ctx.user.username, name: ctx.user.name, role: ctx.user.role }));

for (const name of Object.keys(LIST_SQL)) route('GET', `/api/${name}`, () => q(LIST_SQL[name]));
for (const name of Object.keys(RES)) {
  if (name === 'defects') continue;
  route('POST', `/api/${name}`, genericCreate(name));
  if (!RES[name].noUpdate) route('PUT', `/api/${name}/:id`, genericUpdate(name));
  route('DELETE', `/api/${name}/:id`, genericDelete(name), { admin: true });
}
route('POST', '/api/defects', createDefect);
route('POST', '/api/defects/:id/resolve', resolveDefect);
route('DELETE', '/api/defects/:id', genericDelete('defects'), { admin: true });
route('POST', '/api/signouts', signOut);
route('POST', '/api/signouts/:id/signin', signIn);

route('GET', '/api/external/status', () => externalStatus());
route('POST', '/api/external/sync', async () => {
  if (!EXT_URL) throw new HttpError(400, 'No website feed is configured');
  if (Date.now() - lastManualSync > 5000) { lastManualSync = Date.now(); await syncExternal(); }
  return externalStatus();
});
// Link a website item name to one specific boat ("b:<id>"), to any boat of a class ("c:<class>"), or unlink ("").
route('POST', '/api/external/map', ctx => {
  const item = String(ctx.body.item || '').trim();
  const target = String(ctx.body.target || '');
  if (!item) throw new HttpError(400, 'Item is required');
  const key = item.toLowerCase();
  tx(() => {
    if (!target) run('DELETE FROM item_map WHERE item_key=?', key);
    else {
      let boatId = null, boatClass = null;
      if (target.startsWith('b:')) {
        boatId = Number(target.slice(2));
        if (!q1('SELECT id FROM boats WHERE id=?', boatId)) throw new HttpError(404, 'Boat not found');
      } else if (target.startsWith('c:')) {
        const hit = q1('SELECT class FROM boats WHERE lower(class)=? LIMIT 1', target.slice(2).toLowerCase());
        if (!hit) throw new HttpError(404, 'No boats of that class');
        boatClass = hit.class;
      } else throw new HttpError(400, 'Invalid target');
      run(`INSERT INTO item_map(item_key,item_label,boat_id,boat_class) VALUES (?,?,?,?)
           ON CONFLICT(item_key) DO UPDATE SET item_label=excluded.item_label, boat_id=excluded.boat_id, boat_class=excluded.boat_class`,
        key, item, boatId, boatClass);
    }
    const t = resolveTarget(item);
    run("UPDATE bookings SET boat_id=?, boat_class=? WHERE source='external' AND lower(external_item)=?", t.boat_id, t.boat_class, key);
    audit(ctx.user, 'map_item', 'item_map', null);
  });
  return externalStatus();
}, { admin: true });

route('GET', '/api/audit', () => q('SELECT * FROM audit ORDER BY id DESC LIMIT 200'), { admin: true });
route('GET', '/api/users', () => q('SELECT id,username,name,role,created_at FROM users ORDER BY username'), { admin: true });
route('POST', '/api/users', ctx => {
  const { username, name, role, password } = ctx.body;
  if (!username || !/^[a-z0-9._-]{3,32}$/i.test(username)) throw new HttpError(400, 'Username must be 3-32 letters, numbers, . _ -');
  if (!name) throw new HttpError(400, 'Name is required');
  if (!password || password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (!['admin', 'staff'].includes(role || 'staff')) throw new HttpError(400, 'Invalid role');
  if (q1('SELECT id FROM users WHERE username=?', username.toLowerCase())) throw new HttpError(409, 'Username already taken');
  const r = run('INSERT INTO users(username,name,role,pass_hash,created_at) VALUES (?,?,?,?,?)',
    username.toLowerCase(), name.trim(), role || 'staff', hashPassword(password), now());
  audit(ctx.user, 'create', 'users', Number(r.lastInsertRowid));
  return { id: Number(r.lastInsertRowid) };
}, { admin: true });
route('DELETE', '/api/users/:id', ctx => {
  if (Number(ctx.params.id) === ctx.user.id) throw new HttpError(400, 'You cannot delete yourself');
  run('DELETE FROM users WHERE id=?', ctx.params.id);
  audit(ctx.user, 'delete', 'users', Number(ctx.params.id));
  return { ok: true };
}, { admin: true });
route('POST', '/api/password', ctx => {
  const { current, next } = ctx.body;
  const u = q1('SELECT * FROM users WHERE id=?', ctx.user.id);
  if (!current || !checkPassword(current, u.pass_hash)) throw new HttpError(403, 'Current password is incorrect');
  if (!next || next.length < 8) throw new HttpError(400, 'New password must be at least 8 characters');
  run('UPDATE users SET pass_hash=? WHERE id=?', hashPassword(next), u.id);
  run('DELETE FROM sessions WHERE user_id=? AND token!=?', u.id, ctx.token);
  return { ok: true };
});

// Plain-text/CSV style export for the incident book and sign-out register.
route('GET', '/api/export/:what', ctx => {
  const w = ctx.params.what;
  if (!['signouts', 'incidents', 'members', 'boats'].includes(w)) throw new HttpError(404, 'Unknown export');
  const rows = w === 'signouts' ? q('SELECT s.*, b.name AS boat_name FROM signouts s JOIN boats b ON b.id=s.boat_id ORDER BY s.out_at DESC')
    : q(`SELECT * FROM ${w}`);
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const esc = v => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  return { __csv: [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n'), name: `saildeck-${w}.csv` };
}, { admin: true });

// Consistent online backup of the whole database (safe while the app is running).
route('GET', '/api/backup', () => {
  const tmp = path.join(DATA_DIR, `backup-${Date.now()}.tmp`);
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  const buf = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);
  return { __file: buf, name: `saildeck-backup-${new Date().toISOString().slice(0, 10)}.db` };
}, { admin: true });

/* ---------- auth / sessions ---------- */
const attempts = new Map();
function rateLimited(ip) {
  const t = Date.now();
  const list = (attempts.get(ip) || []).filter(x => t - x < 5 * 60e3);
  attempts.set(ip, list);
  return list.length >= 10;
}
function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}
function sessionUser(req) {
  const token = parseCookies(req).sd_session;
  if (!token) return null;
  const row = q1(`SELECT u.*, s.token, s.expires FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?`, token);
  if (!row || row.expires < now()) return null;
  return row;
}
const cookieAttrs = req => `Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}` + (req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '');

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 1e6) { reject(new HttpError(413, 'Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Not found');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);

    const ip = req.socket.remoteAddress;
    // CSRF defence in depth: state-changing requests must come from the same origin.
    if (req.method !== 'GET' && req.headers.origin) {
      let o; try { o = new URL(req.headers.origin).host; } catch { o = ''; }
      if (o !== req.headers.host) throw new HttpError(403, 'Cross-origin request blocked');
    }

    if (url.pathname === '/api/login' && req.method === 'POST') {
      if (rateLimited(ip)) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
      const { username, password } = await readBody(req);
      const u = username ? q1('SELECT * FROM users WHERE username=?', String(username).toLowerCase()) : null;
      if (!u || !checkPassword(String(password || ''), u.pass_hash)) {
        attempts.get(ip).push(Date.now());
        throw new HttpError(401, 'Wrong username or password');
      }
      const token = crypto.randomBytes(32).toString('hex');
      run('DELETE FROM sessions WHERE expires < ?', now());
      run('INSERT INTO sessions(token,user_id,expires) VALUES (?,?,?)', token, u.id, new Date(Date.now() + SESSION_HOURS * 3600e3).toISOString());
      return send(res, 200, { username: u.username, name: u.name, role: u.role }, { 'Set-Cookie': `sd_session=${token}; ${cookieAttrs(req)}` });
    }
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      const t = parseCookies(req).sd_session;
      if (t) run('DELETE FROM sessions WHERE token=?', t);
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'sd_session=; Path=/; HttpOnly; Max-Age=0' });
    }

    let match = null, params = {};
    let pathMatched = false;
    for (const r of routes) {
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== req.method) continue;
      match = r; r.keys.forEach((k, i) => params[k] = decodeURIComponent(m[i + 1])); break;
    }
    if (!match) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'Method not allowed' : 'Not found');

    const user = sessionUser(req);
    if (match.auth !== false && !user) throw new HttpError(401, 'Please sign in');
    if (match.admin && user.role !== 'admin') throw new HttpError(403, 'Admin only');
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
    const result = await match.handler({ req, res, user, token: user && user.token, params, body, query: url.searchParams });
    if (result && result.__csv !== undefined)
      return send(res, 200, result.__csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${result.name}"` });
    if (result && result.__file)
      return send(res, 200, result.__file, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${result.name}"` });
    send(res, 200, result);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`SailDeck listening on :${PORT} (data in ${DATA_DIR})`));
if (EXT_URL) {
  const report = () => console.log(ext.ok ? `Website feed OK: ${ext.total} in feed, ${ext.imported} new, ${ext.updated} changed, ${ext.cancelled} cancelled, ${ext.skipped} skipped` : `Website feed FAILED: ${ext.error}`);
  syncExternal().then(report);
  setInterval(() => syncExternal().then(() => { if (!ext.ok) report(); }), EXT_MINUTES * 60e3);
  console.log(`Website feed enabled: ${EXT_HOST}, every ${EXT_MINUTES} min`);
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(); try { db.close(); } catch {} process.exit(0); });
