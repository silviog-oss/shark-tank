import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import * as fs from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { FIREBASE_CONFIG, ADMINS, ALLOWED_DOMAINS, ZENDESK_HOST } from './config.js';
import { makeQueue, parseTicketId, today } from './queue.js';

const { getFirestore, collection, query, where, orderBy, limit, onSnapshot } = fs;
const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);
const Q = makeQueue(fs, db);

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ticketUrl = (id) => `https://${ZENDESK_HOST}/agent/tickets/${id}`;
const fmt = (ts) => (ts?.toDate ? ts.toDate().toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

let me = null;
let isAdmin = false;
let paused = false;
let unsubs = [];
let waiting = []; // admin: waiting slots in order
let logHistory = []; // admin: non-waiting slots, newest first

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}
function show(view) {
  ['login', 'agent', 'admin'].forEach((v) => $(`#view-${v}`).classList.toggle('hidden', v !== view));
  $$('.navbtn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
}

// ---------------- Chrome extension bridge ----------------
// The extension's content script relays these messages to the extension, which assigns
// the ticket in the agent's own Zendesk session.
let extReady = false;
let extVersion = '';
const pending = new Map();
let msgId = 0;
window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.source !== 'sharktank-ext') return;
  if (e.data.type === 'hello') { extReady = true; extVersion = e.data.version || ''; renderExt(); return; }
  const done = pending.get(e.data.id);
  if (done) { pending.delete(e.data.id); done(e.data.resp); }
});
window.postMessage({ source: 'sharktank-web', type: 'hello?' }, location.origin);

const WORKER = new URLSearchParams(location.search).get('worker') === '1'; // opened hidden by the extension
const waitForExt = async (ms = 2500) => { const end = Date.now() + ms; while (!extReady && Date.now() < end) await new Promise((r) => setTimeout(r, 100)); return extReady; };

async function ext(payload, timeoutMs = 60000) {
  await waitForExt();
  return new Promise((resolve) => {
    if (!extReady) return resolve(null);
    const id = ++msgId;
    pending.set(id, resolve);
    window.postMessage({ source: 'sharktank-web', id, payload }, location.origin);
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ ok: false, error: 'Zendesk helper timed out' }); } }, timeoutMs);
  });
}
function renderExt() {
  const p = $('#ext-pill');
  p.classList.toggle('on', extReady);
  p.textContent = extReady
    ? `✓ Zendesk helper connected${extVersion ? ' v' + extVersion : ''} — tip: use the 🦈 Grab ticket button inside Zendesk`
    : 'Zendesk helper extension not detected — you\'ll get a link and assign it to yourself';
}
setTimeout(renderExt, 800);

// ---------------- Auth ----------------
$('#signin').onclick = async () => {
  $('#login-error').textContent = '';
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account', ...(ALLOWED_DOMAINS.length === 1 ? { hd: ALLOWED_DOMAINS[0] } : {}) });
  try { await signInWithPopup(auth, provider); } catch (e) {
    const msgs = {
      'auth/popup-blocked': `Chrome blocked the sign-in window. Click the blocked-popup icon at the right of the address bar → "Always allow pop-ups from ${location.hostname}", then try again.`,
      'auth/popup-closed-by-user': 'The sign-in window was closed before finishing — try again.',
      'auth/cancelled-popup-request': '',
      'auth/unauthorized-domain': `This site (${location.hostname}) isn't authorized in Firebase yet — an admin needs to add it under Authentication → Settings → Authorized domains.`,
      'auth/invalid-api-key': 'The Firebase API key in config.js is wrong — an admin needs to fix it.',
    };
    $('#login-error').textContent = e.code in msgs ? msgs[e.code] : e.message;
  }
};
$('#signout').onclick = () => signOut(auth);

onAuthStateChanged(auth, async (u) => {
  unsubs.forEach((f) => f()); unsubs = [];
  if (!u) {
    me = null; $('#nav').classList.add('hidden'); $('#userchip').classList.add('hidden'); show('login');
    if (WORKER) { $('#login-error').textContent = 'Sign in once and your ticket will open in Zendesk automatically.'; ext({ type: 'needLogin' }); }
    return;
  }
  const email = (u.email || '').toLowerCase();
  if (!ALLOWED_DOMAINS.includes(email.split('@')[1])) {
    await signOut(auth);
    $('#login-error').textContent = `Please use your company Google account (${ALLOWED_DOMAINS.map((d) => '@' + d).join(' or ')}).`;
    return;
  }
  me = { email, name: u.displayName || email };
  isAdmin = ADMINS.map((a) => a.toLowerCase()).includes(email);
  $('#username').textContent = me.name;
  $('#avatar').src = u.photoURL || '';
  $('#nav').classList.remove('hidden');
  $('#userchip').classList.remove('hidden');
  $$('.admin-only').forEach((el) => el.classList.toggle('hidden', !isAdmin));
  if (isAdmin) await Q.ensureMeta().catch((e) => toast('Setup error: ' + e.message));
  startAgent();
  if (isAdmin) startAdmin();
  show(new URLSearchParams(location.search).get('view') === 'admin' && isAdmin ? 'admin' : 'agent');
});

