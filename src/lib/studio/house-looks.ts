export const HOUSE_LOOKS = {
  cobalt: {
    label: 'Cobalt',
    description: 'Architectural premium: dark, quiet and expensive.',
  },
  editorial: {
    label: 'Editorial',
    description: 'Serif thought leadership: credible, measured field notes.',
  },
  explainer: {
    label: 'Explainer',
    description: 'Bold educational cards: warm, direct and easy to follow.',
  },
  manifesto: {
    label: 'Manifesto',
    description: 'Bold point of view: black, condensed and unapologetic.',
  },
  threshold: {
    label: 'Threshold',
    description: 'Warm inner-work editorial: reflective and quietly human.',
  },
} as const;

export type HouseLook = keyof typeof HOUSE_LOOKS;
export type CarouselRenderer = 'content_manager' | 'factory';

export function isHouseLook(value: unknown): value is HouseLook {
  return typeof value === 'string' && Object.hasOwn(HOUSE_LOOKS, value);
}

export function isCarouselRenderer(value: unknown): value is CarouselRenderer {
  return value === 'content_manager' || value === 'factory';
}
