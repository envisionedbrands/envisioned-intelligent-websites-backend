import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchNoteMetrics,
  findPostedNote,
  markdownToDoc,
  normalizeNoteText,
  noteExternalId,
  noteUrl,
  postNote,
  SubstackAuthError,
} from "./substack.ts";

type Call = { url: string; init: RequestInit };

/** Swap global fetch for one test; returns the recorded calls. */
function mockFetch(handler: (url: string, init: RequestInit) => { status?: number; body: unknown }): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const { status = 200, body } = handler(url, init);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return calls;
}

process.env.SUBSTACK_SID = "s%3Atest-cookie";

test("markdown becomes Substack's ProseMirror doc: paragraphs, hard breaks, bold, italic, links", () => {
  const doc = markdownToDoc("First line\nsame paragraph **bold**.\n\nSee https://envisioned.me. And *this*.") as {
    content: Array<{ type: string; content: Array<Record<string, unknown>> }>;
  };
  assert.equal(doc.content.length, 2);
  const [p1, p2] = doc.content;
  assert.deepEqual(p1.content[1], { type: "hard_break" });
  assert.deepEqual(p1.content.find((n) => n.text === "bold")?.marks, [{ type: "strong" }]);
  const link = p2.content.find((n) => Array.isArray(n.marks) && (n.marks as Array<{ type: string }>)[0].type === "link");
  // Sentence punctuation stays out of the URL.
  assert.equal(link?.text, "https://envisioned.me");
  assert.equal(p2.content.some((n) => n.text === "this" && JSON.stringify(n.marks) === '[{"type":"em"}]'), true);
});

test("note ids are stored prefixed and permalinks use them", () => {
  assert.equal(noteExternalId(352843879), "c-352843879");
  assert.equal(noteExternalId("c-352843879"), "c-352843879");
  assert.equal(noteUrl("mariainesai", "352843879"), "https://substack.com/@mariainesai/note/c-352843879");
});

test("normalised text ignores markup and spacing, so a re-check matches what Substack stored", () => {
  assert.equal(normalizeNoteText("**Hello**  world\n\nAgain"), normalizeNoteText("Hello world Again"));
});

test("postNote sends a browser User-Agent (Substack 429s without one) and the doc body", async () => {
  const calls = mockFetch(() => ({ body: { id: 999 } }));
  const result = await postNote("Hello **there**");
  assert.deepEqual(result, { id: "c-999" });
  const { url, init } = calls[0];
  assert.equal(url, "https://substack.com/api/v1/comment/feed");
  assert.equal(init.method, "POST");
  const headers = init.headers as Record<string, string>;
  assert.match(headers["User-Agent"], /Mozilla\/5\.0/);
  assert.equal(headers.Cookie, "substack.sid=s%3Atest-cookie");
  const body = JSON.parse(String(init.body));
  assert.equal(body.bodyJson.type, "doc");
  assert.equal(body.replyMinimumRole, "everyone");
});

test("a refused login surfaces as SubstackAuthError, not a generic failure", async () => {
  mockFetch(() => ({ status: 403, body: { error: "nope" } }));
  await assert.rejects(postNote("x"), SubstackAuthError);
});

test("findPostedNote adopts an identical Note posted after the scheduled time, ignores older and replies", async () => {
  const scheduled = "2026-10-05T07:00:00.000Z";
  mockFetch(() => ({
    body: {
      items: [
        { context: { type: "note" }, comment: { id: 3, body: "Same words", date: "2026-10-05T07:00:20Z", user_id: 1 } },
        { context: { type: "note" }, comment: { id: 2, body: "Same words", date: "2026-10-05T07:01:00Z", user_id: 1, ancestor_path: "9" } },
        { context: { type: "note" }, comment: { id: 1, body: "Same words", date: "2026-10-01T07:00:00Z", user_id: 1 } },
      ],
      nextCursor: null,
    },
  }));
  assert.equal(await findPostedNote(1, "**Same** words", scheduled), "c-3");
  assert.equal(await findPostedNote(1, "Different words", scheduled), null);
});

test("note_stats cards map onto the shared snapshot; subscriber names are not kept", async () => {
  mockFetch(() => ({
    body: {
      lastUpdatedAt: "2026-10-04T12:00:00Z",
      cards: [
        { type: "note", cardId: "note", note: { note: { like_count: 30, restack_count: 4, reply_count: 7 } } },
        { type: "graphCard", cardId: "impressions", headers: [{ title: "Impressions", value: 1156 }] },
        { type: "valueCard", cardId: "shareValues", headers: [{ title: "Shares", value: 3 }] },
        {
          type: "userCard",
          cardId: "new_subscribers",
          headers: [{ title: "New paid subs", value: 1 }, { title: "New free subs", value: 6 }],
          userLists: [{ label: "Free", users: [{ id: 5, name: "A Reader" }] }],
        },
        { type: "barList", cardId: "audience", items: [{ title: "Unconnected", value: 993 }, { title: "Subscribers", value: 61 }] },
        { type: "barList", cardId: "surfaces", items: [{ title: "Feed", value: 839 }] },
        { type: "listCard", cardId: "interactions", items: [{ title: "Link click", value: 89 }, { title: "Save", value: 2 }] },
      ],
    },
  }));
  const snap = await fetchNoteMetrics("c-299406668");
  assert.equal(snap.views, 1156);
  assert.equal(snap.likes, 30);
  assert.equal(snap.comments, 7);
  assert.equal(snap.shares, 7); // 4 restacks + 3 shares
  assert.equal(snap.saves, 2);
  assert.equal(snap.reach, 1054);
  assert.equal(snap.raw.new_free_subscribers, 6);
  assert.equal(snap.raw.new_paid_subscribers, 1);
  assert.equal(snap.raw.link_clicks, 89);
  assert.equal(JSON.stringify(snap.raw).includes("A Reader"), false);
});