$$('.navbtn').forEach((b) => (b.onclick = () => show(b.dataset.view)));

// ---------------- Agent ----------------
function startAgent() {
  unsubs.push(onSnapshot(Q.counterRef, (s) => {
    const d = s.data() || { next: 0, tail: 0 };
    $('#count').textContent = Math.max(0, d.tail - d.next);
  }, () => {}));
  unsubs.push(onSnapshot(Q.settingsRef, (s) => {
    paused = !!s.data()?.paused;
    $('#paused-banner').classList.toggle('hidden', !paused);
    $('#grab').disabled = paused;
    $('#pause-toggle').checked = paused;
  }, () => {}));
  const mine = query(collection(db, 'queue'), where('claimedBy', '==', me.email), where('claimedDay', '==', today()));
  unsubs.push(onSnapshot(mine, (snap) => {
    const rows = snap.docs.map((d) => d.data()).sort((a, b) => (b.claimedAt?.seconds || 0) - (a.claimedAt?.seconds || 0));
    $('#my-claims').innerHTML = rows.length
      ? rows.map((r) => `<tr><td><a href="${ticketUrl(r.ticketId)}" target="_blank">#${r.ticketId}</a></td><td>${esc(r.leadType)}</td><td>${fmt(r.claimedAt)}</td><td>${esc(r.result || (r.status === 'skipped' ? 'skipped' : ''))}</td></tr>`).join('')
      : '<tr><td colspan="4" class="muted">None yet.</td></tr>';
  }, (e) => console.error(e)));

  if (WORKER) {
    $('#grab-status').textContent = 'Working… this tab closes by itself.';
    setTimeout(grab, 300);
  }
}

function showTicket(t, kind, msg) {
  const card = $('#ticket-card');
  card.className = 'ticket ' + (kind === 'assigned' ? 'ok' : 'warn');
  const line = {
    assigned: '✅ Opened in your Zendesk tab and assigned to you (submit the ticket to save it).',
    link: '🔗 Open it and assign it to yourself.',
    failed: `⚠️ Couldn't auto-assign (${esc(msg)}). Open it and assign it to yourself.`,
  }[kind];
  card.innerHTML = `<div class="tid">#${t.ticketId}</div>
    ${t.leadType ? `<div class="muted">${esc(t.leadType)}</div>` : ''}
    <p>${line}</p>
    <a href="${ticketUrl(t.ticketId)}" target="_blank">${ticketUrl(t.ticketId)}</a>`;
}

let grabbing = false;
async function grab() {
  if (grabbing) return;
  grabbing = true;
  const btn = $('#grab'); btn.disabled = true;
  const status = $('#grab-status');
  const say = (text) => { status.textContent = text; };
  let outcome = { ok: false, text: 'Something went wrong.' };
  $('#ticket-card').classList.add('hidden');
  $('#ticket-card').innerHTML = '';
  say('Grabbing…');
  try {
    if (paused) { outcome = { ok: false, text: '⏸ The Shark Tank is paused by an admin.' }; say(outcome.text); return; }
    for (let i = 0; i < 10; i++) {
      const seq = await Q.claimOne(me);
      if (seq == null) { outcome = { ok: false, text: 'The tank is empty right now 🌊 — try again in a bit.' }; say(outcome.text); return; }
      const t = await Q.getSlot(seq);

      if (!(await waitForExt())) {
        await Q.report(seq, { result: 'link only (no extension)' });
        say('You got one!');
        showTicket(t, 'link');
        window.open(ticketUrl(t.ticketId), '_blank');
        outcome = { ok: true, text: `🦈 You got #${t.ticketId}` };
        return;
      }

      say(`Opening #${t.ticketId} in Zendesk…`);
      const r = await ext({ type: 'assign', host: ZENDESK_HOST, ticketId: t.ticketId, note: `🦈 Claimed from the Shark Tank by ${me.name}` });
      if (r?.ok) {
        await Q.report(seq, { result: `assigned (${r.method || 'ok'})` });
        say('You got one!');
        showTicket(t, 'assigned');
        outcome = { ok: true, text: r.method === 'take it'
          ? `🦈 You got #${t.ticketId} — "take it" clicked. Submit the ticket to save the assignment.`
          : `🦈 You got #${t.ticketId} — assigned to you.` };
        return;
      }
      if (r?.skip) {
        await Q.report(seq, { status: 'skipped', result: `skipped: ${r.reason}` });
        say(`#${t.ticketId} was ${r.reason} — grabbing the next one…`);
        ext({ type: 'status', text: `#${t.ticketId} was ${r.reason} — grabbing the next one…` });
        continue;
      }
      await Q.report(seq, { result: `assign failed: ${r?.error || 'unknown'}` });
      say('You got one — but it needs a manual assign.');
      showTicket(t, 'failed', r?.error || 'unknown error');
      outcome = { ok: false, text: `🦈 You got #${t.ticketId}, but: ${r?.error || 'unknown error'}. Assign it to yourself.` };
      return;
    }
    outcome = { ok: false, text: 'Several tickets in a row were already handled — tell an admin to check the queue.' };
    say(outcome.text);
  } catch (e) {
    console.error(e);
    outcome = { ok: false, text: e.code === 'paused' ? '⏸ The Shark Tank is paused.' : `Error: ${e.message}` };
    say(outcome.text);
  } finally {
    grabbing = false; btn.disabled = paused; $('#ticket-card').classList.toggle('hidden', !$('#ticket-card').innerHTML);
    if (WORKER) ext({ type: 'done', ...outcome });
  }
}
$('#grab').onclick = grab;

