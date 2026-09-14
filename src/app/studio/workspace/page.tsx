import { StudioWorkspace } from '@/components/studio/studio-workspace';

// The board id lives in the URL hash, so every board shares this one static
// HTML shell. Cloudflare serves it as an asset; the browser loads the canvas
// and authenticated data after paint.
export const dynamic = 'force-static';

export default function StudioWorkspacePage() {
  return <StudioWorkspace />;
}
