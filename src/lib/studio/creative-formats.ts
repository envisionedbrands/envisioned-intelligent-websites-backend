export type CreativeFormatKey =
  | "youtube_thumbnail"
  | "square"
  | "feed_portrait"
  | "story"
  | "landscape"
  | "match_reference"
  | "custom";

export type CreativeImageSize =
  | "auto"
  | "square_hd"
  | "landscape_4_3"
  | { width: number; height: number };

export const CREATIVE_FORMATS: Record<
  CreativeFormatKey,
  { label: string; shortLabel: string; detail: string; imageSize: CreativeImageSize | null }
> = {
  youtube_thumbnail: {
    label: "YouTube thumbnail",
    shortLabel: "YouTube",
    detail: "16:9 · 1280×720",
    imageSize: { width: 1280, height: 720 },
  },
  square: {
    label: "Square post or ad",
    shortLabel: "Square",
    detail: "1:1 · 1024×1024",
    imageSize: "square_hd",
  },
  feed_portrait: {
    label: "Feed portrait",
    shortLabel: "Portrait",
    detail: "4:5 · 1024×1280",
    imageSize: { width: 1024, height: 1280 },
  },
  story: {
    label: "Story or Reel",
    shortLabel: "Story",
    detail: "9:16 · 720×1280",
    imageSize: { width: 720, height: 1280 },
  },
  landscape: {
    label: "Landscape graphic",
    shortLabel: "Landscape",
    detail: "4:3 · 1024×768",
    imageSize: "landscape_4_3",
  },
  match_reference: {
    label: "Match reference",
    shortLabel: "Reference",
    detail: "Uses the reference image ratio",
    imageSize: "auto",
  },
  custom: {
    label: "Custom dimensions",
    shortLabel: "Custom",
    detail: "Width and height in pixels",
    imageSize: null,
  },
};

export const isCreativeFormatKey = (value: unknown): value is CreativeFormatKey =>
  typeof value === "string" && Object.hasOwn(CREATIVE_FORMATS, value);

export function validateCustomImageSize(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return "Width and height must be whole numbers.";
  if (width % 16 !== 0 || height % 16 !== 0) return "Width and height must be multiples of 16.";
  if (width > 3840 || height > 3840) return "Neither edge can exceed 3840px.";
  const pixels = width * height;
  if (pixels < 655_360 || pixels > 8_294_400) return "Custom size must contain between 655,360 and 8,294,400 pixels.";
  const ratio = Math.max(width / height, height / width);
  if (ratio > 3) return "The aspect ratio cannot be wider or taller than 3:1.";
  return null;
}

export function resolveCreativeImageSize(
  format: CreativeFormatKey,
  custom?: { width?: number; height?: number },
): { imageSize: CreativeImageSize; error: string | null } {
  if (format !== "custom") {
    return { imageSize: CREATIVE_FORMATS[format].imageSize ?? "auto", error: null };
  }
  const width = Number(custom?.width);
  const height = Number(custom?.height);
  const error = validateCustomImageSize(width, height);
  return { imageSize: { width, height }, error };
}