// ---------------- Admin ----------------
function startAdmin() {
  $('#admin-list').textContent = ADMINS.join(', ');
  const q = query(collection(db, 'queue'), orderBy('seq', 'desc'), limit(3000));
  unsubs.push(onSnapshot(q, (snap) => {
    const all = snap.docs.map((d) => d.data());
    waiting = all.filter((d) => d.status === 'waiting').sort((a, b) => a.seq - b.seq);
    logHistory = all.filter((d) => d.status !== 'waiting');
    renderQueue(); renderLog();
  }, (e) => toast('Admin feed error: ' + e.message)));
}

$$('.tab').forEach((t) => (t.onclick = () => {
  $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
  ['queue', 'log', 'settings'].forEach((n) => $(`#tab-${n}`).classList.toggle('hidden', n !== t.dataset.tab));
}));

function renderQueue() {
  $('#q-badge').textContent = waiting.length;
  $('#queue-body').innerHTML = waiting.length
    ? waiting.map((w, i) => `<tr>
        <td>${i + 1}</td>
        <td><a href="${ticketUrl(w.ticketId)}" target="_blank">#${w.ticketId}</a></td>
        <td>${esc(w.leadType)}</td><td class="muted">${esc(w.addedBy?.split('@')[0])}</td><td class="muted">${fmt(w.addedAt)}</td>
        <td class="actions">
          <button class="btn sm" data-act="top" data-i="${i}" ${i === 0 ? 'disabled' : ''}>Top</button>
          <button class="btn sm" data-act="up" data-i="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn sm" data-act="down" data-i="${i}" ${i === waiting.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="btn sm danger" data-act="remove" data-i="${i}">Remove</button>
        </td></tr>`).join('')
    : '<tr><td colspan="6" class="muted">The tank is empty. Add tickets above.</td></tr>';
}

$('#queue-body').onclick = async (e) => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const i = Number(b.dataset.i); const seqs = waiting.map((w) => w.seq);
  b.disabled = true;
  try {
    if (b.dataset.act === 'up') await Q.move(seqs, i, i - 1);
    if (b.dataset.act === 'down') await Q.move(seqs, i, i + 1);
    if (b.dataset.act === 'top') await Q.move(seqs, i, 0);
    if (b.dataset.act === 'remove') {
      if (!confirm(`Remove #${waiting[i].ticketId} from the tank?`)) { b.disabled = false; return; }
      await Q.removeTicket(waiting[i].seq, me.email);
    }
  } catch (err) { toast(err.message); b.disabled = false; }
};

