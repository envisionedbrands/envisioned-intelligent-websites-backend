import { parseIcs } from '../src/lib/crm/ics.ts';

const W0 = new Date('2026-08-01T00:00:00Z');
const W1 = new Date('2026-10-01T00:00:00Z');
let pass = 0, fail = 0;
const check = (n: string, c: boolean, extra = '') => { c ? pass++ : fail++; console.log(c ? `  ok  ${n}` : `  FAIL ${n} ${extra}`); };
const ics = (body: string) => `BEGIN:VCALENDAR\nVERSION:2.0\n${body}\nEND:VCALENDAR`;
const iso = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ');

// 1. plain UTC event
let e = parseIcs(ics(`BEGIN:VEVENT\nUID:a1\nSUMMARY:Dentist\nDTSTART:20260820T090000Z\nDTEND:20260820T100000Z\nEND:VEVENT`), W0, W1);
check('timed UTC event', e.length === 1 && iso(e[0].start) === '2026-08-20 09:00' && iso(e[0].end) === '2026-08-20 10:00', JSON.stringify(e.map(x=>iso(x.start))));

// 2. all-day
e = parseIcs(ics(`BEGIN:VEVENT\nUID:a2\nDTSTART;VALUE=DATE:20260821\nDTEND;VALUE=DATE:20260822\nEND:VEVENT`), W0, W1);
check('all-day spans 24h', e.length === 1 && (+e[0].end - +e[0].start) === 86400000);

// 3. weekly BYDAY — the standing Tuesday call
e = parseIcs(ics(`BEGIN:VEVENT\nUID:a3\nSUMMARY:Standing client\nDTSTART:20260804T140000Z\nDTEND:20260804T150000Z\nRRULE:FREQ=WEEKLY;BYDAY=TU\nEND:VEVENT`), W0, W1);
const allTue = e.every(x => x.start.getUTCDay() === 2);
check('weekly BYDAY=TU expands', e.length >= 8 && allTue, `${e.length} occurrences, allTue=${allTue}`);
check('weekly keeps the time of day', e.every(x => x.start.getUTCHours() === 14));

// 4. COUNT
e = parseIcs(ics(`BEGIN:VEVENT\nUID:a4\nDTSTART:20260805T090000Z\nDTEND:20260805T093000Z\nRRULE:FREQ=DAILY;COUNT=3\nEND:VEVENT`), W0, W1);
check('COUNT=3 stops at 3', e.length === 3, `got ${e.length}`);

// 5. UNTIL
e = parseIcs(ics(`BEGIN:VEVENT\nUID:a5\nDTSTART:20260805T090000Z\nDTEND:20260805T093000Z\nRRULE:FREQ=DAILY;UNTIL=20260808T000000Z\nEND:VEVENT`), W0, W1);
check('UNTIL bounds the series', e.length === 3, `got ${e.length}: ${e.map(x=>iso(x.start))}`);

// 6. EXDATE removes an instance
e = parseIcs(ics(`BEGIN:VEVENT\nUID:a6\nDTSTART:20260805T090000Z\nDTEND:20260805T093000Z\nRRULE:FREQ=DAILY;COUNT=3\nEXDATE:20260806T090000Z\nEND:VEVENT`), W0, W1);
check('EXDATE drops that occurrence', e.length === 2 && !e.some(x=>iso(x.start)==='2026-08-06 09:00'), e.map(x=>iso(x.start)).join(','));

// 7. cancelled dropped
e = parseIcs(ics(`BEGIN:VEVENT\nUID:a7\nSTATUS:CANCELLED\nDTSTART:20260820T090000Z\nDTEND:20260820T100000Z\nEND:VEVENT`), W0, W1);
check('CANCELLED dropped', e.length === 0);

// 8. transparent flagged (free time shouldn't block)
e = parseIcs(ics(`BEGIN:VEVENT\nUID:a8\nTRANSP:TRANSPARENT\nDTSTART:20260820T090000Z\nDTEND:20260820T100000Z\nEND:VEVENT`), W0, W1);
check('TRANSPARENT flagged', e.length === 1 && e[0].transparent === true);

// 9. DURATION instead of DTEND
e = parseIcs(ics(`BEGIN:VEVENT\nUID:a9\nDTSTART:20260820T090000Z\nDURATION:PT1H30M\nEND:VEVENT`), W0, W1);
check('DURATION honoured', e.length === 1 && (+e[0].end - +e[0].start) === 90*60000);

// 10. TZID — 11:00 Amsterdam in August = 09:00 UTC
e = parseIcs(ics(`BEGIN:VEVENT\nUID:a10\nDTSTART;TZID=Europe/Amsterdam:20260820T110000\nDTEND;TZID=Europe/Amsterdam:20260820T120000\nEND:VEVENT`), W0, W1);
check('TZID converts to correct instant', e.length===1 && iso(e[0].start) === '2026-08-20 09:00', e.map(x=>iso(x.start)).join(','));

// 11. folded lines
e = parseIcs(ics(`BEGIN:VEVENT\nUID:a11\nSUMMARY:A very long summary that has been\n  folded across lines\nDTSTART:20260820T090000Z\nDTEND:20260820T100000Z\nEND:VEVENT`), W0, W1);
check('folded lines unfold', e.length===1 && (e[0].summary||'').includes('folded across lines'), e[0]?.summary||'');

// 12. outside window excluded
e = parseIcs(ics(`BEGIN:VEVENT\nUID:a12\nDTSTART:20250101T090000Z\nDTEND:20250101T100000Z\nEND:VEVENT`), W0, W1);
check('event outside window excluded', e.length === 0);

// 13. unique uids per occurrence (so upserts don't collide)
e = parseIcs(ics(`BEGIN:VEVENT\nUID:a13\nDTSTART:20260805T090000Z\nDTEND:20260805T093000Z\nRRULE:FREQ=DAILY;COUNT=3\nEND:VEVENT`), W0, W1);
check('recurring occurrences get distinct uids', new Set(e.map(x=>x.uid)).size === e.length);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
