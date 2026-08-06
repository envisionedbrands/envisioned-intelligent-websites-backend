import type { Lead } from "./types";

/**
 * Merge-tag rendering for emails and messages.
 * Supports {{first_name}}, {{last_name}}, {{full_name}}, {{email}}, {{phone}},
 * {{company}}, {{custom.<key>}}, {{unsubscribe_url}} and fallback syntax
 * {{first_name|there}} (used when the value is empty).
 */
const TAG_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*(?:\|([^}]*))?\s*\}\}/g;

function siteBase(): string {
  const base =
    process.env.DIGITAL_HOME_URL ||
    process.env.NEXT_PUBLIC_DIGITAL_HOME_URL ||
    "https://www.yourdomain.com";
  return base.replace(/\/$/, "");
}

/** The human-facing link in the email footer. Lands on a page that ASKS first.
 *  Mail scanners follow every link in an email, so a one-step GET would
 *  unsubscribe people who never clicked. */
export function unsubscribeUrl(lead: Pick<Lead, "unsubscribe_token">): string {
  return `${siteBase()}/unsubscribe?t=${lead.unsubscribe_token}`;
}

/** The RFC 8058 one-click target for the List-Unsubscribe-Post header.
 *  Gmail and Yahoo POST here directly and expect a 2xx, so it must be a route
 *  handler and NOT a page - a Next page cannot answer POST and would return
 *  405, which mailbox providers record as a failed unsubscribe. */
export function unsubscribeOneClickUrl(lead: Pick<Lead, "unsubscribe_token">): string {
  return `${siteBase()}/api/unsubscribe?t=${lead.unsubscribe_token}`;
}

export function mergeValues(lead: Lead, extra: Record<string, string> = {}): Record<string, string> {
  const custom = (lead.custom && typeof lead.custom === "object" ? lead.custom : {}) as Record<string, unknown>;
  const values: Record<string, string> = {
    first_name: lead.first_name || "",
    last_name: lead.last_name || "",
    full_name: [lead.first_name, lead.last_name].filter(Boolean).join(" "),
    email: lead.email,
    phone: lead.phone || "",
    company: lead.company || "",
    unsubscribe_url: unsubscribeUrl(lead),
    ...extra,
  };
  for (const [k, v] of Object.entries(custom)) {
    values[`custom.${k}`] = v == null ? "" : String(v);
  }
  return values;
}

export function renderMergeTags(
  text: string,
  lead: Lead,
  extra: Record<string, string> = {},
  opts: { keepUnknownTags?: boolean } = {}
): string {
  const values = mergeValues(lead, extra);
  return text.replace(TAG_RE, (match, key: string, fallback?: string) => {
    const value = values[key];
    if (value) return value;
    if (fallback !== undefined) return fallback;
    // Previews/tests keep unrecognized tags visible so a typo'd tag reads as
    // "{{firstname}}" instead of silently vanishing; live sends blank them.
    if (opts.keepUnknownTags && !(key in values)) return match;
    return "";
  });
}

/** Sample lead for template previews and test sends — lets the REAL merge
 *  engine run so every tag renders exactly as it would on a live send. */
export function previewLead(): Lead {
  return {
    id: "preview",
    email: "alex@example.com",
    first_name: "Alex",
    last_name: "Rivera",
    phone: "",
    company: "Rivera Coaching",
    unsubscribe_token: "preview",
    custom: {},
  } as unknown as Lead;
}
