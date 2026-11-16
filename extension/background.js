// Shark Tank — Zendesk helper (service worker)
// Receives "assign ticket X" from the Shark Tank website (via site-bridge.js) and performs it
// inside the agent's own logged-in Zendesk tab. No API tokens: it's the agent's own session,
// exactly as if they clicked "assign to me" themselves.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  if (msg?.type === 'assign') {
    assign(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
    return true; // async response
  }
});

function waitForComplete(tabId, timeoutMs = 30000) {
  return new Promise(async (resolve) => {
    const t = await chrome.tabs.get(tabId);
    if (t.status === 'complete') return resolve();
    const done = () => { chrome.tabs.onUpdated.removeListener(listener); resolve(); };
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(done, timeoutMs);
  });
}

async function assign({ host, ticketId, note }) {
  if (!/^[a-z0-9-]+\.zendesk\.com$/.test(host || '')) throw new Error('Invalid Zendesk host');
  const id = Number(ticketId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid ticket ID');
  const ticketUrl = `https://${host}/agent/tickets/${id}`;

  // Reuse an open Zendesk tab if there is one, otherwise open one in the background.
  let [tab] = await chrome.tabs.query({ url: `https://${host}/agent/*` });
  if (!tab) tab = await chrome.tabs.create({ url: ticketUrl, active: false });
  await waitForComplete(tab.id);

  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: zendeskAssign,
    args: [id, String(note || '').slice(0, 500)],
  });

  // Bring the ticket up for the agent (unless we're skipping it).
  if (result && !result.skip) {
    await chrome.tabs.update(tab.id, { url: ticketUrl, active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  return result || { ok: false, error: 'No result from Zendesk tab' };
}

// ---- Runs INSIDE the Zendesk page (same origin → uses the agent's session cookie) ----
async function zendeskAssign(ticketId, note) {
  const call = async (url, opts = {}) => {
    const r = await fetch(url, {
      credentials: 'same-origin',
      ...opts,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(opts.headers || {}) },
    });
    let d = null;
    try { d = await r.json(); } catch (_) { /* empty */ }
    return { status: r.status, ok: r.ok, d };
  };

  const meRes = await call('/api/v2/users/me.json');
  const me = meRes.d && meRes.d.user;
  if (!me || !me.id || !['agent', 'admin'].includes(me.role)) {
    return { ok: false, error: 'you are not signed in to Zendesk as an agent' };
  }
  const csrfMeta = document.querySelector('meta[name="csrf-token"]');
  const csrf = (csrfMeta && csrfMeta.content) || me.authenticity_token || '';

  for (let attempt = 0; attempt < 2; attempt++) {
    const tRes = await call(`/api/v2/tickets/${ticketId}.json`);
    if (tRes.status === 404) return { skip: true, reason: 'not found / deleted' };
    if (tRes.status === 403) return { ok: false, error: "you don't have access to this ticket" };
    if (!tRes.ok) return { ok: false, error: `couldn't load ticket (HTTP ${tRes.status})` };

    const t = tRes.d.ticket;
    if (t.status === 'solved' || t.status === 'closed') return { skip: true, reason: t.status };
    if (t.assignee_id && t.assignee_id !== me.id) return { skip: true, reason: 'already assigned to someone' };

    const update = {
      assignee_id: me.id,
      tags: Array.from(new Set([...(t.tags || []), 'shark_tank_claimed'])),
      safe_update: true,
      updated_stamp: t.updated_at,
      comment: { body: note, public: false },
    };
    if (t.status === 'new') update.status = 'open';

    const u = await call(`/api/v2/tickets/${ticketId}.json`, {
      method: 'PUT',
      headers: csrf ? { 'X-CSRF-Token': csrf } : {},
      body: JSON.stringify({ ticket: update }),
    });
    if (u.ok) return { ok: true, assigneeId: me.id };
    if (u.status === 409) continue; // someone edited it a split second ago → re-check once
    if (u.status === 422) return { ok: false, error: "Zendesk refused the assignment — you may not be in this ticket's group" };
    if (u.status === 403) return { ok: false, error: "you don't have permission to edit this ticket" };
    return { ok: false, error: `Zendesk error (HTTP ${u.status})` };
  }
  return { ok: false, error: 'ticket kept changing — try opening it manually' };
}
