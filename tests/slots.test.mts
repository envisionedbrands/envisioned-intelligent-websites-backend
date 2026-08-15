import { generateSlots, type EventType } from '../src/lib/crm/slots.ts';

const TZ = 'Europe/Amsterdam';
const base: EventType = {
  id: 'x', slug: 'client-session', name: 'Client', duration_minutes: 60,
  gap_minutes: 15, lead_time_hours: 24, booking_window_days: 21,
  max_per_day: 2, max_per_month: null, is_active: true,
};
// Tue 10:00-15:00 (600-900), Thu 10:00-16:30 (600-990)
const avail = [
  { day_of_week: 2, start_minute: 600, end_minute: 900 },
  { day_of_week: 4, start_minute: 600, end_minute: 990 },
];
const now = new Date('2026-08-15T08:00:00Z');

function hhmm(iso: string) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra = '') => {
  cond ? pass++ : fail++;
  console.log(cond ? `  ok  ${name}` : `  FAIL ${name} ${extra}`);
};

// 1. gaps
const slots = generateSlots({ eventType: base, availability: avail, busy: [], blackouts: [], timeZone: TZ, now, days: 14 });
const firstDay = slots.filter(s => hhmm(s).startsWith(hhmm(slots[0]).slice(0,10)));
console.log('First day slots:', firstDay.map(hhmm));
const gaps: number[] = [];
for (let i=1;i<firstDay.length;i++) gaps.push((+new Date(firstDay[i]) - +new Date(firstDay[i-1]))/60000 - 60);
check('every gap is exactly 15 min', gaps.every(g => g === 15), JSON.stringify(gaps));

// 2. Tuesday never runs past 15:00 local (protects the 16:00 standing call)
const tue = slots.filter(s => hhmm(s).startsWith('Tue'));
const tueEndsOk = tue.every(s => { const end = new Date(+new Date(s) + 60*60000); const h = new Intl.DateTimeFormat('en-GB',{timeZone:TZ,hour:'2-digit',minute:'2-digit',hour12:false}).format(end); return h <= '15:00'; });
check('Tue calls all end by 15:00', tueEndsOk, tue.map(hhmm).join(' '));

// 3. lead time honoured
check('no slot inside 24h lead time', slots.every(s => +new Date(s) >= +now + 24*3600000));

// 4. busy blocks neighbours by the gap on BOTH sides
const target = tue[1];
const busy = [{ starts_at: target, ends_at: new Date(+new Date(target)+60*60000).toISOString() }];
const after = generateSlots({ eventType: base, availability: avail, busy, blackouts: [], timeZone: TZ, now, days: 14 });
const removed = tue.filter(s => !after.includes(s));
console.log('booked', hhmm(target), '-> removed:', removed.map(hhmm));
check('booked slot itself removed', removed.includes(target));
// On a correctly spaced grid neighbours are ALREADY gap-compliant (10:00 ends
// 11:00, exactly 15 before an 11:15 start), so only the booked slot goes.
check('only the booked slot goes on an aligned grid', removed.length === 1, `removed ${removed.length}`);
check('no surviving slot violates the gap', after.filter(s=>hhmm(s).startsWith('Tue')).every(s => {
  const s0=+new Date(s), e0=s0+60*60000, b0=+new Date(target), b1=b0+60*60000;
  return e0 + 15*60000 <= b0 || s0 >= b1 + 15*60000;
}));

// 4b. an OFF-GRID commitment (external event / the standing 16:00 call) must
// eat every candidate it comes within the gap of.
const offStart = new Date(+new Date(tue[0]) + 30*60000).toISOString(); // 10:30
const offGrid = [{ starts_at: offStart, ends_at: new Date(+new Date(offStart)+60*60000).toISOString() }];
const afterOff = generateSlots({ eventType: base, availability: avail, busy: offGrid, blackouts: [], timeZone: TZ, now, days: 14 });
const removedOff = tue.filter(s => !afterOff.includes(s));
console.log('off-grid 10:30-11:30 ->', removedOff.map(hhmm));
check('off-grid busy removes overlapping + too-close slots', removedOff.length >= 2, `removed ${removedOff.length}`);
check('survivors still clear the off-grid block by 15min', afterOff.filter(s=>hhmm(s).startsWith('Tue')).every(s => {
  const s0=+new Date(s), e0=s0+60*60000, b0=+new Date(offStart), b1=b0+60*60000;
  return e0 + 15*60000 <= b0 || s0 >= b1 + 15*60000;
}));

// 5. max_per_day
const twoBooked = [0,1].map(i => ({ starts_at: tue[i], ends_at: new Date(+new Date(tue[i])+60*60000).toISOString() }));
const capped = generateSlots({ eventType: base, availability: avail, busy: twoBooked, blackouts: [], timeZone: TZ, now, days: 14 });
const sameDay = hhmm(tue[0]).slice(0,10);
check('max_per_day=2 closes that day', capped.filter(s=>hhmm(s).startsWith(sameDay)).length === 0);

// 6. DST — clocks go back 25 Oct 2026; her 10:00 must stay 10:00
const dst = generateSlots({ eventType: base, availability: avail, busy: [], blackouts: [], timeZone: TZ, now: new Date('2026-10-20T08:00:00Z'), days: 20 });
const nov = dst.filter(s => hhmm(s).includes('Nov') || hhmm(s).includes('Oct'));
const firstOfDay = new Map<string,string>();
for (const s of nov) { const k = hhmm(s).slice(0,10); if(!firstOfDay.has(k)) firstOfDay.set(k, hhmm(s).slice(-5)); }
console.log('across DST, first slot each day:', [...firstOfDay.entries()].slice(0,6));
check('10:00 stays 10:00 across the DST change', [...firstOfDay.values()].every(v => v === '10:00'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
