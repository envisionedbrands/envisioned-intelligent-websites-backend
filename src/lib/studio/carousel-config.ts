import 'server-only';
import { createAdminClient } from '@/lib/supabase/server';
import {
  CAROUSEL_CONFIG_KEY,
  resolveCarouselConfig,
  type CarouselConfig,
} from '@/lib/studio/carousel-template-registry';

type AdminClient = ReturnType<typeof createAdminClient>;

export type { CarouselConfig } from '@/lib/studio/carousel-template-registry';

export async function loadCarouselConfig(client?: AdminClient): Promise<CarouselConfig> {
  const supabase = client ?? createAdminClient();
  const { data, error } = await supabase
    .from('backend_settings')
    .select('key,value')
    .in('key', [CAROUSEL_CONFIG_KEY, 'content_house_look', 'carousel_renderer']);
  if (error) {
    return resolveCarouselConfig({
      factoryEnabled: process.env.CAROUSEL_FACTORY_ENABLED === 'true',
      unavailable: true,
    });
  }
  const settings = new Map((data ?? []).map((row) => [row.key, row.value]));
  return resolveCarouselConfig({
    canonicalValue: settings.has(CAROUSEL_CONFIG_KEY) ? settings.get(CAROUSEL_CONFIG_KEY) : undefined,
    legacyHouseLook: settings.get('content_house_look'),
    legacyRenderer: settings.get('carousel_renderer'),
    factoryEnabled: process.env.CAROUSEL_FACTORY_ENABLED === 'true',
  });
}
