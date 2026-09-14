import { HOUSE_LOOKS, type HouseLook } from '@/lib/studio/house-looks';

export function HouseLookPreview({ look }: { look: HouseLook }) {
  const spec = HOUSE_LOOKS[look];
  return (
    <div className="rounded-lg border border-minimal-border bg-minimal-row px-4 py-3">
      <div className="text-[10px] uppercase tracking-[0.14em] text-minimal-muted">House look</div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-[16px] font-semibold">{spec.label}</span>
        <span className="text-[12px] text-minimal-muted">{spec.description}</span>
      </div>
    </div>
  );
}
