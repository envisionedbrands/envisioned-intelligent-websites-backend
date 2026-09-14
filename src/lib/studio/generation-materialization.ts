/**
 * Stable canvas identities for one generation result.
 *
 * React is allowed to replay functional state updaters. A random UUID created
 * inside an updater can therefore disagree with an edge scheduled by the first
 * pass. These ids are deterministic for (job, result index, entity kind), so a
 * poll, a remount, and an updater replay all converge on the same graph rows.
 * They are identity keys only, never security tokens.
 */
const hashLane = (value: string, seed: number) => {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
    hash ^= hash >>> 13;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

export function stableGenerationEntityId(
  jobId: string,
  resultIndex: number,
  entity: "node" | "edge",
): string {
  const seed = `studio-generation:${entity}:${jobId}:${Math.max(0, Math.floor(resultIndex))}`;
  const raw = [
    hashLane(seed, 0x811c9dc5),
    hashLane(seed, 0x9e3779b9),
    hashLane(seed, 0x85ebca6b),
    hashLane(seed, 0xc2b2ae35),
  ].join("");
  const hex = `${raw.slice(0, 12)}5${raw.slice(13, 16)}a${raw.slice(17)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
