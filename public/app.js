'use strict';
/* SailDeck front end: vanilla JS, no build step. */
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const label = s => String(s ?? '').replace(/_/g, ' ');
const fmtDT = iso => iso ? new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const fmtTime = iso => iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
const fmtDate = d => d ? new Date(d.length === 10 ? d + 'T00:00:00' : d).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const toLocalInput = v => { const d = new Date(v); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const CLS = {
  available: 'green', on_water: 'blue', out_of_service: 'red', maintenance: 'yellow',
  confirmed: 'blue', cancelled: '', completed: 'green',
  minor: '', major: 'yellow', critical: 'red', near_miss: 'blue', serious: 'red',
  open: 'yellow', investigating: 'blue', closed: 'green', green: 'green', yellow: 'yellow', red: 'red',
};
const chip = (v, cls) => `<span class="chip ${cls ?? CLS[v] ?? ''}">${esc(label(v))}</span>`;

const state = { me: null, cfg: null, view: 'board', cache: {}, timer: null };

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  let data = null; try { data = await res.json(); } catch { /* not json */ }
  if (res.status === 401 && url !== '/api/login') { showLogin(); throw new Error('Please sign in'); }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}
let toastTimer;
function toast(msg, bad) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.className = 'toast', 3500);
}
const act = async (fn, okMsg) => { try { await fn(); if (okMsg) toast(okMsg); await render(); } catch (e) { toast(e.message, true); } };

/* ---------- dialog / form builder ---------- */
function fieldHTML(f, val) {
  const v = val ?? f.default ?? '';
  const name = esc(f.name), req = f.required ? ' required' : '';
  let input;
  if (f.type === 'textarea') input = `<textarea name="${name}"${req}>${esc(v)}</textarea>`;
  else if (f.type === 'select') {
    input = `<select name="${name}"${req}>${(f.options || []).map(o => {
      const [ov, ol] = Array.isArray(o) ? o : [o, label(o)];
      return `<option value="${esc(ov)}"${String(ov) === String(v) ? ' selected' : ''}>${esc(ol)}</option>`;
    }).join('')}</select>`;
  } else if (f.type === 'datetime') input = `<input type="datetime-local" name="${name}" value="${esc(v ? toLocalInput(v) : '')}"${req}>`;
  else if (f.type === 'date') input = `<input type="date" name="${name}" value="${esc(v)}"${req}>`;
  else if (f.type === 'number') input = `<input type="number" name="${name}" value="${esc(v)}" step="${f.step || 1}" min="${f.min ?? ''}" max="${f.max ?? ''}"${req}>`;
  else input = `<input type="${f.type === 'email' ? 'email' : f.type === 'tel' ? 'tel' : 'text'}" name="${name}" value="${esc(v)}"${f.list ? ` list="dl-${name}"` : ''}${req}>`
    + (f.list ? `<datalist id="dl-${name}">${f.list.map(x => `<option value="${esc(x)}">`).join('')}</datalist>` : '');
  return `<label${f.full ? ' class="full"' : ''}>${esc(f.label)}${input}</label>`;
}
function openForm({ title, fields, values = {}, submit = 'Save', notice, onSubmit }) {
  const dlg = $('#dlg'), form = $('#dlg-form');
  form.innerHTML = `<h2>${esc(title)}</h2>${notice ? `<div class="warn-box">${esc(notice)}</div>` : ''}
    <div class="form-grid">${fields.map(f => fieldHTML(f, values[f.name])).join('')}</div>
    <p class="error" id="dlg-error" role="alert"></p>
    <div class="dlg-actions"><button type="button" class="btn" id="dlg-cancel">Cancel</button><button class="btn primary" type="submit">${esc(submit)}</button></div>`;
  $('#dlg-cancel').onclick = () => dlg.close();
  form.onsubmit = async e => {
    e.preventDefault();
    const vals = {};
    for (const f of fields) {
      const el = form.elements[f.name]; if (!el) continue;
      let v = el.value;
      if (f.type === 'datetime') v = v ? new Date(v).toISOString() : null;
      else if (f.type === 'number' || f.num) v = v === '' ? null : Number(v);
      vals[f.name] = v;
    }
    const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
    try { await onSubmit(vals); dlg.close(); } catch (err) { $('#dlg-error').textContent = err.message; btn.disabled = false; }
  };
  dlg.showModal();
  const first = form.querySelector('input,select,textarea'); if (first) first.focus();
}
const confirmBox = (title, text, onYes, yes = 'Confirm') =>
  openForm({ title, fields: [], notice: text, submit: yes, onSubmit: onYes });

