-- Content Studio — source thumbnails.
-- Poppy-style visual nodes: the pasted content's own image on the card.
-- Either a stable CDN URL (YouTube's i.ytimg.com) or a small data: URL the
-- runner captured (IG/TikTok thumbs expire; og:image for websites).

alter table public.studio_sources add column if not exists thumbnail text;
