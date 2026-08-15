'use client';

/**
 * /crm/calendar — the diary and the calendars behind it.
 *
 *   Week / Month → her actual week: bookings AND the blocks mirrored from her
 *                  external calendar. Showing only bookings would read as an
 *                  empty diary, which would be a lie.
 *   List         → chronological, for scanning what's next
 *   Bookable     → the event types people can book, their rules, next openings
 *
 * Native since 2026-08-15 (off GHL, off Cal.com).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, EmptyState, GhostBtn, Loading, PageHeader } from '@/components/crm/kit';

type Item = {
  id: string;
  kind: 'booking' | 'busy';
  title: string;
  starts_at: string;
  ends_at: string | null;
  status?: string;
  calendar?: string;
  location?: string | null;
  all_day?: boolean;
};

type EventType = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  duration_minutes: number;
  gap_minutes: number;
  lead_time_hours: number;
  max_per_day: number | null;
  max_per_month: number | null;
  price_cents: number;
  currency: string;
  location_kind: string;
  is_public: boolean;
  is_active: boolean;
  availability: string[];
  booking_url: string;
  next_slots: string[];
};

type View = 'week' | 'month' | 'list' | 'bookable';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Local yyyy-mm-dd. toISOString() is UTC and silently shifts the day back
 *  for anyone east of Greenwich at local midnight — which put the whole grid
 *  one day out. */
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const time = (s: string | null) =>
  s ? new Date(s).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—';