/* ---------- auth ---------- */
function showLogin() {
  $('#app').hidden = true; $('#login').hidden = false; clearInterval(state.timer);
  $('#login-centre').textContent = state.cfg ? state.cfg.centre : '';
}
async function showApp() {
  $('#login').hidden = true; $('#app').hidden = false;
  $('#centre-name').textContent = state.cfg.centre;
  $('#who').textContent = `${state.me.name} (${state.me.role})`;
  document.title = `${state.cfg.centre} · SailDeck`;
  clearInterval(state.timer); state.timer = setInterval(tick, 1000);
  await render();
}
$('#login-form').onsubmit = async e => {
  e.preventDefault();
  const f = e.target; $('#login-error').textContent = '';
  try {
    state.me = await api('POST', '/api/login', { username: f.elements.username.value, password: f.elements.password.value });
    f.elements.password.value = ''; await showApp();
  } catch (err) { $('#login-error').textContent = err.message; }
};
$('#logout').onclick = async () => { try { await api('POST', '/api/logout'); } catch { /* ignore */ } state.me = null; showLogin(); };

/* ---------- ticker: clock, countdowns, auto refresh ---------- */
let sinceRefresh = 0;
function countdownText(due) {
  const ms = Date.parse(due) - Date.now(), a = Math.abs(ms), m = Math.floor(a / 60000), s = Math.floor(a / 1000) % 60;
  const body = m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}:${String(s).padStart(2, '0')}`;
  return ms < 0 ? `${body} overdue` : `${body} left`;
}
function tick() {
  $('#clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  document.querySelectorAll('.countdown[data-due]').forEach(el => {
    const ms = Date.parse(el.dataset.due) - Date.now();
    el.textContent = countdownText(el.dataset.due);
    el.classList.toggle('over', ms < 0);
    const item = el.closest('.water-item');
    if (item) { item.classList.toggle('overdue', ms < 0); item.classList.toggle('soon', ms >= 0 && ms < 15 * 60000); }
  });
  if (state.view === 'board' && !$('#dlg').open && ++sinceRefresh >= 30) { sinceRefresh = 0; render(); }
}

/* ---------- router ---------- */
const views = {};
async function render() {
  const v = (location.hash.slice(1) || 'board').split('?')[0];
  state.view = views[v] ? v : 'board';
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.dataset.view === state.view));
  sinceRefresh = 0;
  const main = $('#main');
  try { main.innerHTML = await views[state.view](); } catch (e) { if (e.message !== 'Please sign in') main.innerHTML = `<div class="card"><p class="error">${esc(e.message)}</p></div>`; return; }
  tick();
}
window.addEventListener('hashchange', () => { if (state.me) { render(); window.scrollTo(0, 0); } });
$('#main').addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const fn = actions[b.dataset.act]; if (fn) fn(b.dataset, b);
});
$('#main').addEventListener('input', e => {
  if (e.target.id === 'people-search') {
    const t = e.target.value.toLowerCase();
    document.querySelectorAll('#people-table tbody tr').forEach(tr => tr.hidden = !tr.textContent.toLowerCase().includes(t));
  }
});
$('#main').addEventListener('change', e => { if (e.target.id === 'show-past') { state.showPast = e.target.checked; render(); } });
$('#main').addEventListener('submit', async e => {
  if (e.target.id === 'cond-form') {
    e.preventDefault();
    const f = e.target.elements, n = x => f[x].value === '' ? null : Number(f[x].value);
    await act(() => api('POST', '/api/conditions', { flag: f.flag.value, wind_kts: n('wind_kts'), gust_kts: n('gust_kts'), wind_dir: f.wind_dir.value, tide: f.tide.value, notes: f.notes.value }), 'Conditions logged');
  }
  if (e.target.id === 'pw-form') {
    e.preventDefault();
    const f = e.target;
    try { await api('POST', '/api/password', { current: f.elements.current.value, next: f.elements.next.value }); f.reset(); toast('Password changed'); } catch (err) { toast(err.message, true); }
  }
});

/* ---------- data helpers ---------- */
const boatOptions = (boats, blank) => (blank ? [['', blank]] : []).concat(boats.map(b => [b.id, `${b.name}${b.class ? ' – ' + b.class : ''}`]));
const memberOptions = (ms, blank) => [['', blank]].concat(ms.map(m => [m.id, m.name]));
const tableOrEmpty = (rows, head, msg) => rows.length
  ? `<div class="table-wrap"><table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
  : `<p class="empty">${esc(msg)}</p>`;
