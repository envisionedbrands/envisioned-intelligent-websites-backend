'use client';

/**
 * /crm/calendar — two views over the native booking system:
 *   Booked   → appointments (what's actually in the diary)
 *   Bookable → booking_event_types (the calendars people can book, their
 *              hours, rules, and the next real openings)
 *
 * Native since 2026-08-15 (MI: move off GHL, build everything in the backend).
 */
import { useCallback, useEffect, useState } from 'react';
import { api, EmptyState, GhostBtn, Loading, PageHeader } from '@/components/crm/kit';

type Ev = {
  id: string;
  title: string;
  starts_at: string | null;
  ends_at: string | null;
  status: string;
  calendar: string;
  location: string | null;
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

function time(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function relativeDay(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const diff = Math.round(
    (new Date(d.toDateString()).getTime() - new Date(today.toDateString()).getTime()) / 86400000
  );
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}

function slotLabel(iso: string) {
  return new Date(iso).toLocaleString('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export default function CalendarPage() {
  const [view, setView] = useState<'booked' | 'bookable'>('bookable');
  const [events, setEvents] = useState<Ev[] | null>(null);
  const [types, setTypes] = useState<EventType[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<'upcoming' | 'past'>('upcoming');
  const [days, setDays] = useState(30);

  const loadBooked = useCallback(async () => {
    setEvents(null);
    setError(null);
    try {
      const res = await api<{ events: Ev[] }>(`/api/crm/calendar?days=${days}&range=${range}`);
      setEvents(res.events);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load bookings');
      setEvents([]);
    }
  }, [days, range]);

  const loadBookable = useCallback(async () => {
    setTypes(null);
    setError(null);
    try {
      const res = await api<{ event_types: EventType[] }>(
        '/api/crm/booking/event-types?with_slots=1'
      );
      setTypes(res.event_types);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load calendars');
      setTypes([]);
    }
  }, []);

  useEffect(() => {
    if (view === 'booked') void loadBooked();
    else void loadBookable();
  }, [view, loadBooked, loadBookable]);

  const grouped: Record<string, Ev[]> = {};
  (events || []).forEach((e) => {
    if (!e.starts_at) return;
    const k = new Date(e.starts_at).toISOString().slice(0, 10);
    (grouped[k] ||= []).push(e);
  });
  const dayKeys = Object.keys(grouped).sort((a, b) =>
    range === 'past' ? b.localeCompare(a) : a.localeCompare(b)
  );

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Calendar">
        <div className="flex items-center gap-2">
          <GhostBtn onClick={() => setView(view === 'booked' ? 'bookable' : 'booked')}>
            {view === 'booked' ? 'Booked' : 'Bookable'}
          </GhostBtn>
          {view === 'booked' && (
            <>
              <GhostBtn onClick={() => setRange(range === 'upcoming' ? 'past' : 'upcoming')}>
                {range === 'upcoming' ? 'Upcoming' : 'Past'}
              </GhostBtn>
              <GhostBtn onClick={() => setDays(days === 30 ? 90 : 30)}>{days} days</GhostBtn>
            </>
          )}
          <GhostBtn onClick={() => (view === 'booked' ? void loadBooked() : void loadBookable())}>
            Refresh
          </GhostBtn>
        </div>
      </PageHeader>

      <div className="flex-1 overflow-y-auto px-12 pb-16">
        {error && (
          <div className="mb-6 border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-[13px] text-amber-300/90">
            {error}
          </div>
        )}

        {/* ── Bookable: the calendars themselves ─────────────────────── */}
        {view === 'bookable' && (
          <>
            {types === null && <Loading />}
            {types !== null && types.length === 0 && !error && (
              <EmptyState title="No calendars yet" hint="Event types live in booking_event_types." />
            )}
            <div className="space-y-px">
              {(types || []).map((t) => (
                <section key={t.id} className="py-6 border-b border-white/[0.06] fade-in">
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
                        <p className="mt-1.5 text-[13px] text-zinc-500 max-w-2xl leading-relaxed">
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
                        {t.availability.length ? t.availability.join('  ·  ') : (
                          <span className="text-amber-300/70">no hours set</span>
                        )}
                      </div>
                    </div>

                    <div className="shrink-0 text-right">
                      <p className="text-[10px] uppercase tracking-wider text-zinc-600 mb-1.5">
                        Next openings
                      </p>
                      {t.next_slots.length === 0 ? (
                        <p className="text-[12px] text-zinc-600">none in 28 days</p>
                      ) : (
                        <ul className="space-y-0.5">
                          {t.next_slots.map((s) => (
                            <li key={s} className="text-[12px] tabular-nums text-zinc-300">
                              {slotLabel(s)}
                            </li>
                          ))}
                        </ul>
                      )}
                      <p className="mt-2 text-[11px] text-zinc-600 font-mono">{t.booking_url}</p>
                    </div>
                  </div>
                </section>
              ))}
            </div>
          </>
        )}

        {/* ── Booked: the diary ──────────────────────────────────────── */}
        {view === 'booked' && (
          <>
            {events === null && <Loading />}
            {events !== null && dayKeys.length === 0 && !error && (
              <EmptyState
                title={range === 'upcoming' ? 'Nothing booked in this window' : 'No calls in this window'}
                hint="Switch to Bookable to see the calendars people can book."
              />
            )}
            {dayKeys.map((k) => (
              <section key={k} className="mb-10 fade-in">
                <div className="flex items-baseline gap-3 border-b border-white/10 pb-2 mb-3">
                  <h2 className="text-[13px] font-semibold tracking-wide text-white">
                    {relativeDay(grouped[k][0].starts_at as string)}
                  </h2>
                  <span className="text-[11px] text-zinc-600">
                    {grouped[k].length} {grouped[k].length === 1 ? 'call' : 'calls'}
                  </span>
                </div>
                <ul className="space-y-px">
                  {grouped[k].map((e) => (
                    <li key={e.id} className="flex items-start gap-6 py-3 hover:bg-white/[0.02]">
                      <span className="w-28 shrink-0 text-[13px] tabular-nums text-zinc-300">
                        {time(e.starts_at)}
                        <span className="text-zinc-600"> – {time(e.ends_at)}</span>
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-[13px] text-white truncate">{e.title}</span>
                        <span className="block text-[11px] text-zinc-500 mt-0.5">{e.calendar}</span>
                      </span>
                      {e.location && /^https?:\/\//.test(e.location) && (
                        <a
                          href={e.location}
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
      </div>
    </div>
  );
}
