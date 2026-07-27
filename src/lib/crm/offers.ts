/**
 * Offer routing — picks which rung of YOUR value ladder a given lead should be
 * pointed at, so the Operator's copywriter never invents a destination or
 * pitches your top tier to someone who just joined the list.
 *
 * The ladder is entirely yours: it reads the `offers` table (active rows,
 * ordered by `position_in_ladder`, where 1 = entry offer). Add, reprice, or
 * reorder your offers and the routing follows — there is nothing to edit here.
 *
 * Routing signal is the lead's CRM score, which the scoring engine already
 * maintains from real behaviour (opens, clicks, replies, funnel steps). Cold
 * leads get your entry offer; warm leads get the middle of the ladder; the
 * genuinely hot get your top rung. If the offers table is empty, routing
 * returns a null offer and the copywriter falls back to your site.
 */
import type { AdminClient } from "./types";
import type { Tables } from "@/types/database";

type Lead = Tables<"leads">;
type Offer = Tables<"offers">;

export interface OfferRoute {
  /** Display name of the recommended offer, or a plain description if none. */
  tier: string;
  /** One line the copywriter can reason from — why this rung, for this lead. */
  reason: string;
  offer_slug: string | null;
  cta_url: string;
  price_display: string | null;
}

/**
 * Score bands → how far up the ladder to reach, as a fraction of its height.
 * Deliberately conservative: the top rung has to be earned.
 */
function ladderReach(score: number): { fraction: number; band: string } {
  if (score >= 60) return { fraction: 1, band: "highly engaged" };
  if (score >= 30) return { fraction: 0.66, band: "warm" };
  if (score >= 10) return { fraction: 0.33, band: "showing interest" };
  return { fraction: 0, band: "cold or brand new" };
}

/** Your site — the honest fallback when no offer matches. */
function siteUrl(): string {
  const base = (process.env.DIGITAL_HOME_URL || process.env.NEXT_PUBLIC_DIGITAL_HOME_URL || "").replace(/\/$/, "");
  return base || "/";
}

export async function routeOfferForLead(supabase: AdminClient, lead: Lead): Promise<OfferRoute> {
  const score = Number(lead.score ?? 0);
  const { fraction, band } = ladderReach(score);

  const { data: offers } = await supabase
    .from("offers")
    .select("slug, name, price_display, cta_url, position_in_ladder")
    .eq("status", "active")
    .order("position_in_ladder", { ascending: true, nullsFirst: false });

  // Only rows that declare a ladder position can be routed to; the rest are
  // still real offers, just not part of the ascending path.
  const ladder = (offers || []).filter(
    (o): o is Pick<Offer, "slug" | "name" | "price_display" | "cta_url"> & { position_in_ladder: number } =>
      o.position_in_ladder != null
  );

  if (!ladder.length) {
    return {
      tier: "no offer ladder configured",
      reason:
        "No active offers carry a ladder position — point them at the site and ask a question rather than pitching",
      offer_slug: null,
      cta_url: siteUrl(),
      price_display: null,
    };
  }

  const index = Math.min(ladder.length - 1, Math.round(fraction * (ladder.length - 1)));
  const match = ladder[index];

  return {
    tier: match.name,
    reason: `Lead is ${band} (score ${score}) — rung ${index + 1} of ${ladder.length} on your ladder`,
    offer_slug: match.slug,
    cta_url: match.cta_url || siteUrl(),
    price_display: match.price_display ?? null,
  };
}