function expiryChip(d) {
  if (!d) return '<span class="muted">—</span>';
  const days = Math.floor((new Date(d + 'T00:00:00') - new Date().setHours(0, 0, 0, 0)) / 864e5);
  return `<span class="chip ${days < 0 ? 'red' : days <= 30 ? 'yellow' : 'green'}">${esc(days < 0 ? 'Expired ' + fmtDate(d) : fmtDate(d))}</span>`;
}

/* ---------- views ---------- */
views.board = async () => {
  const d = await api('GET', '/api/dashboard');
  state.cache.dash = d;
  const c = d.conditions;
  const age = c ? Date.now() - Date.parse(c.recorded_at) : null;
  const flagMsg = { green: 'Green flag – good to launch', yellow: 'Yellow flag – caution, check conditions', red: 'RED FLAG – no launching' };
  const stale = age != null && age > 3 * 3600e3;
  const wind = c ? [c.wind_kts != null ? `${c.wind_kts} kt` : null, c.gust_kts != null ? `gusting ${c.gust_kts}` : null, c.wind_dir, c.tide].filter(Boolean).join(' · ') : '';
  const flagBanner = c
    ? `<div class="flag ${esc(c.flag)}"><span class="pennant"></span><div><h2>${esc(flagMsg[c.flag])}</h2><p>${esc(wind)}${wind ? ' · ' : ''}logged ${esc(fmtTime(c.recorded_at))} by ${esc(c.recorded_by)}${stale ? ' – reading is over 3h old, please update' : ''}</p></div><a class="btn" href="#log">Update</a></div>`
    : `<div class="flag none"><span class="pennant"></span><div><h2>No conditions logged yet</h2><p>Record the flag and wind before launching boats.</p></div><a class="btn" href="#log">Log conditions</a></div>`;
  const stat = (n, t, alert) => `<div class="card stat${alert ? ' alert' : ''}"><b>${n}</b><span>${t}</span></div>`;
  const f = d.fleet;
  const water = d.onWater.length ? `<div class="water-list">${d.onWater.map(s => `
    <div class="water-item${s.overdue ? ' overdue' : ''}">
      <div><span class="boat">${esc(s.boat_name)}</span> ${chip(s.boat_kind, 'blue')}
        <div>${esc(s.helm_name)} · ${s.crew} aboard${s.destination ? ' · ' + esc(s.destination) : ''}</div>
        <div class="muted small">Out ${esc(fmtTime(s.out_at))} · due back ${esc(fmtTime(s.due_back))}${s.override_reason ? ' · <b>red-flag override</b>' : ''}</div></div>
      <div><div class="countdown" data-due="${esc(s.due_back)}"></div><div class="right"><button class="btn small primary" data-act="signin" data-id="${s.id}">Sign in</button></div></div>
    </div>`).join('')}</div>` : '<p class="empty">Nothing on the water.</p>';
  return `
  <div class="page-head"><h1>Safety board</h1><button class="btn primary" data-act="signout">+ Sign out a boat</button></div>
  <div class="grid" style="gap:1rem">
    ${flagBanner}
    <div class="grid cols-4">
      ${stat(d.onWater.length, 'Boats afloat')}${stat(d.peopleOnWater, 'People afloat')}
      ${stat(d.overdueCount, 'Overdue', d.overdueCount > 0)}${stat(f.available || 0, 'Boats ready')}
      ${stat((f.out_of_service || 0) + (f.maintenance || 0), 'Unavailable')}${stat(d.openDefects.length, 'Open defects')}
    </div>
    <div class="card"><div class="card-head"><h2>On the water</h2><span class="muted small">Auto-refreshes every 30s</span></div>${water}</div>
    <div class="grid cols-2">
      <div class="card"><h2>Coming up (next 36h)</h2>${d.upcoming.length ? `<ul class="list">${d.upcoming.map(k => `<li><span><b>${esc(k.title)}</b><br><span class="muted small">${esc(k.boat_name || 'No boat')}${k.member_name ? ' · ' + esc(k.member_name) : ''}</span></span><span class="small right">${esc(fmtDT(k.start))}<br>${chip(k.kind, 'blue')}</span></li>`).join('')}</ul>` : '<p class="empty">No bookings in the next 36 hours.</p>'}</div>
      <div class="card"><h2>Open defects</h2>${d.openDefects.length ? `<ul class="list">${d.openDefects.map(x => `<li><span><b>${esc(x.boat_name)}</b> – ${esc(x.description)}</span>${chip(x.severity)}</li>`).join('')}</ul>` : '<p class="empty">No open defects.</p>'}</div>
      <div class="card"><h2>Tickets &amp; memberships due (30 days)</h2>${d.expiring.length ? `<ul class="list">${d.expiring.map(x => `<li><span><b>${esc(x.name)}</b> <span class="muted small">${esc(x.what)}</span></span>${expiryChip(x.date)}</li>`).join('')}</ul>` : '<p class="empty">Nothing expiring soon.</p>'}</div>
      <div class="card"><h2>Incidents</h2><p><b>${d.incidents30}</b> logged in the last 30 days · <b>${d.openIncidents}</b> not yet closed. <a href="#incidents">Open incident book</a></p></div>
    </div>
  </div>`;
};

