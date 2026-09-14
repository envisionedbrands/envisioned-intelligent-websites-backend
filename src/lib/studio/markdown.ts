import { Marked, type RendererObject } from "marked";

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export function safeStudioLinkHref(href: string): string | null {
  const value = href.trim();
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null;
  if (value.startsWith("#") || (value.startsWith("/") && !value.startsWith("//"))) return value;
  try {
    const parsed = new URL(value);
    return ["https:", "http:", "mailto:", "tel:"].includes(parsed.protocol) ? value : null;
  } catch {
    return null;
  }
}

const safeRenderer: RendererObject = {
  html({ text }) {
    return escapeHtml(text);
  },
  link({ href, title, tokens }) {
    const label = this.parser.parseInline(tokens);
    const safeHref = safeStudioLinkHref(href);
    if (!safeHref) return label;
    const safeTitle = title ? ` title="${escapeHtml(title)}"` : "";
    return `<a href="${escapeHtml(safeHref)}"${safeTitle} rel="noopener noreferrer">${label}</a>`;
  },
  image({ text }) {
    const label = text.trim() || "image";
    return `<span class="studio-markdown-image-placeholder">[Image: ${escapeHtml(label)}]</span>`;
  },
};

/** One allowlisted Markdown boundary for replies, email reviews, notes, and
 * formatted clipboard export. Raw HTML, unsafe link protocols, and Markdown
 * images are overridden before any HTML reaches the signed-in admin DOM. */
export function renderStudioMarkdown(source: string, options?: { breaks?: boolean }): string {
  return new Marked({
    gfm: true,
    breaks: options?.breaks ?? false,
    renderer: safeRenderer,
  }).parse(source) as string;
}
