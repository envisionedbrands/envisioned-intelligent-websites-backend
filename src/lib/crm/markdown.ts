import { marked } from "marked";
import type { CrmSender } from "./types";

marked.setOptions({ gfm: true, breaks: true });

/**
 * Renders email markdown into the Envisioned email shell.
 *
 * Brand system (DECISIONS #014): cool canvas, ink, olive as the action colour.
 * Meganté cannot be used here — email clients strip custom @font-face, so
 * display type degrades to Georgia, which carries the same editorial weight.
 * Body stays in the system sans for legibility at small sizes.
 *
 * DELIVERABILITY IS THE CONSTRAINT, not decoration. Every element is real HTML
 * text, never an image of text, because image-heavy templates are the profile
 * Gmail sorts into Promotions and filters treat as bulk. That is the trap in
 * the pretty-newsletter tools: the look costs the inbox. Colour, spacing,
 * rules and type do the work instead, and they weigh nothing.
 *
 * Markdown affordances, so copy stays plain and editable in the CRM:
 *   # / ## / ###   headings in Georgia
 *   > quote        olive-ruled pull quote
 *   ---            hairline divider
 *   [text](url)    inline link; a paragraph containing ONLY a link becomes
 *                  a solid olive button
 *   ::label::      small boxed label (the "THIS WEEK" device)
 */

const CANVAS = "#FBFAF9";
const PAPER = "#FFFFFF";
const INK = "#1E1E1E";
const OLIVE = "#4C5A2E";
const OLIVE_DEEP = "#3A4622";
const TAUPE = "#8A7A68";
const HAIR = "#E3DED5";

const SERIF = "Georgia,'Times New Roman',serif";
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function renderEmailHtml(opts: {
  bodyMd: string;
  preheader?: string | null;
  sender: CrmSender;
  unsubscribeUrl: string;
}): string {
  let body = marked.parse(opts.bodyMd) as string;

  // ::label:: → small boxed label
  body = body.replace(
    /<p>\s*::([^:]+)::\s*<\/p>/g,
    (_m, text: string) =>
      `<p style="margin:0 0 20px;"><span style="display:inline-block;border:1px solid ${INK};padding:6px 14px;font-family:${SANS};font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:${INK};">${text.trim()}</span></p>`
  );

  // A paragraph that is only a link becomes the CTA button.
  body = body.replace(
    /<p>\s*(<a href="[^"]+"[^>]*>[^<]+<\/a>)\s*<\/p>/g,
    (_m, anchor: string) =>
      `<p style="margin:32px 0;">${anchor.replace(
        "<a ",
        `<a style="display:inline-block;background:${OLIVE};color:${CANVAS};text-decoration:none;padding:14px 30px;font-family:${SANS};font-size:13px;letter-spacing:.12em;text-transform:uppercase;" `
      )}</p>`
  );

  const preheaderHtml = opts.preheader
    ? `<span style="display:none;font-size:1px;color:${CANVAS};max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(
        opts.preheader
      )}</span>`
    : "";

  const addressHtml = opts.sender.address
    ? `<div style="margin-top:6px;">${escapeHtml(opts.sender.address)}</div>`
    : "";

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { margin:0; padding:0; background:${CANVAS}; }
  a { color: ${OLIVE_DEEP}; }
  .wrap h1, .wrap h2, .wrap h3 { font-family:${SERIF}; font-weight:400; color:${INK}; }
  .wrap h1 { font-size:30px; line-height:1.18; margin:0 0 18px; }
  .wrap h2 { font-size:23px; line-height:1.25; margin:34px 0 12px; }
  .wrap h3 { font-size:18px; line-height:1.3; margin:26px 0 8px; }
  .wrap p { margin:0 0 17px; }
  .wrap ul, .wrap ol { margin:0 0 17px 20px; padding:0; }
  .wrap li { margin-bottom:8px; }
  .wrap blockquote { border-left:2px solid ${OLIVE}; margin:22px 0; padding:2px 0 2px 18px;
    font-family:${SERIF}; font-size:18px; line-height:1.5; color:${INK}; }
  .wrap hr { border:none; border-top:1px solid ${HAIR}; margin:32px 0; }
  .wrap img { max-width:100%; height:auto; margin:10px 0; }
  .wrap strong { color:${INK}; }
  @media (max-width:620px) {
    .card { padding:28px 22px !important; }
    .wrap h1 { font-size:26px !important; }
  }
</style>
</head>
<body>
${preheaderHtml}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CANVAS};">
<tr><td align="center" style="padding:32px 12px;">

<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
  <tr><td align="center" style="padding:0 0 22px;">
    <div style="font-family:${SERIF};font-size:19px;letter-spacing:.28em;text-transform:uppercase;color:${INK};">Envisioned</div>
    <div style="font-family:${SANS};font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:${TAUPE};margin-top:5px;">by Maria-Ines</div>
  </td></tr>

  <tr><td class="card" style="background:${PAPER};padding:40px 38px;border:1px solid ${HAIR};">
    <div class="wrap" style="font-family:${SANS};font-size:16px;line-height:1.72;color:${INK};">
${body}
    </div>
  </td></tr>

  <tr><td style="padding:22px 8px 0;font-family:${SANS};font-size:11px;line-height:1.7;color:${TAUPE};">
    <div>${escapeHtml(opts.sender.from_name)}</div>
    ${addressHtml}
    <div style="margin-top:6px;">You are receiving this because you booked or subscribed at Envisioned. <a href="${opts.unsubscribeUrl}" style="color:${TAUPE};text-decoration:underline;">Unsubscribe</a></div>
  </td></tr>
</table>

</td></tr>
</table>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
