/** Deterministic desk naming: no extra model call, no invented job title. */
export const isDefaultDeskName = (name: string) => /^New desk(?: \d+)?$/i.test(name.trim());

const JOB_TITLES: { pattern: RegExp; title: string }[] = [
  { pattern: /\bthumbnail(s| concepts?)?\b/i, title: "Thumbnail Concepts" },
  { pattern: /\b(hook|hooks|openers?)\b/i, title: "Hook Writer" },
  { pattern: /\bcarousel(s| slides?)?\b/i, title: "Carousel Draft" },
  { pattern: /\b(article|blog)\b.*\b(angle|topic|idea)s?\b|\b(angle|topic)s?\b.*\b(article|blog)\b/i, title: "Article Angles" },
  { pattern: /\b(newsletter|email)\b/i, title: "Newsletter Email" },
  { pattern: /\b(why (it|this) worked|break ?down|analysis|analy[sz]e)\b/i, title: "Content Breakdown" },
  { pattern: /\b(research|find sources|investigate)\b/i, title: "Research Desk" },
  { pattern: /\b(script|screenplay|voiceover)\b/i, title: "Script Writer" },
  { pattern: /\b(caption|social post)\b/i, title: "Social Caption" },
  { pattern: /\b(summary|summari[sz]e|condense)\b/i, title: "Summary Desk" },
];

const titleCase = (word: string) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();

const GENERIC_HANDOFF = /fresh input (?:was|has been) just wired in from the previous desk/i;

export function suggestDeskTitle(message: string): string | null {
  // The relay kickoff describes plumbing, not the job. Leaving the default in
  // place is more honest than naming a desk “Fresh Input Was Just Desk”; the
  // next substantive request (or an explicit human rename) can name it.
  if (GENERIC_HANDOFF.test(message)) return null;
  const clean = message
    .replace(/@"[^"]+"/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^A-Za-z0-9' -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const job of JOB_TITLES) if (job.pattern.test(clean)) return job.title;

  const words = clean
    .split(" ")
    .filter(Boolean)
    .filter((word) => !/^(a|an|the|please|can|could|would|will|give|make|create|write|turn|me|my|our|your|this|these|that|from|for|with|into|and|or|to|of|on|in|was|were|is|are|be|been|just|now)$/i.test(word))
    .slice(0, 4)
    .map(titleCase);
  return words.length ? `${words.join(" ")} Desk`.slice(0, 48) : null;
}
