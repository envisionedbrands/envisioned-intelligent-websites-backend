import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSlots, type EventType, type AvailabilityRule } from './slots.ts';

const TZ = 'Europe/Amsterdam';

const baseEventType: EventType = {
  id: 'evt-1',
  slug: 'backpocket-tlc',
  name: 'Modern CEO Backpocket TLC',
  duration_minutes: 30,
  gap_minutes: 15,
  lead_time_hours: 0,
  booking_window_days: 60,
  max_per_day: null,
  max_per_month: null,
  is_active: true,
  week_of_month_rule: 'first_last',
};

// Every weekday 09:00–18:00 so the day-of-week grid never hides the result.
const everyWeekday: AvailabilityRule[] = [1, 2, 3, 4, 5].map((day_of_week) => ({
  day_of_week,
  start_minute: 9 * 60,
  end_minute: 18 * 60,
}));

test('week_of_month_rule "first_last" only offers days 1-7 and the last 7 of the month', () => {
  // 2026-11 has 30 days, so the last week starts on the 24th.
  const slots = generateSlots({
    eventType: baseEventType,
    availability: everyWeekday,
    busy: [],
    blackouts: [],
    timeZone: TZ,
    from: new Date('2026-11-01T00:00:00Z'),
    days: 29,
    now: new Date('2026-11-01T00:00:00Z'),
  });

  const daysOffered = new Set(
    slots.map((iso) => Number(new Date(iso).toLocaleString('en-US', { timeZone: TZ, day: 'numeric' })))
  );

  for (const day of daysOffered) {
    assert.ok(day <= 7 || day > 23, `day ${day} is outside the first/last week`);
  }
  assert.ok([...daysOffered].some((d) => d <= 7), 'no slots in the first week');
  assert.ok([...daysOffered].some((d) => d > 23), 'no slots in the last week');
});

test('no week_of_month_rule offers every weekday in the window', () => {
  const slots = generateSlots({
    eventType: { ...baseEventType, week_of_month_rule: null },
    availability: everyWeekday,
    busy: [],
    blackouts: [],
    timeZone: TZ,
    from: new Date('2026-11-01T00:00:00Z'),
    days: 29,
    now: new Date('2026-11-01T00:00:00Z'),
  });

  const daysOffered = new Set(
    slots.map((iso) => Number(new Date(iso).toLocaleString('en-US', { timeZone: TZ, day: 'numeric' })))
  );

  assert.ok([...daysOffered].includes(15) || [...daysOffered].includes(16));
});
