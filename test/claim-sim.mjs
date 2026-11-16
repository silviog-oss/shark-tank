// Offline simulation of the claim logic: in-memory Firestore with optimistic transactions
// and a JS mirror of firestore.rules. Run: node test/claim-sim.mjs
import { makeQueue } from '../website/queue.js';

const store = new Map(); // path -> { v, data }
const ADMINS = ['admin1@bizee.com'];
const company = (e) => /^[^@]+@(bizee|incfile)\.com$/.test(e);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const denied = () => Object.assign(new Error('permission-denied'), { code: 'permission-denied' });
const TS = { __ts: true };

// --- mirror of firestore.rules (writes only; reads checked in get) ---
function allowWrite(user, writes) {
  const after = new Map(store); for (const w of writes) after.set(w.path, { data: w.data });
  const before = (p) => store.get(p)?.data; const aft = (p) => after.get(p)?.data;
  const signed = company(user.email); const admin = signed && ADMINS.includes(user.email);
  const paused = before('meta/settings')?.paused === true;
  for (const w of writes) {
    if (admin) continue;
    if (!signed || !store.has(w.path)) return false;
    const old = before(w.path); const nu = w.data;
    const changed = Object.keys({ ...old, ...nu }).filter((k) => JSON.stringify(old[k]) !== JSON.stringify(nu[k]));
    if (w.path === 'meta/counter') {
      const n = old.next; const slot = `queue/${n}`;
      const ok = !paused && changed.every((k) => k === 'next') && nu.next === n + 1 && n < old.tail && store.has(slot) &&
        ((before(slot).status === 'waiting' && aft(slot).status === 'claimed' && aft(slot).claimedBy === user.email) || before(slot).status !== 'waiting');
      if (!ok) return false;
    } else if (w.path.startsWith('queue/')) {
      const seq = Number(w.path.split('/')[1]);
      const claim = !paused && old.status === 'waiting' && seq === before('meta/counter').next && aft('meta/counter').next === seq + 1 &&
        changed.every((k) => ['status', 'claimedBy', 'claimedByName', 'claimedAt', 'claimedDay'].includes(k)) && nu.status === 'claimed' && nu.claimedBy === user.email;
      const report = old.claimedBy === user.email && old.status === 'claimed' && ['claimed', 'skipped'].includes(nu.status) &&
        changed.every((k) => ['status', 'result', 'resultAt'].includes(k));
      if (!claim && !report) return false;
    } else return false;
  }
  return true;
}
function allowRead(user, path) {
  const admin = company(user.email) && ADMINS.includes(user.email);
  if (admin) return true;
  if (!company(user.email)) return false;
  if (path.startsWith('meta/')) return true;
  return store.get(path)?.data?.claimedBy === user.email;
}

// --- minimal modular-SDK lookalike, one per user ---
function fakeFs(user) {
  const snap = (path) => { const r = store.get(path); return { exists: () => !!r, data: () => r && structuredClone(r.data) }; };
  const commit = (writes) => {
    if (!allowWrite(user, writes)) throw denied();
    for (const w of writes) store.set(w.path, { v: (store.get(w.path)?.v || 0) + 1, data: w.data });
  };
  const merged = (path, patch) => ({ ...(store.get(path)?.data || {}), ...patch });
  return {
    doc: (_db, ...p) => ({ path: p.join('/') }),
    serverTimestamp: () => TS,
    async getDoc(ref) { await sleep(Math.random() * 3); if (!allowRead(user, ref.path)) throw denied(); return snap(ref.path); },
    async setDoc(ref, data, opt) { await sleep(1); commit([{ path: ref.path, data: opt?.merge ? merged(ref.path, data) : data }]); },
    async updateDoc(ref, patch) { await sleep(1); commit([{ path: ref.path, data: merged(ref.path, patch) }]); },
    async runTransaction(_db, fn) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const seen = new Map(); const writes = [];
        const tx = {
          async get(ref) { await sleep(Math.random() * 3); if (!allowRead(user, ref.path)) throw denied(); seen.set(ref.path, store.get(ref.path)?.v || 0); return snap(ref.path); },
          set(ref, data) { writes.push({ path: ref.path, data }); },
          update(ref, patch) { const prev = writes.findLast?.((w) => w.path === ref.path)?.data; writes.push({ path: ref.path, data: { ...(prev || store.get(ref.path)?.data || {}), ...patch } }); },
        };
        const out = await fn(tx);
        await sleep(Math.random() * 5);
        if ([...seen].some(([p, v]) => (store.get(p)?.v || 0) !== v)) continue; // contention → SDK retries
        commit(writes);
        return out;
      }
      throw Object.assign(new Error('aborted'), { code: 'aborted' });
    },
  };
}

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(cond ? '  ✓' : '  ✗', name, cond ? '' : extra); };
const admin = { email: 'admin1@bizee.com', name: 'Admin' };
const A = makeQueue(fakeFs(admin), {});

await A.ensureMeta();
await A.addTickets(Array.from({ length: 10 }, (_, i) => ({ ticketId: 1000 + i })), admin.email);
await A.removeTicket(5, admin.email);
await A.move([0, 1, 2, 3, 4, 6, 7, 8, 9], 8, 0); // ticket 1009 to the top
ok('move: 1009 now at the front', store.get('queue/0').data.ticketId === 1009);

const agents = Array.from({ length: 25 }, (_, i) => ({ email: `agent${i}@incfile.com`, name: `A${i}` }));
const got = await Promise.all(agents.map((a) => makeQueue(fakeFs(a), {}).claimOne(a).catch((e) => 'ERR ' + e.code)));
const wins = got.filter((g) => typeof g === 'number');
ok('25 agents at once: no errors', !got.some((g) => typeof g === 'string'), JSON.stringify(got));
ok('exactly 9 claimed, all unique', wins.length === 9 && new Set(wins).size === 9, JSON.stringify(wins));
ok('removed slot 5 never handed out', !wins.includes(5));
ok('16 agents told "empty"', got.filter((g) => g === null).length === 16);
ok('each slot claimed by the agent who got it', wins.every((s) => store.get(`queue/${s}`).data.claimedBy === agents[got.indexOf(s)].email));

const bob = { email: 'bob@bizee.com', name: 'Bob' }; const B = makeQueue(fakeFs(bob), {});
await A.addTickets([{ ticketId: 2000 }, { ticketId: 2001 }], admin.email);
let e1; try { await fakeFs(bob).getDoc({ path: 'queue/11' }); } catch (e) { e1 = e; }
ok('agent cannot read a waiting ticket', e1?.code === 'permission-denied');
let e2; try { await fakeFs(bob).runTransaction({}, async (tx) => { tx.update({ path: 'queue/11' }, { status: 'claimed', claimedBy: bob.email }); tx.update({ path: 'meta/counter' }, { next: 12 }); }); } catch (e) { e2 = e; }
ok('agent cannot cherry-pick the 2nd ticket', e2?.code === 'permission-denied');
await A.setPaused(true);
let e3; try { await B.claimOne(bob); } catch (e) { e3 = e; }
ok('paused blocks claims', e3?.code === 'paused');
await A.setPaused(false);
ok('unpaused: Bob gets 2000 (front of line)', store.get(`queue/${await B.claimOne(bob)}`).data.ticketId === 2000);

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