async function openSignOut() {
  const [boats, members, d] = await Promise.all([api('GET', '/api/boats'), api('GET', '/api/members'), api('GET', '/api/dashboard')]);
  const avail = boats.filter(b => b.status === 'available');
  if (!avail.length) return toast('No boats are available to sign out', true);
  const c = d.conditions, red = c && c.flag === 'red' && Date.now() - Date.parse(c.recorded_at) < 6 * 3600e3;
  const fields = [
    { name: 'boat_id', label: 'Boat', type: 'select', options: boatOptions(avail), num: true, required: true, full: true },
    { name: 'helm_name', label: 'Helm / skipper', type: 'text', list: members.map(m => m.name), required: true },
    { name: 'crew', label: 'People aboard', type: 'number', default: 1, min: 1, max: 50, required: true },
    { name: 'destination', label: 'Where to / activity', type: 'text', full: true },
    { name: 'due_back', label: 'Expected back', type: 'datetime', default: new Date(Date.now() + 2 * 3600e3).toISOString(), required: true, full: true },
  ];
  if (red) fields.push({ name: 'override_reason', label: 'Duty manager override reason (required)', type: 'textarea', required: true, full: true });
  openForm({
    title: 'Sign out a boat', fields, submit: 'Sign out',
    notice: red ? 'RED FLAG is flying. Launching is blocked unless the duty manager records a reason. The override is saved in the audit log.' : null,
    onSubmit: async v => { await api('POST', '/api/signouts', v); toast('Signed out'); await render(); },
  });
}
const actions = {
  signout: () => openSignOut().catch(e => toast(e.message, true)),
  signin: ({ id }) => openForm({
    title: 'Sign boat in', submit: 'Sign in',
    fields: [{ name: 'defect', label: 'Any damage or defect to report? (leave blank if none)', type: 'textarea', full: true }, { name: 'notes', label: 'Notes', type: 'text', full: true }],
    onSubmit: async v => { await api('POST', `/api/signouts/${id}/signin`, v); toast('Signed in'); await render(); },
  }),

  /* fleet */
  addBoat: () => boatForm(),
  editBoat: ({ id }) => boatForm(state.cache.boats.find(b => b.id == id)),
  delBoat: ({ id }) => confirmBox('Delete boat?', 'This also deletes its defects and bookings links. Boats with sign-out history cannot be deleted.', async () => { await api('DELETE', `/api/boats/${id}`); await render(); }, 'Delete'),
  addDefect: ({ boat }) => defectForm(boat),
  resolveDefect: ({ id }) => openForm({ title: 'Resolve defect', submit: 'Mark resolved', fields: [{ name: 'resolution', label: 'What was done?', type: 'textarea', full: true }], onSubmit: async v => { await api('POST', `/api/defects/${id}/resolve`, v); toast('Defect resolved'); await render(); } }),

  /* bookings */
  addBooking: () => bookingForm(),
  editBooking: ({ id }) => bookingForm(state.cache.bookings.find(b => b.id == id)),
  cancelBooking: ({ id }) => confirmBox('Cancel booking?', 'The boat will be freed up for that time slot.', async () => { await api('PUT', `/api/bookings/${id}`, { status: 'cancelled' }); await render(); }, 'Cancel booking'),
  delBooking: ({ id }) => confirmBox('Delete booking?', 'This cannot be undone.', async () => { await api('DELETE', `/api/bookings/${id}`); await render(); }, 'Delete'),

  /* people */
  addMember: () => memberForm(),
  editMember: ({ id }) => memberForm(state.cache.members.find(m => m.id == id)),
  delMember: ({ id }) => confirmBox('Delete person?', 'Their sign-out history is kept but unlinked.', async () => { await api('DELETE', `/api/members/${id}`); await render(); }, 'Delete'),

  /* incidents */
  addIncident: () => incidentForm(),
  editIncident: ({ id }) => incidentForm(state.cache.incidents.find(i => i.id == id)),
  delIncident: ({ id }) => confirmBox('Delete incident?', 'Incident records are normally kept. Delete only if created in error.', async () => { await api('DELETE', `/api/incidents/${id}`); await render(); }, 'Delete'),

  /* admin */
  addUser: () => openForm({
    title: 'New user', submit: 'Create user',
    fields: [{ name: 'username', label: 'Username', type: 'text', required: true }, { name: 'name', label: 'Full name', type: 'text', required: true },
      { name: 'role', label: 'Role', type: 'select', options: [['staff', 'Staff'], ['admin', 'Admin']] },
      { name: 'password', label: 'Temporary password (8+ chars)', type: 'text', required: true }],
    onSubmit: async v => { await api('POST', '/api/users', v); toast('User created'); await render(); },
  }),
  delUser: ({ id }) => confirmBox('Delete user?', 'They will be signed out immediately.', async () => { await api('DELETE', `/api/users/${id}`); await render(); }, 'Delete'),
};

