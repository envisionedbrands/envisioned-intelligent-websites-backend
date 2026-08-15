'use client';

/**
 * /crm/calendar — the week, read live from GHL (booking's source of truth).
 * Read-only on purpose: bookings are created and changed in GHL, the Studio
 * just shows them next to the leads and pipeline they belong to.
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
  contact_id: string | null;
};

const DAY_FMT: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long' };

function dayKey(iso: string) {
  return new Date(iso).toISOString().slice(0, 10);
}

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
  return d.toLocaleDateString('en-GB', DAY_FMT);
}

export default function CalendarPage() {
  const [events, setEvents] = useState<Ev[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<'upcoming' | 'past'>('upcoming');
  const [days, setDays] = useState(14);

  const load = useCallback(async () => {
    setEvents(null);
    setError(null);
    try {
      const res = await api<{ events: Ev[]; calendars_scanned: number }>(
        `/api/crm/calendar?days=${days}&range=${range}`
      );
      setEvents(res.events);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach GHL');
      setEvents([]);
    }
  }, [days, range]);

  useEffect(() => {
    void load();
  }, [load]);

  const grouped: Record<string, Ev[]> = {};
  (events || []).forEach((e) => {
    if (!e.starts_at) return;
    const k = dayKey(e.starts_at);
    (grouped[k] ||= []).push(e);
  });
  const dayKeys = Object.keys(grouped).sort((a, b) =>
    range === 'past' ? b.localeCompare(a) : a.localeCompare(b)
  );

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Calendar">
        <div className="flex items-center gap-2">
          <GhostBtn onClick={() => setRange(range === 'upcoming' ? 'past' : 'upcoming')}>
            {range === 'upcoming' ? 'Upcoming' : 'Past'}
          </GhostBtn>
          <GhostBtn onClick={() => setDays(days === 14 ? 60 : 14)}>{days} days</GhostBtn>
          <GhostBtn onClick={() => void load()}>Refresh</GhostBtn>
        </div>
      </PageHeader>

      <div className="flex-1 overflow-y-auto px-12 pb-16">
        {events === null && <Loading />}

        {error && (
          <div className="mb-6 border border-amber-500/25 bg-amber-500/5 px-4 py-3 text-[13px] text-amber-300/90">
            {error}
          </div>
        )}

        {events !== null && dayKeys.length === 0 && !error && (
          <EmptyState
            title={range === 'upcoming' ? 'Nothing booked in this window' : 'No calls in this window'}
            hint="Bookings live in GHL — this reads them live. Widen the window or check the range toggle."
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
                <li
                  key={e.id}
                  className="flex items-start gap-6 py-3 hover:bg-white/[0.02] transition-colors"
                >
                  <span className="w-28 shrink-0 text-[13px] tabular-nums text-zinc-300">
                    {time(e.starts_at)}
                    <span className="text-zinc-600"> – {time(e.ends_at)}</span>
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-[13px] text-white truncate">{e.title}</span>
                    <span className="block text-[11px] text-zinc-500 mt-0.5">
                      {e.calendar}
                      {e.status && e.status.toLowerCase() !== 'confirmed' ? ` · ${e.status}` : ''}
                    </span>
                  </span>
                  {e.location && /^https?:\/\//.test(e.location) && (
                    <a
                      href={e.location}
                      target="_blank"
                      rel="noreferrer"
                      className="shrink-0 text-[11px] text-zinc-500 hover:text-white transition-colors"
                    >
                      Join ↗
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