$('#add-btn').onclick = async () => {
  const defType = $('#add-type').value;
  const lines = $('#add-input').value.split('\n').map((l) => l.trim()).filter(Boolean);
  const inTank = new Set(waiting.map((w) => w.ticketId));
  const items = []; const bad = []; let dupes = 0;
  for (const line of lines) {
    const [idPart, ...rest] = line.split(/[,\t]/);
    const id = parseTicketId(idPart);
    if (!id) { bad.push(line); continue; }
    if (inTank.has(id)) { dupes++; continue; }
    inTank.add(id);
    items.push({ ticketId: id, leadType: rest.join(' ').trim() || defType });
  }
  if (!items.length) { $('#add-status').textContent = bad.length ? `Couldn't read: ${bad.join(', ')}` : 'Nothing new to add.'; return; }
  $('#add-btn').disabled = true;
  try {
    await Q.addTickets(items, me.email);
    $('#add-input').value = bad.join('\n');
    $('#add-status').textContent = `Added ${items.length}.` + (dupes ? ` Skipped ${dupes} already in the tank.` : '') + (bad.length ? ` ${bad.length} line(s) not understood (left in the box).` : '');
  } catch (e) { $('#add-status').textContent = 'Error: ' + e.message; }
  $('#add-btn').disabled = false;
};

function logRows() {
  const agent = $('#log-agent').value;
  const range = $('#log-range').value; const term = $('#log-search').value.trim().toLowerCase();
  const cutoff = range === 'all' ? 0 : range === 'today' ? new Date(new Date().setHours(0, 0, 0, 0)).getTime() : Date.now() - Number(range) * 864e5;
  return logHistory.filter((h) => {
    const t = (h.claimedAt || h.resultAt || h.addedAt)?.toMillis?.() || 0;
    if (t < cutoff) return false;
    if (agent && h.claimedBy !== agent) return false;
    return !term || `${h.ticketId} ${h.claimedByName} ${h.claimedBy} ${h.leadType}`.toLowerCase().includes(term);
  });
}
function renderAgentFilter() {
  const sel = $('#log-agent'); const cur = sel.value;
  const agents = new Map();
  logHistory.forEach((h) => { if (h.claimedBy) agents.set(h.claimedBy, h.claimedByName || h.claimedBy); });
  sel.innerHTML = '<option value="">All agents</option>' + [...agents].sort((x, y) => x[1].localeCompare(y[1]))
    .map(([e, n]) => `<option value="${esc(e)}">${esc(n)}</option>`).join('');
  sel.value = agents.has(cur) ? cur : '';
}
function renderLog() {
  renderAgentFilter();
  const rows = logRows();
  const byAgent = {};
  rows.filter((r) => r.status === 'claimed').forEach((r) => { byAgent[r.claimedByName || r.claimedBy] = (byAgent[r.claimedByName || r.claimedBy] || 0) + 1; });
  $('#stats').innerHTML = Object.entries(byAgent).sort((a, b) => b[1] - a[1]).map(([n, c]) => `<span class="stat">${esc(n)} <b>${c}</b></span>`).join('') || '<span class="muted">No claims in this range.</span>';
  $('#log-body').innerHTML = rows.length ? rows.slice(0, 500).map((r) => `<tr>
      <td class="muted">${fmt(r.claimedAt || r.resultAt)}</td>
      <td><a href="${ticketUrl(r.ticketId)}" target="_blank">#${r.ticketId}</a></td><td>${esc(r.leadType)}</td>
      <td>${r.claimedBy ? `<b>${esc(r.claimedByName || '')}</b><br><span class="muted">${esc(r.claimedBy)}</span>` : '<span class="muted">—</span>'}</td>
      <td><span class="tag ${r.status}">${r.status}</span></td><td class="muted">${esc(r.result || '')}</td>
      <td class="actions"><button class="btn sm" data-requeue="${r.ticketId}" data-type="${esc(r.leadType)}">Re-queue</button></td></tr>`).join('')
    : '<tr><td colspan="7" class="muted">Nothing in this range yet.</td></tr>';
}
$('#log-range').onchange = renderLog;
$('#log-agent').onchange = renderLog;
$('#log-search').oninput = renderLog;
$('#log-body').onclick = async (e) => {
  const b = e.target.closest('button[data-requeue]'); if (!b) return;
  const id = Number(b.dataset.requeue);
  if (waiting.some((w) => w.ticketId === id)) return toast(`#${id} is already in the tank.`);
  await Q.addTickets([{ ticketId: id, leadType: b.dataset.type }], me.email);
  toast(`#${id} added back to the bottom of the line.`);
};
$('#export').onclick = () => {
  const head = ['ticket', 'lead_type', 'status', 'agent', 'agent_email', 'claimed_at', 'result'];
  const lines = logRows().map((r) => [r.ticketId, r.leadType, r.status, r.claimedByName, r.claimedBy,
    r.claimedAt?.toDate?.().toISOString() || '', r.result].map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','));
  const blob = new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `shark-tank-log-${today()}.csv` });
  a.click();
};
$('#pause-toggle').onchange = (e) => Q.setPaused(e.target.checked).then(() => toast(e.target.checked ? 'Paused.' : 'Unpaused.'));
