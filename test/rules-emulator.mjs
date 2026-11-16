import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import * as fs from 'firebase/firestore';
import { readFileSync } from 'node:fs';
import { makeQueue } from '../website/queue.js';
const { doc, getDoc, getDocs, collection, query, where, updateDoc, writeBatch, setLogLevel } = fs;
setLogLevel('silent');

const env = await initializeTestEnvironment({ projectId: 'demo-shark', firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8085 } });
const ctx = (email) => env.authenticatedContext(email, { email, email_verified: true }).firestore();
const adminDb = ctx('admin1@bizee.com');
const A = makeQueue(fs, adminDb);
let pass = 0, fail = 0;
const check = async (name, p) => { try { await p; pass++; console.log('  ✓', name); } catch (e) { fail++; console.log('  ✗', name, '-', e.message); } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); };

console.log('Setup');
await check('admin creates meta docs', A.ensureMeta());
await check('admin adds 10 tickets', A.addTickets(Array.from({ length: 10 }, (_, i) => ({ ticketId: 1000 + i, leadType: 'Mail Order' })), 'admin1@bizee.com'));
await check('admin removes slot 5', A.removeTicket(5, 'admin1@bizee.com'));
await check('admin moves slot 9 (ticket 1009) to the top', A.move([0,1,2,3,4,6,7,8,9], 8, 0));

console.log('Security');
const bob = ctx('bob@bizee.com');
const outsider = ctx('mallory@gmail.com');
await check('outsider (gmail) cannot read the counter', assertFails(getDoc(doc(outsider, 'meta/counter'))));
await check('outsider cannot claim', assertFails(makeQueue(fs, outsider).claimOne({ email: 'mallory@gmail.com', name: 'M' })));
await check('agent CANNOT list the queue', assertFails(getDocs(collection(bob, 'queue'))));
await check('agent CANNOT read a waiting ticket', assertFails(getDoc(doc(bob, 'queue/3'))));
await check('agent CANNOT cherry-pick slot 3', assertFails((() => { const b = writeBatch(bob);
  b.update(doc(bob, 'queue/3'), { status: 'claimed', claimedBy: 'bob@bizee.com', claimedByName: 'Bob', claimedAt: fs.serverTimestamp(), claimedDay: 'x' });
  b.update(doc(bob, 'meta/counter'), { next: 4 }); return b.commit(); })()));
await check('agent CANNOT skip the front ticket without claiming it', assertFails(updateDoc(doc(bob, 'meta/counter'), { next: 1 })));
await check('agent CANNOT add tickets', assertFails(makeQueue(fs, bob).addTickets([{ ticketId: 1 }], 'bob@bizee.com')));
await check('agent CANNOT pause', assertFails(makeQueue(fs, bob).setPaused(true)));

console.log('Race: 12 agents grab at the same moment (9 live tickets, 1 removed)');
const agents = Array.from({ length: 12 }, (_, i) => ({ email: `agent${i}@incfile.com`, name: `Agent ${i}`, db: ctx(`agent${i}@incfile.com`) }));
const got = await Promise.all(agents.map((a) => makeQueue(fs, a.db).claimOne(a).catch((e) => 'ERR ' + e.code)));
const wins = got.filter((g) => typeof g === 'number');
await check('no errors', Promise.resolve(eq(got.filter((g) => typeof g === 'string'), [], 'errors')));
await check('exactly 9 claims, no duplicates', Promise.resolve(eq([...new Set(wins)].length, 9, 'unique')).then(() => eq(wins.length, 9, 'count')));
await check('removed slot 5 was never handed out', Promise.resolve(eq(wins.includes(5), false, 'slot5')));
await check('3 agents told the tank is empty', Promise.resolve(eq(got.filter((g) => g === null).length, 3, 'empty')));
const tickets = (await getDocs(query(collection(adminDb, 'queue')))).docs.map((d) => d.data()).filter((d) => d.status === 'claimed').sort((a, b) => a.claimedAt.toMillis() - b.claimedAt.toMillis() || a.seq - b.seq);
await check('FIFO: the moved ticket (1009) went out first', Promise.resolve(eq(tickets.sort((a,b)=>a.seq-b.seq)[0].ticketId, 1009, 'first')));

console.log('After the claim');
const winner = agents[got.findIndex((g) => g === 0)];
const loser = agents.find((a, i) => typeof got[i] === 'number' && got[i] !== 0);
await check('agent can read their OWN claim', assertSucceeds(getDoc(doc(winner.db, 'queue/0'))));
await check('agent can list their own claims', assertSucceeds(getDocs(query(collection(winner.db, 'queue'), where('claimedBy', '==', winner.email)))));
await check("agent CANNOT read someone else's claim", assertFails(getDoc(doc(loser.db, 'queue/0'))));
await check('agent can report "skipped" on own claim', assertSucceeds(makeQueue(fs, winner.db).report(0, { status: 'skipped', result: 'skipped: solved' })));
await check("agent CANNOT edit someone else's claim", assertFails(makeQueue(fs, loser.db).report(0, { result: 'hacked' })));
await check('agent CANNOT steal a claimed ticket', assertFails(updateDoc(doc(loser.db, 'queue/1'), { claimedBy: loser.email })));

console.log('Pause');
await A.addTickets([{ ticketId: 2000 }], 'admin1@bizee.com');
await A.setPaused(true);
await check('claim blocked while paused', makeQueue(fs, bob).claimOne({ email: 'bob@bizee.com', name: 'Bob' }).then(() => { throw new Error('claimed while paused'); }, (e) => eq(e.code, 'paused', 'code')));
await A.setPaused(false);
await check('claim works after unpause', makeQueue(fs, bob).claimOne({ email: 'bob@bizee.com', name: 'Bob' }).then((s) => eq(s, 10, 'seq')));

console.log(`\n${pass} passed, ${fail} failed`);
await env.cleanup();
process.exit(fail ? 1 : 0);