function boatForm(b) {
  const onWater = b && b.status === 'on_water';
  const fields = [
    { name: 'name', label: 'Name', type: 'text', required: true },
    { name: 'kind', label: 'Type', type: 'select', options: state.cfg.enums['boats.kind'] },
    { name: 'class', label: 'Class / model', type: 'text' }, { name: 'sail_no', label: 'Sail / hull number', type: 'text' },
  ];
  if (!onWater) fields.push({ name: 'status', label: 'Status', type: 'select', options: [['available', 'Available'], ['maintenance', 'In maintenance'], ['out_of_service', 'Out of service']] });
  fields.push({ name: 'notes', label: 'Notes', type: 'textarea', full: true });
  openForm({ title: b ? 'Edit boat' : 'Add boat', fields, values: b || {}, onSubmit: async v => { await api(b ? 'PUT' : 'POST', `/api/boats${b ? '/' + b.id : ''}`, v); toast('Saved'); await render(); } });
}
function defectForm(boatId) {
  openForm({
    title: 'Report defect', submit: 'Report',
    notice: 'Critical defects take the boat out of service immediately (hull damage, broken rigging under load, steering or engine failure, safety kit missing).',
    fields: [{ name: 'boat_id', label: 'Boat', type: 'select', options: boatOptions(state.cache.boats), num: true, default: boatId, required: true, full: true },
      { name: 'severity', label: 'Severity', type: 'select', options: [['minor', 'Minor – cosmetic / still safe'], ['major', 'Major – repair soon'], ['critical', 'Critical – unsafe, take out of service']] },
      { name: 'description', label: 'What is wrong?', type: 'textarea', required: true, full: true }],
    onSubmit: async v => { await api('POST', '/api/defects', v); toast('Defect reported'); await render(); },
  });
}
function bookingForm(b) {
  const start = b ? b.start : new Date(Math.ceil(Date.now() / 36e5) * 36e5).toISOString();
  openForm({
    title: b ? 'Edit booking' : 'New booking', values: b || {},
    fields: [
      { name: 'title', label: 'Title (e.g. "Hire – Smith family", "Stage 2 course")', type: 'text', required: true, full: true },
      { name: 'kind', label: 'Type', type: 'select', options: state.cfg.enums['bookings.kind'] },
      { name: 'boat_id', label: 'Boat', type: 'select', num: true, options: boatOptions(state.cache.boats, '— no boat —') },
      { name: 'member_id', label: 'Person', type: 'select', num: true, options: memberOptions(state.cache.members, '— none —') },
      { name: 'start', label: 'Start', type: 'datetime', default: start, required: true },
      { name: 'end', label: 'End', type: 'datetime', default: new Date(Date.parse(start) + 2 * 36e5).toISOString(), required: true },
      { name: 'notes', label: 'Notes', type: 'textarea', full: true }],
    onSubmit: async v => { await api(b ? 'PUT' : 'POST', `/api/bookings${b ? '/' + b.id : ''}`, v); toast('Saved'); await render(); },
  });
}
function memberForm(m) {
  openForm({
    title: m ? 'Edit person' : 'Add person', values: m || {},
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true }, { name: 'type', label: 'Type', type: 'select', options: state.cfg.enums['members.type'] },
      { name: 'email', label: 'Email', type: 'email' }, { name: 'phone', label: 'Phone', type: 'tel' },
      { name: 'emergency_contact', label: 'Emergency contact', type: 'text', full: true },
      { name: 'qualifications', label: 'Qualifications (e.g. RYA Dinghy Instructor; Powerboat L2)', type: 'text', full: true },
      { name: 'first_aid_expiry', label: 'First aid expires', type: 'date' }, { name: 'membership_expiry', label: 'Membership expires', type: 'date' },
      { name: 'notes', label: 'Notes (medical, access needs…)', type: 'textarea', full: true }],
    onSubmit: async v => { await api(m ? 'PUT' : 'POST', `/api/members${m ? '/' + m.id : ''}`, v); toast('Saved'); await render(); },
  });
}
function incidentForm(i) {
  openForm({
    title: i ? 'Edit incident' : 'Log incident', values: i || {},
    fields: [
      { name: 'occurred_at', label: 'When', type: 'datetime', default: new Date().toISOString(), required: true },
      { name: 'severity', label: 'Severity', type: 'select', options: [['near_miss', 'Near miss'], ['minor', 'Minor'], ['serious', 'Serious'], ['critical', 'Critical']] },
      { name: 'type', label: 'Type (capsize, collision, injury, gear failure…)', type: 'text' },
      { name: 'boat_id', label: 'Boat involved', type: 'select', num: true, options: boatOptions(state.cache.boats, '— none —') },
      { name: 'description', label: 'What happened?', type: 'textarea', required: true, full: true },
      { name: 'injuries', label: 'Injuries / treatment', type: 'textarea', full: true },
      { name: 'action_taken', label: 'Action taken / follow-up', type: 'textarea', full: true },
      { name: 'status', label: 'Status', type: 'select', options: [['open', 'Open'], ['investigating', 'Investigating'], ['closed', 'Closed']] }],
    onSubmit: async v => { await api(i ? 'PUT' : 'POST', `/api/incidents${i ? '/' + i.id : ''}`, v); toast('Saved'); await render(); },
  });
}

