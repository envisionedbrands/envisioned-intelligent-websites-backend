export type LatestRequestGate = {
  begin: () => number;
  isLatest: (requestId: number) => boolean;
  invalidate: () => void;
};

export function createLatestRequestGate(): LatestRequestGate {
  let latest = 0;
  return {
    begin: () => ++latest,
    isLatest: (requestId) => requestId === latest,
    invalidate: () => {
      latest++;
    },
  };
}
