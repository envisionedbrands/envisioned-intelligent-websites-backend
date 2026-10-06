import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSlots, type EventType, type AvailabilityRule } from './slots.ts';

const TZ = 'Europe/Amsterdam';

function minutesOf(slots: string[]): number[] {
  return slots
    .map((iso) => {
      const d = new Date(iso);
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: TZ,
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
      }).formatToParts(d);
      const h = Number(parts.find((p) => p.type === 'hour')?.value);
      const m = Number(parts.find((p) => p.type === 'minute')?.value);
      return (h % 24) * 60 + m;
    })
    .sort((a, b) => a - b);
}

function eventType(overrides: Partial<EventType> = {}): EventType {
  return {
    id: 'evt-1',
    slug: 'test',
    name: 'Test',
    duration_minutes: 30,
    gap_minutes: 15,
    lead_time_hours: 0,
    booking_window_days: 10,
    max_per_day: null,
    max_per_month: null,
    is_active: true,
    ...overrides,
  };
}

// A single Thursday (2026-11-05) so the day-of-week grid is unambiguous.
const THURSDAY = new Date('2026-11-05T00:00:00Z');
const thursdayRule = (start_minute: number, end_minute: number): AvailabilityRule[] => [
  { day_of_week: 4, start_minute, end_minute },
];

test('day-end recovery offers the hard-stop start when the step grid would strand it', () => {
  const slots = generateSlots({
    eventType: eventType(),
    availability: thursdayRule(630, 1050),
    busy: [],
    blackouts: [],
    timeZone: TZ,
    from: THURSDAY,
    days: 0,
    now: THURSDAY,
  });

  assert.deepEqual(minutesOf(slots), [630, 675, 720, 765, 810, 855, 900, 945, 990, 1020]);
});

test('day-end recovery adds nothing when the window already divides evenly', () => {
  const slots = generateSlots({
    eventType: eventType(),
    availability: thursdayRule(630, 720),
    busy: [],
    blackouts: [],
    timeZone: TZ,
    from: THURSDAY,
    days: 0,
    now: THURSDAY,
  });

  assert.deepEqual(minutesOf(slots), [630, 675]);
});

test('day-end recovery never introduces an overlapping slot', () => {
  for (let windowLen = 30; windowLen <= 300; windowLen += 5) {
    const slots = generateSlots({
      eventType: eventType({ duration_minutes: 30, gap_minutes: 15 }),
      availability: thursdayRule(600, 600 + windowLen),
      busy: [],
      blackouts: [],
      timeZone: TZ,
      from: THURSDAY,
      days: 0,
      now: THURSDAY,
    });
    const mins = minutesOf(slots);
    for (let i = 1; i < mins.length; i++) {
      assert.ok(mins[i] >= mins[i - 1] + 30, `overlap at window length ${windowLen}: ${mins}`);
    }
  }
});

test('day-end recovery is a no-op when no slot fits the window at all', () => {
  const slots = generateSlots({
    eventType: eventType({ duration_minutes: 30 }),
    availability: thursdayRule(600, 620),
    busy: [],
    blackouts: [],
    timeZone: TZ,
    from: THURSDAY,
    days: 0,
    now: THURSDAY,
  });
  assert.deepEqual(slots, []);
});