views.fleet = async () => {
  const [boats, defects] = await Promise.all([api('GET', '/api/boats'), api('GET', '/api/defects')]);
  state.cache.boats = boats;
  const admin = state.me.role === 'admin';
  const rows = boats.map(b => `<tr><td><b>${esc(b.name)}</b>${b.notes ? `<br><span class="muted small">${esc(b.notes)}</span>` : ''}</td><td>${esc(label(b.kind))}</td><td>${esc(b.class || '')}${b.sail_no ? ' #' + esc(b.sail_no) : ''}</td><td>${chip(b.status)}</td><td>${b.open_defects ? chip(b.open_defects + ' open', 'yellow') : '<span class="muted">—</span>'}</td>
    <td class="actions"><button class="btn small" data-act="addDefect" data-boat="${b.id}">Report defect</button> <button class="btn small" data-act="editBoat" data-id="${b.id}">Edit</button>${admin ? ` <button class="btn small danger" data-act="delBoat" data-id="${b.id}">Delete</button>` : ''}</td></tr>`);
  const open = defects.filter(d => !d.resolved_at), done = defects.filter(d => d.resolved_at).slice(0, 15);
  const drow = (d, resolved) => `<tr><td><b>${esc(d.boat_name)}</b></td><td>${esc(d.description)}${resolved ? `<br><span class="muted small">Fixed: ${esc(d.resolution || '')}</span>` : ''}</td><td>${chip(d.severity)}</td><td class="small">${esc(fmtDT(d.reported_at))}<br><span class="muted">${esc(d.reported_by || '')}</span></td><td class="actions">${resolved ? '' : `<button class="btn small" data-act="resolveDefect" data-id="${d.id}">Resolve</button>`}</td></tr>`;
  return `<div class="page-head"><h1>Fleet</h1><button class="btn primary" data-act="addBoat">+ Add boat</button></div>
  <div class="grid"><div class="card">${tableOrEmpty(rows, ['Boat', 'Type', 'Class', 'Status', 'Defects', ''], 'No boats yet. Add your first boat.')}</div>
  <div class="card"><h2>Open defects</h2>${tableOrEmpty(open.map(d => drow(d)), ['Boat', 'Defect', 'Severity', 'Reported', ''], 'No open defects. 🎉')}</div>
  ${done.length ? `<div class="card"><h2>Recently resolved</h2>${tableOrEmpty(done.map(d => drow(d, true)), ['Boat', 'Defect', 'Severity', 'Reported', ''], '')}</div>` : ''}</div>`;
};

