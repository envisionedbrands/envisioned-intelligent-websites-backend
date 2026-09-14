/**
 * PostgREST installations commonly cap a response at 1,000 rows. Keep every
 * id-filtered verification query comfortably below that ceiling, then compare
 * the server's exact count with the rows that actually arrived.
 */
export const STUDIO_QUERY_BATCH_SIZE = 200;
export const STUDIO_QUERY_PAGE_SIZE = 500;

export type ExactStudioQueryResult<Row> = {
  data: Row[] | null;
  error: { message: string } | null;
  count: number | null;
};

export function chunkStudioQueryIds(ids: readonly string[], size = STUDIO_QUERY_BATCH_SIZE): string[][] {
  if (!Number.isSafeInteger(size) || size < 1) throw new Error("Studio query batch size must be positive");
  const chunks: string[][] = [];
  for (let offset = 0; offset < ids.length; offset += size) {
    chunks.push(ids.slice(offset, offset + size));
  }
  return chunks;
}

/**
 * Verifies an id-filtered query where some requested ids may not exist yet.
 * `exactCount` comes from PostgREST's `count: "exact"`; comparing it with the
 * returned rows detects response truncation instead of treating it as absence.
 */
export function isExactStudioQuerySubset<Row extends { id: string }>(
  requestedIds: readonly string[],
  rows: readonly Row[] | null,
  exactCount: number | null,
): rows is readonly Row[] {
  if (rows === null || exactCount === null || exactCount !== rows.length) return false;
  const requested = new Set(requestedIds);
  const returned = new Set<string>();
  for (const row of rows) {
    if (!requested.has(row.id) || returned.has(row.id)) return false;
    returned.add(row.id);
  }
  return true;
}

/** Verifies a query where every requested persisted row must be present. */
export function isExactStudioQueryMatch<Row extends { id: string }>(
  requestedIds: readonly string[],
  rows: readonly Row[] | null,
  exactCount: number | null,
): rows is readonly Row[] {
  return (
    exactCount === requestedIds.length
    && isExactStudioQuerySubset(requestedIds, rows, exactCount)
    && rows.length === requestedIds.length
  );
}

/**
 * Read a complete, stably ordered relation past PostgREST's response cap.
 * Every page repeats the exact count, and duplicate/short/missing pages fail
 * closed instead of turning an incomplete graph into an empty one.
 */
export async function readExactStudioPages<Row extends { id: string }>(
  fetchPage: (from: number, to: number) => PromiseLike<ExactStudioQueryResult<Row>>,
): Promise<Row[] | null> {
  const rows: Row[] = [];
  const returnedIds = new Set<string>();
  let expectedCount: number | null = null;

  for (let from = 0; ; from += STUDIO_QUERY_PAGE_SIZE) {
    let result: ExactStudioQueryResult<Row>;
    try {
      result = await fetchPage(from, from + STUDIO_QUERY_PAGE_SIZE - 1);
    } catch {
      return null;
    }
    if (result.error || result.count === null) return null;
    if (expectedCount === null) expectedCount = result.count;
    if (result.count !== expectedCount) return null;

    const page = result.data ?? [];
    for (const row of page) {
      if (returnedIds.has(row.id)) return null;
      returnedIds.add(row.id);
      rows.push(row);
    }

    if (rows.length === expectedCount) return rows;
    if (rows.length > expectedCount || page.length === 0 || page.length < STUDIO_QUERY_PAGE_SIZE) {
      return null;
    }
  }
}

/** Read id-filtered rows in sub-cap batches and require every requested id. */
export async function readExactStudioMatchBatches<Row extends { id: string }>(
  ids: readonly string[],
  fetchBatch: (ids: string[]) => PromiseLike<ExactStudioQueryResult<Row>>,
): Promise<Row[] | null> {
  const rows: Row[] = [];
  const returnedIds = new Set<string>();
  for (const batch of chunkStudioQueryIds(ids)) {
    let result: ExactStudioQueryResult<Row>;
    try {
      result = await fetchBatch(batch);
    } catch {
      return null;
    }
    if (result.error || !isExactStudioQueryMatch(batch, result.data, result.count)) return null;
    for (const row of result.data) {
      if (returnedIds.has(row.id)) return null;
      returnedIds.add(row.id);
      rows.push(row);
    }
  }
  return rows;
}
