'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  api,
  EmptyState,
  Field,
  GhostBtn,
  leadName,
  Loading,
  Modal,
  PageHeader,
  PrimaryBtn,
  Select,
  StatusDot,
  TagChip,
  TextArea,
  TextInput,
  timeAgo,
  useToast,
} from '@/components/crm/kit';

type Lead = {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  source: string | null;
  status: string;
  email_status: string;
  tags: string[];
  score: number;
  last_activity_at: string;
  created_at: string;
};

const STATUSES = ['new', 'engaged', 'qualified', 'converted', 'lost'];

// Tags listed in backend_settings.crm_send_budget.suppress_tags — applying one
// of these stops every automated email to that person (see lib/crm/email.ts).
// Keep this in sync with that setting; it is display-only, the server decides.
const NO_EMAIL_TAGS = ['contact-only', 'peer', 'junk', 'internal'];

type SortMode = 'created_at' | 'score' | 'last_activity_at';

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: 'created_at', label: 'Newest leads' },
  { value: 'score', label: 'Hot / priority' },
  { value: 'last_activity_at', label: 'Recent activity' },
];

// Minimal CSV parser (quotes + commas), good enough for GHL/spreadsheet exports
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let cell = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') inQuotes = false;
      else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  if (rows.length < 2) return [];

  const headers = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return rows.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => (obj[h] = (r[i] || '').trim()));
    return obj;
  });
}

const HEADER_ALIASES: Record<string, string> = {
  email: 'email',
  email_address: 'email',
  first_name: 'first_name',
  firstname: 'first_name',
  last_name: 'last_name',
  lastname: 'last_name',
  name: 'name',
  full_name: 'name',
  contact_name: 'name',
  phone: 'phone',
  phone_number: 'phone',
  company: 'company',
  company_name: 'company',
  business_name: 'company',
  tags: 'tags',
};