views.bookings = async () => {
  const [bookings, boats, members] = await Promise.all([api('GET', '/api/bookings'), api('GET', '/api/boats'), api('GET', '/api/members')]);
  Object.assign(state.cache, { bookings, boats, members });
  const nowIso = new Date().toISOString();
  const shown = bookings.filter(b => state.showPast || b.end >= nowIso).sort((a, b) => state.showPast ? b.start.localeCompare(a.start) : a.start.localeCompare(b.start));
  const admin = state.me.role === 'admin';
  const rows = shown.map(b => `<tr><td class="small"><b>${esc(fmtDT(b.start))}</b><br>to ${esc(fmtTime(b.end))}</td><td><b>${esc(b.title)}</b>${b.notes ? `<br><span class="muted small">${esc(b.notes)}</span>` : ''}</td><td>${esc(b.boat_name || '—')}</td><td>${esc(b.member_name || '—')}</td><td>${chip(b.kind, 'blue')}</td><td>${chip(b.status)}</td>
    <td class="actions"><button class="btn small" data-act="editBooking" data-id="${b.id}">Edit</button>${b.status === 'confirmed' ? ` <button class="btn small" data-act="cancelBooking" data-id="${b.id}">Cancel</button>` : ''}${admin ? ` <button class="btn small danger" data-act="delBooking" data-id="${b.id}">Delete</button>` : ''}</td></tr>`);
  return `<div class="page-head"><h1>Bookings</h1><div class="toolbar"><label class="check" style="margin:0"><input type="checkbox" id="show-past"${state.showPast ? ' checked' : ''}> Show past</label><button class="btn primary" data-act="addBooking">+ New booking</button></div></div>
  <div class="card">${tableOrEmpty(rows, ['When', 'Booking', 'Boat', 'Person', 'Type', 'Status', ''], 'No bookings. Double-booking a boat is blocked automatically.')}</div>`;
};

