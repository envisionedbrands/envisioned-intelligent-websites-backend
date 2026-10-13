// Booking sequence against an in-memory database and fake senders: nothing
// here touches Supabase, Resend or the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';

// The CRM modules import siblings without an extension ("./email"), which the
// bundler resolves and plain node does not. Try ".ts" for those.
type Resolve = (specifier: string, context: unknown, next: (s: string, c: unknown) => unknown) => unknown;
const { registerHooks } = nodeModule as unknown as { registerHooks(hooks: { resolve: Resolve }): void };
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (e) {
      if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context);
      throw e;
    }
  },
});
const { runBookingSequence } = await import('./booking-sequence.ts');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
type Row = Record<string, unknown>;
type Db = Parameters<typeof runBookingSequence>[0];
type Deps = NonNullable<Parameters<typeof runBookingSequence>[2]>;

interface Query extends PromiseLike<unknown> {
  select(cols?: string, opts?: { head?: boolean }): Query;
  update(patch: Row): Query;
  eq(field: string, value: unknown): Query;
  is(field: string, value: null): Query;
  in(field: string, values: unknown[]): Query;
  gte(field: string, value: string): Query;
  or(expr: string): Query;
  maybeSingle(): Promise<{ data: Row | null; error: null }>;
}

/** Just enough of the supabase-js query builder for runBookingSequence. */
function fakeDb(tables: Record<string, Row[]>) {
  const log: { table: string; op: string; patch?: Row }[] = [];

  function cond(field: string, op: string, raw: string): (r: Row) => boolean {
    return (r) => {
      const v = r[field];
      if (op === 'eq') return String(v) === raw;
      if (op === 'gte') return v != null && Date.parse(String(v)) >= Date.parse(raw);
      if (op === 'lte') return v != null && Date.parse(String(v)) <= Date.parse(raw);
      throw new Error(`fake or(): unsupported op ${op}`);
    };
  }
  // Parses "a.op.v,and(b.op.v,c.op.v)" — the shapes the sequence uses.
  function parseOr(expr: string): (r: Row) => boolean {
    const parts: string[] = [];
    let depth = 0, cur = '';
    for (const ch of expr) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
    }
    parts.push(cur);
    const preds = parts.map((p) => {
      if (p.startsWith('and(')) {
        const subs = p.slice(4, -1).split(',').map((s) => parseOr(s));
        return (r: Row) => subs.every((f) => f(r));
      }
      const [field, op, ...rest] = p.split('.');
      return cond(field, op, rest.join('.'));
    });
    return (r) => preds.some((f) => f(r));
  }

  function from(table: string) {
    const filters: ((r: Row) => boolean)[] = [];
    let patch: Row | null = null;
    let head = false;
    const rows = () => (tables[table] ||= []).filter((r) => filters.every((f) => f(r)));
    const run = () => {
      if (patch) {
        const hit = rows();
        for (const r of hit) Object.assign(r, patch);
        log.push({ table, op: 'update', patch });
        return { data: hit.map((r) => ({ id: r.id })), error: null };
      }
      const hit = rows();
      // Copies, like rows off the wire: a later update does not reach a read already made.
      return head ? { data: null, count: hit.length, error: null } : { data: hit.map((r) => ({ ...r })), error: null };
    };
    const q: Query = {
      select(_cols?: string, opts?: { head?: boolean }) { head = !!opts?.head; return q; },
      update(p: Row) { patch = p; return q; },
      eq(f: string, v: unknown) { filters.push((r) => r[f] === v); return q; },
      is(f: string, v: null) { filters.push((r) => (r[f] ?? null) === v); return q; },
      in(f: string, vs: unknown[]) { filters.push((r) => vs.includes(r[f])); return q; },
      gte(f: string, v: string) { filters.push(cond(f, 'gte', v)); return q; },
      or(expr: string) { filters.push(parseOr(expr)); return q; },
      maybeSingle() { const { data } = run(); return Promise.resolve({ data: (data as Row[])?.[0] ?? null, error: null }); },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return q;
  }
  return { db: { from } as unknown as Db, log };
}

const settings = { safe_mode: false } as unknown as Parameters<typeof runBookingSequence>[1];

function world(appt: Row, opts: { recentSends?: number } = {}) {
  const lead = { id: 'lead-1', email: 'guest@example.com', first_name: 'Ana', last_name: 'Ruiz' };
  const tables: Record<string, Row[]> = {
    backend_settings: [{ key: 'booking_sequence_enabled', value: true }],
    appointments: [{
      id: 'appt-1', lead_id: lead.id, status: 'scheduled', title: 'Backpocket TLC',
      timezone: 'Europe/Amsterdam', guest_timezone: 'Europe/Amsterdam', guest_notes: 'Hello',
      confirmation_sent_at: null, reminder_24h_sent_at: null, reminder_12h_sent_at: null,
      reminder_1h_sent_at: null, reminder_5min_sent_at: null, thank_you_sent_at: null,
      ...appt,
    }],
    leads: [lead],
    email_templates: [],
    email_sends: Array.from({ length: opts.recentSends || 0 }, (_, i) => ({
      id: `s${i}`, lead_id: lead.id, created_at: new Date(Date.now() - HOUR).toISOString(),
    })),
  };
  return { tables, ...fakeDb(tables) };
}