export default function LeadsPage() {
  const router = useRouter();
  const { show, node: toastNode } = useToast();
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [sort, setSort] = useState<SortMode>('created_at');
  const [tags, setTags] = useState<{ name: string; count: number }[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showTag, setShowTag] = useState(false);
  const [tagValue, setTagValue] = useState('');
  const [tagging, setTagging] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(
    async (opts?: { page?: number; q?: string; status?: string; tag?: string; sort?: SortMode }) => {
      const p = opts?.page ?? page;
      const qq = opts?.q ?? q;
      const st = opts?.status ?? status;
      const tg = opts?.tag ?? tagFilter;
      const so = opts?.sort ?? sort;
      const params = new URLSearchParams({ page: String(p), limit: '25', sort: so, dir: 'desc' });
      if (qq) params.set('q', qq);
      if (st) params.set('status', st);
      if (tg) params.set('tag', tg);
      try {
        const res = await api<{ data: Lead[]; total: number }>(`/api/crm/leads?${params}`);
        setLeads(res.data);
        setTotal(res.total);
      } catch (e) {
        show(e instanceof Error ? e.message : 'Failed to load leads', 'err');
        setLeads([]);
      }
    },
    [page, q, status, tagFilter, sort, show]
  );

  useEffect(() => {
    load();
    api<{ tags: { name: string; count: number }[] }>('/api/crm/tags')
      .then((r) => setTags(r.tags))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSearch = (value: string) => {
    setQ(value);
    setPage(1);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => load({ page: 1, q: value }), 300);
  };

  const totalPages = Math.max(1, Math.ceil(total / 25));

  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allOnPageSelected = !!leads?.length && leads.every((l) => selected.has(l.id));
  const toggleAllOnPage = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) leads?.forEach((l) => next.delete(l.id));
      else leads?.forEach((l) => next.add(l.id));
      return next;
    });

  // Adds one tag to every selected lead, preserving tags they already have.
  // PATCH replaces the whole tags array, so each lead's current tags are read
  // first — from this page's data when possible, otherwise fetched.
  const applyTagToSelected = async () => {
    const tag = tagValue.trim();
    if (!tag) return;
    setTagging(true);
    const ids = [...selected];
    let ok = 0;
    const failed: string[] = [];
    for (const id of ids) {
      try {
        let current = leads?.find((l) => l.id === id)?.tags;
        if (!current) {
          const res = await api<{ lead: { tags: string[] } }>(`/api/crm/leads/${id}`);
          current = res.lead.tags || [];
        }
        if (!current.includes(tag)) {
          await api(`/api/crm/leads/${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ tags: [...current, tag] }),
          });
        }
        ok++;
      } catch {
        failed.push(id);
      }
    }
    setTagging(false);
    setShowTag(false);
    setTagValue('');
    setSelected(new Set(failed));
    if (failed.length) show(`Tagged ${ok}, failed ${failed.length}`, 'err');
    else show(`Tagged ${ok} with "${tag}"`);
    load();
    api<{ tags: { name: string; count: number }[] }>('/api/crm/tags')
      .then((r) => setTags(r.tags))
      .catch(() => {});
  };

  // Hard delete: removes the lead and its email history (see DELETE /api/crm/leads/[id]).
  // Deletes one at a time so a single failure doesn't hide the rest.
  const deleteSelected = async () => {
    setDeleting(true);
    const ids = [...selected];
    const failed: string[] = [];
    for (const id of ids) {
      try {
        await api(`/api/crm/leads/${id}`, { method: 'DELETE' });
      } catch {
        failed.push(id);
      }
    }
    setDeleting(false);
    setConfirmDelete(false);
    setSelected(new Set(failed));
    const removed = ids.length - failed.length;
    if (failed.length) show(`Deleted ${removed}, failed ${failed.length}`, 'err');
    else show(`Deleted ${removed} ${removed === 1 ? 'lead' : 'leads'}`);
    load();
  };

  return (
    <div className="flex flex-col h-full">
      {toastNode}
      <PageHeader title={`Leads · ${total}`}>
        {selected.size > 0 && (
          <>
            <span className="text-[13px] text-minimal-muted mr-1">{selected.size} selected</span>
            <GhostBtn onClick={() => setSelected(new Set())}>Clear</GhostBtn>
            <GhostBtn onClick={() => setShowTag(true)}>Tag</GhostBtn>
            <GhostBtn danger onClick={() => setConfirmDelete(true)}>
              Delete {selected.size}
            </GhostBtn>
          </>
        )}
        <GhostBtn onClick={() => setShowImport(true)}>Import CSV</GhostBtn>
        <PrimaryBtn onClick={() => setShowAdd(true)}>Add lead</PrimaryBtn>
      </PageHeader>

      {/* Filters */}
      <div className="px-12 pb-4 flex items-center gap-3 shrink-0">
        <div className="w-72">
          <TextInput placeholder="Search email, name, company…" value={q} onChange={(e) => onSearch(e.target.value)} />
        </div>
        <div className="w-44">
          <Select
            value={sort}
            aria-label="Sort leads"
            onChange={(e) => {
              const nextSort = e.target.value as SortMode;
              setSort(nextSort);
              setPage(1);
              load({ page: 1, sort: nextSort });
            }}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-40">
          <Select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
              load({ page: 1, status: e.target.value });
            }}
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-48">
          <Select
            value={tagFilter}
            onChange={(e) => {
              setTagFilter(e.target.value);
              setPage(1);
              load({ page: 1, tag: e.target.value });
            }}
          >
            <option value="">All tags</option>
            {tags.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name} ({t.count})
              </option>
            ))}
          </Select>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto px-12 pb-12">
        {leads === null ? (
          <Loading />
        ) : leads.length === 0 ? (
          <EmptyState
            title="No leads yet"
            hint="Leads flow in from your site forms and the capture API — or add one manually / import your GHL export."
          />
        ) : (
          <div className="border border-minimal-border rounded-lg overflow-hidden">
            <table className="w-full text-left">
              <thead>
                <tr className="text-xs text-minimal-muted border-b border-minimal-border">
                  <th className="pl-5 pr-0 py-3 w-8">
                    <input
                      type="checkbox"
                      aria-label="Select all on this page"
                      checked={allOnPageSelected}
                      onChange={toggleAllOnPage}
                      className="cursor-pointer align-middle"
                    />
                  </th>
                  <th className="px-5 py-3 font-medium">Lead</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium text-right">Score</th>
                  <th className="px-5 py-3 font-medium">Tags</th>
                  <th className="px-5 py-3 font-medium">Source</th>
                  <th className="px-5 py-3 font-medium text-right">Last activity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-minimal-border">
                {leads.map((lead) => (
                  <tr
                    key={lead.id}
                    onClick={() => router.push(`/crm/leads/${lead.id}`)}
                    className="cursor-pointer hover:bg-minimal-row transition-colors"
                  >
                    {/* stopPropagation so ticking the box doesn't open the lead */}
                    <td className="pl-5 pr-0 py-3.5 w-8" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${lead.email}`}
                        checked={selected.has(lead.id)}
                        onChange={() => toggleOne(lead.id)}
                        className="cursor-pointer align-middle"
                      />
                    </td>
                    <td className="px-5 py-3.5">
                      <p className="text-sm text-white">{leadName(lead)}</p>
                      <p className="text-xs text-zinc-600">
                        {lead.email}
                        {lead.email_status !== 'subscribed' && (
                          <span className="ml-2 text-red-400/80 text-xs">
                            {lead.email_status}
                          </span>
                        )}
                      </p>
                    </td>
                    <td className="px-5 py-3.5">
                      <StatusDot status={lead.status} />
                    </td>
                    <td className="px-5 py-3.5 text-[13px] text-zinc-400 text-right tabular-nums">
                      {lead.score}
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex flex-wrap gap-1.5 max-w-56">
                        {lead.tags.slice(0, 3).map((t) => (
                          <TagChip key={t} tag={t} />
                        ))}
                        {lead.tags.length > 3 && (
                          <span className="text-xs text-zinc-600">+{lead.tags.length - 3}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-3.5 text-[13px] text-zinc-500">{lead.source || '—'}</td>
                    <td className="px-5 py-3.5 text-[13px] text-zinc-500 text-right">
                      {timeAgo(lead.last_activity_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-end gap-4 mt-4 text-xs text-minimal-muted">
            <button
              disabled={page <= 1}
              onClick={() => {
                setPage(page - 1);
                load({ page: page - 1 });
              }}
              className="disabled:opacity-30 hover:text-white"
            >
              ← Prev
            </button>
            <span>
              {page} / {totalPages}
            </span>
            <button
              disabled={page >= totalPages}
              onClick={() => {
                setPage(page + 1);
                load({ page: page + 1 });
              }}
              className="disabled:opacity-30 hover:text-white"
            >
              Next →
            </button>
          </div>
        )}
      </div>

      {showTag && (
        <Modal
          title={`Tag ${selected.size} ${selected.size === 1 ? 'lead' : 'leads'}`}
          onClose={() => setShowTag(false)}
        >
          <div className="space-y-4">
            <div>
              <p className="text-[13px] font-medium text-zinc-300 mb-2">Stops all automated email</p>
              <div className="flex flex-wrap gap-2">
                {NO_EMAIL_TAGS.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTagValue(t)}
                    className={`text-xs px-2.5 py-1 rounded-md border transition-colors ${
                      tagValue === t
                        ? 'border-red-500/50 text-red-300 bg-red-500/10'
                        : 'border-minimal-border text-zinc-400 hover:text-white'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
              <p className="text-xs text-zinc-600 mt-2">
                Use <span className="text-zinc-400">contact-only</span> for peers and people you know
                personally — they stay in the CRM, they never get a campaign.
              </p>
            </div>

            {tags.length > 0 && (
              <div>
                <p className="text-[13px] font-medium text-zinc-300 mb-2">Existing tags</p>
                <div className="flex flex-wrap gap-2 max-h-28 overflow-y-auto">
                  {tags
                    .filter((t) => !NO_EMAIL_TAGS.includes(t.name))
                    .map((t) => (
                      <button
                        key={t.name}
                        type="button"
                        onClick={() => setTagValue(t.name)}
                        className={`text-xs px-2.5 py-1 rounded-md border transition-colors ${
                          tagValue === t.name
                            ? 'border-zinc-400 text-white'
                            : 'border-minimal-border text-zinc-500 hover:text-white'
                        }`}
                      >
                        {t.name}
                      </button>
                    ))}
                </div>
              </div>
            )}

            <Field label="Tag to apply" hint="Pick one above or type a new one. Existing tags are kept.">
              <TextInput
                autoFocus
                value={tagValue}
                onChange={(e) => setTagValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && tagValue.trim() && !tagging) applyTagToSelected();
                }}
                placeholder="e.g. peer"
              />
            </Field>

            {NO_EMAIL_TAGS.includes(tagValue.trim()) && (
              <p className="text-xs text-amber-400/80">
                These {selected.size === 1 ? 'person' : 'people'} will be skipped by every email
                workflow from now on.
              </p>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <GhostBtn onClick={() => setShowTag(false)} disabled={tagging}>
                Cancel
              </GhostBtn>
              <PrimaryBtn onClick={applyTagToSelected} disabled={tagging || !tagValue.trim()}>
                {tagging ? 'Tagging…' : `Tag ${selected.size}`}
              </PrimaryBtn>
            </div>
          </div>
        </Modal>
      )}

      {confirmDelete && (
        <Modal title={`Delete ${selected.size} ${selected.size === 1 ? 'lead' : 'leads'}?`} onClose={() => setConfirmDelete(false)}>
          <p className="text-[14px] text-zinc-300 leading-relaxed">
            This permanently removes {selected.size === 1 ? 'this person' : 'these people'} and their email
            history. It cannot be undone.
          </p>
          <div className="mt-4 max-h-48 overflow-y-auto border border-minimal-border rounded-lg divide-y divide-minimal-border">
            {leads
              ?.filter((l) => selected.has(l.id))
              .map((l) => (
                <p key={l.id} className="px-3 py-2 text-[13px] text-zinc-400">
                  {l.email}
                </p>
              ))}
          </div>
          {leads && [...selected].some((id) => !leads.find((l) => l.id === id)) && (
            <p className="mt-3 text-xs text-amber-400/80">
              Some selected leads are on other pages and are not listed above, but will be deleted.
            </p>
          )}
          <div className="flex justify-end gap-2 mt-6">
            <GhostBtn onClick={() => setConfirmDelete(false)} disabled={deleting}>
              Cancel
            </GhostBtn>
            <GhostBtn danger onClick={deleteSelected} disabled={deleting}>
              {deleting ? 'Deleting…' : `Delete ${selected.size}`}
            </GhostBtn>
          </div>
        </Modal>
      )}

      {showAdd && (
        <AddLeadModal
          onClose={() => setShowAdd(false)}
          onCreated={(id) => {
            setShowAdd(false);
            router.push(`/crm/leads/${id}`);
          }}
          onError={(m) => show(m, 'err')}
        />
      )}
      {showImport && (
        <ImportModal
          onClose={() => setShowImport(false)}
          onDone={(msg) => {
            setShowImport(false);
            show(msg);
            load({ page: 1 });
          }}
          onError={(m) => show(m, 'err')}
        />
      )}
    </div>
  );
}

function AddLeadModal({
  onClose,
  onCreated,
  onError,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
  onError: (m: string) => void;
}) {
  const [form, setForm] = useState({ email: '', first_name: '', last_name: '', phone: '', company: '', tags: '' });
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      const res = await api<{ lead: { id: string } }>('/api/crm/leads', {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          tags: form.tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          source: 'manual',
        }),
      });
      onCreated(res.lead.id);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Create failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Add lead" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Field label="Email">
          <TextInput
            autoFocus
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            placeholder="lead@example.com"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name">
            <TextInput value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} />
          </Field>
          <Field label="Last name">
            <TextInput value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Phone">
            <TextInput value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </Field>
          <Field label="Company">
            <TextInput value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
          </Field>
        </div>
        <Field label="Tags" hint="Comma separated — tag triggers fire on save">
          <TextInput value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="warm, workshop" />
        </Field>
        <div className="flex justify-end gap-3 mt-2">
          <GhostBtn onClick={onClose}>Cancel</GhostBtn>
          <PrimaryBtn onClick={submit} disabled={saving || !form.email}>
            {saving ? 'Saving…' : 'Create lead'}
          </PrimaryBtn>
        </div>
      </div>
    </Modal>
  );
}

function ImportModal({
  onClose,
  onDone,
  onError,
}: {
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (m: string) => void;
}) {
  const [csvText, setCsvText] = useState('');
  const [tag, setTag] = useState('imported');
  const [fireTriggers, setFireTriggers] = useState(false);
  const [preview, setPreview] = useState<Record<string, string>[]>([]);
  const [importing, setImporting] = useState(false);

  const parse = (text: string) => {
    setCsvText(text);
    setPreview(parseCsv(text).slice(0, 1000));
  };

  const onFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => parse(String(reader.result || ''));
    reader.readAsText(file);
  };

  const mappedRows = preview
    .map((raw) => {
      const row: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(raw)) {
        const target = HEADER_ALIASES[k];
        if (target && v) row[target] = target === 'tags' ? v.split(/[,;]/).map((t) => t.trim()) : v;
      }
      return row;
    })
    .filter((r) => typeof r.email === 'string' && r.email);

  const run = async () => {
    setImporting(true);
    try {
      let created = 0;
      let updated = 0;
      for (let i = 0; i < mappedRows.length; i += 250) {
        const res = await api<{ created: number; updated: number }>('/api/crm/leads/import', {
          method: 'POST',
          body: JSON.stringify({
            rows: mappedRows.slice(i, i + 250),
            tag: tag.trim() || undefined,
            source: 'csv-import',
            fire_triggers: fireTriggers,
          }),
        });
        created += res.created;
        updated += res.updated;
      }
      onDone(`Imported: ${created} new, ${updated} updated`);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal title="Import leads (CSV)" onClose={onClose} wide>
      <div className="flex flex-col gap-4">
        <Field label="CSV file" hint="Works with a GoHighLevel contact export — headers are auto-mapped (email, first name, last name, phone, company, tags)">
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
            className="block w-full text-[13px] text-zinc-400 file:mr-3 file:px-3 file:py-1.5 file:border file:border-minimal-border file:bg-minimal-row file:text-zinc-300 file:text-xs file:file:file:rounded-lg file:cursor-pointer"
          />
        </Field>
        <Field label="Or paste CSV">
          <TextArea rows={4} value={csvText} onChange={(e) => parse(e.target.value)} placeholder="email,first_name,last_name…" />
        </Field>
        <div className="grid grid-cols-2 gap-3 items-end">
          <Field label="Tag everyone with" hint="Handy for segmenting this import later">
            <TextInput value={tag} onChange={(e) => setTag(e.target.value)} />
          </Field>
          <label className="flex items-center gap-2.5 pb-2 cursor-pointer">
            <input type="checkbox" checked={fireTriggers} onChange={(e) => setFireTriggers(e.target.checked)} />
            <span className="text-xs text-zinc-400 leading-snug">
              Fire workflow triggers <span className="text-zinc-600">(off = imported contacts won&apos;t get welcome sequences)</span>
            </span>
          </label>
        </div>
        {preview.length > 0 && (
          <p className="text-[13px] text-zinc-400">
            {mappedRows.length} rows with a valid email detected (of {preview.length} parsed).
          </p>
        )}
        <div className="flex justify-end gap-3">
          <GhostBtn onClick={onClose}>Cancel</GhostBtn>
          <PrimaryBtn onClick={run} disabled={importing || mappedRows.length === 0}>
            {importing ? 'Importing…' : `Import ${mappedRows.length} leads`}
          </PrimaryBtn>
        </div>
      </div>
    </Modal>
  );
}