/** Monday of the week containing `d`. */
function weekStart(d: Date) {
  const x = new Date(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export default function CalendarPage() {
  const [view, setView] = useState<View>('week');
  const [anchor, setAnchor] = useState(() => new Date());
  const [items, setItems] = useState<Item[] | null>(null);
  const [types, setTypes] = useState<EventType[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The window we need depends on the view.
  const range = useMemo(() => {
    if (view === 'week') {
      const s = weekStart(anchor);
      return { from: iso(s), to: iso(addDays(s, 6)) };
    }
    if (view === 'month') {
      const s = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      const e = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
      // Pad to whole weeks so the grid is complete.
      return { from: iso(weekStart(s)), to: iso(addDays(weekStart(e), 6)) };
    }
    return null;
  }, [view, anchor]);

  const load = useCallback(async () => {
    setError(null);
    if (view === 'bookable') {
      setTypes(null);
      try {
        const res = await api<{ event_types: EventType[] }>(
          '/api/crm/booking/event-types?with_slots=1'
        );
        setTypes(res.event_types);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load calendars');
        setTypes([]);
      }
      return;
    }
    setItems(null);
    try {
      const qs = range
        ? `from=${range.from}&to=${range.to}`
        : 'days=30&range=upcoming';
      const res = await api<{ items: Item[] }>(`/api/crm/calendar?${qs}`);
      setItems(res.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the diary');
      setItems([]);
    }
  }, [view, range]);

  useEffect(() => {
    void load();
  }, [load]);

  const byDay = useMemo(() => {
    const m = new Map<string, Item[]>();
    (items || []).forEach((i) => {
      const k = iso(new Date(i.starts_at));
      m.set(k, [...(m.get(k) || []), i]);
    });
    return m;
  }, [items]);

  const shift = (n: number) => {
    if (view === 'week') setAnchor(addDays(anchor, n * 7));
    else if (view === 'month')
      setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + n, 1));
  };

  const periodLabel =
    view === 'week'
      ? (() => {
          const s = weekStart(anchor);
          const e = addDays(s, 6);
          const sameMonth = s.getMonth() === e.getMonth();
          return `${s.getDate()} ${sameMonth ? '' : s.toLocaleDateString('en-GB', { month: 'short' }) + ' '}– ${e.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
        })()
      : anchor.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  const todayKey = iso(new Date());

  function Chip({ i }: { i: Item }) {
    const booking = i.kind === 'booking';
    return (
      <div
        title={`${i.title}${i.calendar ? ` · ${i.calendar}` : ''}`}
        // Only zinc/white utilities are theme-remapped in globals.css, so the
        // text uses those and the accent colour lives in the border. Colouring
        // the text emerald made it unreadable in light mode.
        className={`truncate border-l-2 px-1.5 py-1 text-[11px] leading-tight ${
          booking
            ? 'border-emerald-500 bg-emerald-500/[0.10] text-white'
            : 'border-zinc-500/50 bg-white/[0.04] text-zinc-400'
        }`}
      >
        {!i.all_day && <span className="tabular-nums opacity-70">{time(i.starts_at)} </span>}
        {i.title}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Calendar">
        <div className="flex items-center gap-2">
          {(['week', 'month', 'list', 'bookable'] as View[]).map((v) => (
            <GhostBtn key={v} onClick={() => setView(v)}>
              <span className={view === v ? 'text-white' : undefined}>
                {v[0].toUpperCase() + v.slice(1)}
              </span>
            </GhostBtn>
          ))}
          {(view === 'week' || view === 'month') && (
            <>
              <GhostBtn onClick={() => shift(-1)}>←</GhostBtn>
              <GhostBtn onClick={() => setAnchor(new Date())}>Today</GhostBtn>
              <GhostBtn onClick={() => shift(1)}>→</GhostBtn>
            </>
          )}
          <GhostBtn onClick={() => void load()}>Refresh</GhostBtn>
        </div>
      </PageHeader>

      <div className="flex-1 overflow-y-auto px-12 pb-16">
        {error && (
          <div className="mb-6 border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-[13px] text-amber-300/90">
            {error}
          </div>
        )}

        {(view === 'week' || view === 'month') && (
          <>
            <div className="mb-4 flex items-baseline gap-4">
              <h2 className="text-[15px] font-medium text-white">{periodLabel}</h2>
              {items && (
                <span className="text-[11px] text-zinc-600">
                  {items.filter((i) => i.kind === 'booking').length} booked ·{' '}
                  {items.filter((i) => i.kind === 'busy').length} from your calendar
                </span>
              )}
            </div>

            {items === null && <Loading />}

            {items !== null && (
              <div className="grid grid-cols-7 gap-px border border-white/10 bg-white/10">
                {WEEKDAYS.map((w) => (
                  <div key={w} className="bg-minimal-bg px-2 py-2 text-[11px] text-zinc-500">
                    {w}
                  </div>
                ))}

                {(() => {
                  const start = range ? new Date(`${range.from}T00:00:00`) : new Date();
                  const end = range ? new Date(`${range.to}T00:00:00`) : new Date();
                  const cells: Date[] = [];
                  for (let d = new Date(start); d <= end; d = addDays(d, 1)) cells.push(new Date(d));
                  return cells.map((d) => {
                    const k = iso(d);
                    const dayItems = (byDay.get(k) || []).sort((a, b) =>
                      a.starts_at.localeCompare(b.starts_at)
                    );
                    const inMonth = view === 'month' ? d.getMonth() === anchor.getMonth() : true;
                    return (
                      <div
                        key={k}
                        className={`min-h-[104px] bg-minimal-bg p-1.5 ${
                          inMonth ? '' : 'opacity-40'
                        }`}
                      >
                        <div className="mb-1 flex items-baseline justify-between">
                          <span
                            className={`text-[11px] tabular-nums ${
                              k === todayKey
                                ? 'flex h-5 w-5 items-center justify-center rounded-full bg-white text-black'
                                : 'text-zinc-500'
                            }`}
                          >
                            {d.getDate()}
                          </span>
                        </div>
                        <div className="space-y-1">
                          {dayItems.slice(0, view === 'week' ? 12 : 4).map((i) => (
                            <Chip key={i.id} i={i} />
                          ))}
                          {dayItems.length > (view === 'week' ? 12 : 4) && (
                            <p className="px-1 text-[10px] text-zinc-600">
                              +{dayItems.length - (view === 'week' ? 12 : 4)} more
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
            )}

            <p className="mt-4 flex items-center gap-4 text-[11px] text-zinc-600">
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-1 bg-emerald-400/70" /> booked through your site
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-1 bg-white/20" /> from your Google calendar
              </span>
            </p>
          </>
        )}

        {view === 'list' && (
          <>
            {items === null && <Loading />}
            {items !== null && items.length === 0 && (
              <EmptyState title="Nothing in the next 30 days" />
            )}
            {items !== null &&
              Array.from(byDay.entries())
                .sort()
                .map(([k, list]) => (
                  <section key={k} className="mb-8">
                    <div className="flex items-baseline gap-3 border-b border-white/10 pb-2 mb-3">
                      <h2 className="text-[13px] font-semibold text-white">
                        {new Date(`${k}T12:00:00`).toLocaleDateString('en-GB', {
                          weekday: 'long',
                          day: 'numeric',
                          month: 'long',
                        })}
                      </h2>
                      <span className="text-[11px] text-zinc-600">{list.length}</span>
                    </div>
                    <ul className="space-y-px">
                      {list.map((i) => (
                        <li key={i.id} className="flex items-start gap-6 py-2.5">
                          <span className="w-28 shrink-0 text-[13px] tabular-nums text-zinc-300">
                            {i.all_day ? 'all day' : `${time(i.starts_at)} – ${time(i.ends_at)}`}
                          </span>
                          <span className="flex-1 min-w-0">
                            <span className="block truncate text-[13px] text-white">
                              {i.kind === 'booking' && (
                                <span className="mr-2 inline-block h-2 w-2 rounded-full bg-emerald-500 align-middle" />
                              )}
                              {i.title}
                            </span>
                            <span className="block text-[11px] text-zinc-500">{i.calendar}</span>
                          </span>
                          {i.location && /^https?:\/\//.test(i.location) && (
                            <a
                              href={i.location}
                              target="_blank"
                              rel="noreferrer"
                              className="shrink-0 text-[11px] text-zinc-500 hover:text-white"
                            >
                              Join ↗
                            </a>
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
          </>
        )}

        {view === 'bookable' && (
          <>
            {types === null && <Loading />}
            {types !== null && types.length === 0 && !error && (
              <EmptyState title="No calendars yet" />
            )}
            <div className="space-y-px">
              {(types || []).map((t) => (
                <section key={t.id} className="py-6 border-b border-white/[0.06]">
                  <div className="flex items-start justify-between gap-8">
                    <div className="min-w-0">
                      <div className="flex items-center gap-3">
                        <h2 className="text-[15px] font-medium text-white">{t.name}</h2>
                        {!t.is_active && (
                          <span className="text-[10px] uppercase tracking-wider text-zinc-600 border border-zinc-700 px-1.5 py-0.5">
                            paused
                          </span>
                        )}
                        {t.location_kind === 'async' && (
                          <span className="text-[10px] uppercase tracking-wider text-amber-300/80 border border-amber-500/30 px-1.5 py-0.5">
                            delivery block
                          </span>
                        )}
                        <span className="text-[10px] uppercase tracking-wider text-zinc-600">
                          {t.is_public ? 'public' : 'private link'}
                        </span>
                      </div>
                      {t.description && (
                        <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-zinc-500">
                          {t.description}
                        </p>
                      )}
                      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-zinc-500">
                        <span>{t.duration_minutes} min</span>
                        <span>+{t.gap_minutes} min gap</span>
                        <span>{t.lead_time_hours}h notice</span>
                        {t.max_per_day != null && <span>max {t.max_per_day}/day</span>}
                        {t.max_per_month != null && <span>max {t.max_per_month}/month</span>}
                        <span>
                          {t.price_cents > 0
                            ? `${t.currency} ${(t.price_cents / 100).toFixed(0)}`
                            : 'free'}
                        </span>
                      </div>
                      <div className="mt-2 text-[11px] text-zinc-400">
                        {t.availability.length ? (
                          t.availability.join('  ·  ')
                        ) : (
                          <span className="text-amber-300/70">no hours set</span>
                        )}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="mb-1.5 text-[10px] uppercase tracking-wider text-zinc-600">
                        Next openings
                      </p>
                      {t.next_slots.length === 0 ? (
                        <p className="text-[12px] text-zinc-600">none in 28 days</p>
                      ) : (
                        <ul className="space-y-0.5">
                          {t.next_slots.map((s) => (
                            <li key={s} className="text-[12px] tabular-nums text-zinc-300">
                              {new Date(s).toLocaleString('en-GB', {
                                weekday: 'short',
                                day: '2-digit',
                                month: 'short',
                                hour: '2-digit',
                                minute: '2-digit',
                                hour12: false,
                              })}
                            </li>
                          ))}
                        </ul>
                      )}
                      <p className="mt-2 font-mono text-[11px] text-zinc-600">{t.booking_url}</p>
                    </div>
                  </div>
                </section>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