function senders(guestStatus: 'sent' | 'simulated' | 'failed' = 'sent', ownerResult: { sent: boolean; error?: string } = { sent: true }) {
  const guest: { subject: string }[] = [];
  const owner: { subject: string; body: string }[] = [];
  return {
    guest,
    owner,
    deps: {
      sendCrmEmail: async (_db: unknown, input: { subject: string }) => {
        guest.push({ subject: input.subject });
        return guestStatus === 'failed' ? { status: 'failed', error: 'provider down' } : { status: guestStatus };
      },
      notifyOwner: async (_db: unknown, subject: string, body: string) => {
        owner.push({ subject, body });
        return ownerResult;
      },
    } as unknown as Deps,
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

test('a booking two weeks out made just now gets its confirmation', async () => {
  const now = Date.now();
  const w = world({ starts_at: iso(now + 14 * DAY), created_at: iso(now - 2 * 60_000) });
  const s = senders();
  const summary = await runBookingSequence(w.db, settings, s.deps);
  assert.equal(s.guest.length, 1);
  assert.match(s.guest[0].subject, /diary|penciled|confirm/i);
  assert.equal(summary.sent, 1);
  assert.ok(w.tables.appointments[0].confirmation_sent_at, 'step stamped');
  assert.equal(w.tables.appointments[0].reminder_24h_sent_at, null, 'later steps untouched');
});

test('a booking two weeks out made a day ago is not fetched or stamped', async () => {
  const now = Date.now();
  const w = world({ starts_at: iso(now + 14 * DAY), created_at: iso(now - DAY) });
  const s = senders();
  await runBookingSequence(w.db, settings, s.deps);
  assert.equal(s.guest.length + s.owner.length, 0);
  assert.equal(w.tables.appointments[0].confirmation_sent_at, null);
});

test('a second tick sends nothing twice', async () => {
  const now = Date.now();
  const w = world({ starts_at: iso(now + 14 * DAY), created_at: iso(now - 60_000) });
  const s = senders();
  await runBookingSequence(w.db, settings, s.deps);
  const second = await runBookingSequence(w.db, settings, s.deps);
  assert.equal(s.guest.length, 1, 'one guest confirmation');
  assert.equal(s.owner.length, 1, 'one owner notice');
  assert.deepEqual(second, { sent: 0, simulated: 0, skipped: 0, errors: [] });
});

test('two overlapping ticks send one confirmation', async () => {
  const now = Date.now();
  const w = world({ starts_at: iso(now + 14 * DAY), created_at: iso(now - 60_000) });
  const s = senders();
  await Promise.all([runBookingSequence(w.db, settings, s.deps), runBookingSequence(w.db, settings, s.deps)]);
  assert.equal(s.guest.length, 1, 'the claim lets one tick through');
  assert.equal(s.owner.length, 1);
});

test('a provider failure releases the claim and the next tick retries', async () => {
  const now = Date.now();
  const w = world({ starts_at: iso(now + 14 * DAY), created_at: iso(now - 60_000) });
  const failing = senders('failed');
  const first = await runBookingSequence(w.db, settings, failing.deps);
  assert.equal(w.tables.appointments[0].confirmation_sent_at, null, 'claim released');
  assert.equal(failing.owner.length, 0, 'no owner notice on a failed guest send');
  assert.equal(first.errors.length, 1);
  assert.match(first.errors[0], /provider down/);

  const ok = senders();
  await runBookingSequence(w.db, settings, ok.deps);
  assert.equal(ok.guest.length, 1, 'retried');
  assert.equal(ok.owner.length, 1);
  assert.ok(w.tables.appointments[0].confirmation_sent_at);
});

test('owner notice: content, the stand-down path, and simulation mode', async () => {
  const now = Date.now();
  // Stand-down: the guest had another email inside the quiet window.
  const quiet = world({ starts_at: iso(now + 14 * DAY), created_at: iso(now - 60_000) }, { recentSends: 1 });
  const s1 = senders();
  const sum1 = await runBookingSequence(quiet.db, settings, s1.deps);
  assert.equal(s1.guest.length, 0, 'guest confirmation stands down');
  assert.equal(s1.owner.length, 1, 'owner still told');
  assert.equal(sum1.skipped, 1);
  assert.match(s1.owner[0].subject, /^New booking: Ana Ruiz, /);
  assert.match(s1.owner[0].body, /guest@example\.com/);
  assert.match(s1.owner[0].body, /Their note:\*\* Hello/);

  // Simulation mode: the guest email is simulated, the owner notice is not.
  // Intended (see notifyNewBooking); this pins the behaviour so a change is deliberate.
  const sim = world({ starts_at: iso(now + 14 * DAY), created_at: iso(now - 60_000) });
  const s2 = senders('simulated');
  const sum2 = await runBookingSequence(sim.db, settings, s2.deps);
  assert.equal(sum2.simulated, 1);
  assert.equal(s2.owner.length, 1, 'owner notice goes out in simulation mode');
});

test('a failed owner notice surfaces in errors and never repeats the guest email', async () => {
  const now = Date.now();
  const w = world({ starts_at: iso(now + 14 * DAY), created_at: iso(now - 60_000) });
  const s = senders('sent', { sent: false, error: 'Resend responded 500' });
  const first = await runBookingSequence(w.db, settings, s.deps);
  assert.equal(first.sent, 1);
  assert.deepEqual(first.errors, ['guest@example.com (owner notice): Resend responded 500']);
  assert.ok(w.tables.appointments[0].confirmation_sent_at, 'step stays stamped');

  const throwing = senders();
  throwing.deps.notifyOwner = async () => { throw new Error('boom'); };
  const w2 = world({ starts_at: iso(now + 14 * DAY), created_at: iso(now - 60_000) });
  const sum = await runBookingSequence(w2.db, settings, throwing.deps);
  assert.ok(w2.tables.appointments[0].confirmation_sent_at, 'a throwing notice does not release the step');
  assert.deepEqual(sum.errors, ['guest@example.com (owner notice): boom']);

  await runBookingSequence(w.db, settings, s.deps);
  assert.equal(s.guest.length, 1, 'no second guest email');
});
