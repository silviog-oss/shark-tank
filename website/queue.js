// Queue operations. `fs` = the Firestore modular SDK functions, `db` = Firestore instance.
// Kept separate from the UI so the same code runs in the browser and in the rules test.

export function parseTicketId(text) {
  const s = String(text || '').trim();
  const m = s.match(/tickets\/(\d+)/) || s.match(/^#?(\d+)$/);
  return m ? Number(m[1]) : null;
}

export function today(d = new Date()) {
  return d.toLocaleDateString('en-CA'); // YYYY-MM-DD in the browser's timezone
}

const err = (code, message = code) => Object.assign(new Error(message), { code });

export function makeQueue(fs, db) {
  const { doc, runTransaction, serverTimestamp, updateDoc, getDoc, setDoc } = fs;
  const counterRef = doc(db, 'meta', 'counter');
  const settingsRef = doc(db, 'meta', 'settings');
  const slotRef = (n) => doc(db, 'queue', String(n));

  /** Admin: make sure meta docs exist. */
  async function ensureMeta() {
    const c = await getDoc(counterRef);
    if (!c.exists()) await setDoc(counterRef, { next: 0, tail: 0 });
    const s = await getDoc(settingsRef);
    if (!s.exists()) await setDoc(settingsRef, { paused: false });
  }

  /** Admin: append tickets to the bottom of the line. items = [{ ticketId, leadType }] */
  async function addTickets(items, adminEmail) {
    for (let i = 0; i < items.length; i += 400) {
      const chunk = items.slice(i, i + 400);
      await runTransaction(db, async (tx) => {
        const c = await tx.get(counterRef);
        const tail = c.data().tail;
        chunk.forEach((it, k) => {
          tx.set(slotRef(tail + k), {
            seq: tail + k, ticketId: it.ticketId, leadType: it.leadType || '', status: 'waiting',
            addedBy: adminEmail, addedAt: serverTimestamp(),
          });
        });
        tx.update(counterRef, { tail: tail + chunk.length });
      });
    }
  }

  /** Admin: move a waiting ticket from one position to another by rotating contents. seqs = waiting seqs in order. */
  async function move(seqs, from, to) {
    if (from === to) return;
    const lo = Math.min(from, to), hi = Math.max(from, to);
    const span = seqs.slice(lo, hi + 1);
    await runTransaction(db, async (tx) => {
      const snaps = [];
      for (const s of span) snaps.push(await tx.get(slotRef(s)));
      if (snaps.some((x) => x.data()?.status !== 'waiting')) throw err('changed', 'The line changed — try again.');
      const payload = snaps.map((x) => {
        const d = x.data();
        return { ticketId: d.ticketId, leadType: d.leadType, addedBy: d.addedBy, addedAt: d.addedAt };
      });
      // from < to: item moves down → rotate left. from > to: item moves up → rotate right.
      const rotated = from < to ? [...payload.slice(1), payload[0]] : [payload[payload.length - 1], ...payload.slice(0, -1)];
      span.forEach((s, k) => tx.update(slotRef(s), rotated[k]));
    });
  }

  async function removeTicket(seq, adminEmail) {
    await updateDoc(slotRef(seq), { status: 'removed', result: `removed by ${adminEmail}`, resultAt: serverTimestamp() });
  }

  async function setPaused(paused) {
    await setDoc(settingsRef, { paused }, { merge: true });
  }

  /**
   * Agent: claim the slot at the front of the line. Returns seq, or null if the tank is empty.
   * Agents can't read waiting slots, so this is a "blind" claim — the security rules
   * reject it if the slot isn't the front of the line or someone else got it first.
   */
  async function claimOne(user) {
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        return await runTransaction(db, async (tx) => {
          let c;
          try { c = await tx.get(counterRef); } catch (e) { throw e.code === 'permission-denied' ? err('no-access', 'Your account is not allowed to use the Shark Tank.') : e; }
          if (!c.exists()) throw err('empty');
          const { next, tail } = c.data();
          if (next >= tail) throw err('empty');
          tx.update(slotRef(next), {
            status: 'claimed', claimedBy: user.email, claimedByName: user.name,
            claimedAt: serverTimestamp(), claimedDay: today(),
          });
          tx.update(counterRef, { next: next + 1 });
          return next;
        });
      } catch (e) {
        if (e.code === 'empty') return null;
        if (['aborted', 'failed-precondition', 'unavailable', 'deadline-exceeded'].includes(e.code)) {
          await new Promise((r) => setTimeout(r, 50 + Math.random() * 250)); // lots of agents at once → back off, retry
          continue;
        }
        if (e.code !== 'permission-denied') throw e;

        // Denied: either paused, or the front slot was removed by an admin → step over it.
        const settings = await getDoc(settingsRef).catch(() => null);
        if (settings?.data()?.paused) throw err('paused');
        const stepped = await runTransaction(db, async (tx) => {
          const c = await tx.get(counterRef);
          const { next, tail } = c.data();
          if (next >= tail) throw err('empty');
          tx.update(counterRef, { next: next + 1 });
          return true;
        }).catch((e2) => (e2.code === 'empty' ? 'empty' : e2));
        if (stepped === 'empty') return null;
        // stepped !== true → another agent moved the line first (it's now on a live ticket): just try again.
        if (stepped !== true && stepped.code !== 'permission-denied' && !['aborted', 'failed-precondition'].includes(stepped.code)) throw stepped;
      }
    }
    throw err('busy', 'The tank is very busy — try again.');
  }

  async function getSlot(seq) {
    return (await getDoc(slotRef(seq))).data();
  }

  async function report(seq, { status = 'claimed', result }) {
    await updateDoc(slotRef(seq), { status, result, resultAt: serverTimestamp() });
  }

  return { counterRef, settingsRef, slotRef, ensureMeta, addTickets, move, removeTicket, setPaused, claimOne, getSlot, report };
}