views.people = async () => {
  const members = await api('GET', '/api/members');
  state.cache.members = members;
  const admin = state.me.role === 'admin';
  const rows = members.map(m => `<tr><td><b>${esc(m.name)}</b><br><span class="muted small">${esc([m.email, m.phone].filter(Boolean).join(' · '))}</span></td><td>${chip(m.type, 'blue')}</td><td>${esc(m.qualifications || '')}</td><td>${expiryChip(m.first_aid_expiry)}</td><td>${expiryChip(m.membership_expiry)}</td>
    <td class="actions"><button class="btn small" data-act="editMember" data-id="${m.id}">Edit</button>${admin ? ` <button class="btn small danger" data-act="delMember" data-id="${m.id}">Delete</button>` : ''}</td></tr>`);
  return `<div class="page-head"><h1>People</h1><div class="toolbar"><input type="search" id="people-search" placeholder="Search name, qualification…" aria-label="Search people"><button class="btn primary" data-act="addMember">+ Add person</button></div></div>
  <div class="card">${rows.length ? `<div class="table-wrap"><table id="people-table"><thead><tr>${['Person', 'Type', 'Qualifications', 'First aid', 'Membership', ''].map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : '<p class="empty">No people yet.</p>'}</div>`;
};

views.incidents = async () => {
  const [incidents, boats] = await Promise.all([api('GET', '/api/incidents'), api('GET', '/api/boats')]);
  Object.assign(state.cache, { incidents, boats });
  const admin = state.me.role === 'admin';
  const rows = incidents.map(i => `<tr><td class="small">${esc(fmtDT(i.occurred_at))}<br><span class="muted">${esc(i.reported_by || '')}</span></td><td>${chip(i.severity)}${i.type ? `<br><span class="small">${esc(i.type)}</span>` : ''}</td><td>${esc(i.description)}${i.injuries ? `<br><span class="small"><b>Injuries:</b> ${esc(i.injuries)}</span>` : ''}${i.action_taken ? `<br><span class="small"><b>Action:</b> ${esc(i.action_taken)}</span>` : ''}</td><td>${esc(i.boat_name || '')}</td><td>${chip(i.status)}</td>
    <td class="actions"><button class="btn small" data-act="editIncident" data-id="${i.id}">Edit</button>${admin ? ` <button class="btn small danger" data-act="delIncident" data-id="${i.id}">Delete</button>` : ''}</td></tr>`);
  return `<div class="page-head"><h1>Incident book</h1><button class="btn primary" data-act="addIncident">+ Log incident</button></div>
  <div class="card">${tableOrEmpty(rows, ['When', 'Severity', 'Details', 'Boat', 'Status', ''], 'No incidents logged. Log near misses too – they are how centres improve.')}</div>`;
};

views.log = async () => {
  const rows = (await api('GET', '/api/conditions')).map(c => `<tr><td class="small">${esc(fmtDT(c.recorded_at))}</td><td>${chip(c.flag)}</td><td>${c.wind_kts ?? ''}${c.gust_kts != null ? ' / ' + c.gust_kts : ''} kt ${esc(c.wind_dir || '')}</td><td>${esc(c.tide || '')}</td><td>${esc(c.notes || '')}</td><td class="small muted">${esc(c.recorded_by || '')}</td></tr>`);
  return `<div class="page-head"><h1>Conditions log</h1></div><div class="grid">
  <form class="card" id="cond-form"><h2>Log current conditions</h2>
    <div class="seg" role="radiogroup" aria-label="Flag" style="margin-bottom:.9rem">
      <label><input type="radio" name="flag" value="green" checked><span class="g">Green</span></label>
      <label><input type="radio" name="flag" value="yellow"><span class="y">Yellow</span></label>
      <label><input type="radio" name="flag" value="red"><span class="r">Red</span></label></div>
    <div class="form-grid"><label>Wind (kt)<input name="wind_kts" type="number" step="0.5" min="0"></label><label>Gusts (kt)<input name="gust_kts" type="number" step="0.5" min="0"></label>
      <label>Wind direction<input name="wind_dir" placeholder="e.g. SW"></label><label>Tide<input name="tide" placeholder="e.g. Flooding, HW 15:40"></label>
      <label class="full">Notes<input name="notes" placeholder="Visibility, swell, hazards…"></label></div>
    <button class="btn primary" type="submit">Log conditions</button> <span class="muted small">A red flag blocks new sign-outs for 6 hours unless the duty manager records an override.</span></form>
  <div class="card"><h2>History</h2>${tableOrEmpty(rows, ['When', 'Flag', 'Wind / gust', 'Tide', 'Notes', 'By'], 'Nothing logged yet.')}</div></div>`;
};

views.admin = async () => {
  const admin = state.me.role === 'admin';
  let extra = '';
  if (admin) {
    const [users, log] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/audit')]);
    extra = `<div class="card"><div class="card-head"><h2>Users</h2><button class="btn small primary" data-act="addUser">+ Add user</button></div>
      ${tableOrEmpty(users.map(u => `<tr><td><b>${esc(u.username)}</b></td><td>${esc(u.name)}</td><td>${chip(u.role, u.role === 'admin' ? 'blue' : '')}</td><td class="actions">${u.username === state.me.username ? '' : `<button class="btn small danger" data-act="delUser" data-id="${u.id}">Delete</button>`}</td></tr>`), ['Username', 'Name', 'Role', ''], '')}</div>
    <div class="card"><h2>Backup</h2><p class="muted small">Downloads a complete, consistent copy of the database. Do this regularly and keep a copy off the server.</p>
      <a class="btn small primary" href="/api/backup" download>Download database backup</a></div>
    <div class="card"><h2>Export (CSV)</h2><p class="muted small">Sign-out register and incident book downloads for record keeping, audits and insurers.</p>
      <div class="row">${['signouts', 'incidents', 'members', 'boats'].map(x => `<a class="btn small" href="/api/export/${x}" download>${x === 'signouts' ? 'Sign-out register' : esc(label(x))}</a>`).join('')}</div></div>
    <div class="card"><h2>Audit log</h2>${tableOrEmpty(log.map(a => `<tr><td class="small">${esc(fmtDT(a.at))}</td><td>${esc(a.user || '')}</td><td>${a.action.includes('override') ? chip(label(a.action), 'red') : esc(label(a.action))}</td><td>${esc(a.entity || '')} ${a.entity_id ?? ''}</td></tr>`), ['When', 'User', 'Action', 'Record'], 'No activity yet.')}</div>`;
  }
  return `<div class="page-head"><h1>Admin</h1></div><div class="grid cols-2">
    <form class="card" id="pw-form"><h2>Change my password</h2>
      <label>Current password<input name="current" type="password" autocomplete="current-password" required></label>
      <label>New password (8+ characters)<input name="next" type="password" minlength="8" autocomplete="new-password" required></label>
      <button class="btn primary" type="submit">Change password</button></form>
    ${extra}</div>`;
};

/* ---------- boot ---------- */
(async function boot() {
  try { state.cfg = await api('GET', '/api/config'); } catch { state.cfg = { centre: 'SailDeck', enums: {} }; }
  try { state.me = await api('GET', '/api/me'); await showApp(); } catch { showLogin(); }
})();
