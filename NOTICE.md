# Notice

This repository — `envisioned-intelligent-websites-backend` — is part of the
**Envisioned Intelligent Websites** product family, created and maintained by
Maria-Ines Design Studio (d/b/a Envisioned).

## Origin and attribution

This work is built on top of the **Digital Home Starter** project, originally
created by [BraveBrand](https://bravebrand.com) and released under the MIT
License. The original LICENSE is preserved verbatim at
[`LICENSE-BRAVEBRAND`](./LICENSE-BRAVEBRAND) and continues to apply to the
foundational architecture from which this work is derived.

We thank BraveBrand for releasing the Digital Home Starter under MIT, which
made this product line possible.

## What this fork adds (Envisioned's contributions)

The Envisioned Intelligent Websites product family extends the original starter
with:

- **Publisher adapters** for external CMS platforms (Showit / WordPress,
  Webflow, Squarespace, Ghost, Notion, Substack), so the headless backend can
  publish AI-generated articles into existing websites — not just the
  companion templates.
- **Lead-capture embed** — a small JavaScript snippet that hooks into any
  existing site's contact form and routes submissions to Supabase + GoHighLevel
  without requiring the site to be rebuilt.
- **Two paired frontend templates** (`envisioned-intelligent-websites-template-editorial`
  and `-template-warm`) sharing the same data model and backend contracts,
  so users picking a template get a one-command branded site.
- **Brand-customization installer**
  (`envisioned-intelligent-websites-installer`) — a Claude Code skill / CLI
  that conducts a structured brand interview and provisions a fully-configured
  intelligence-layer website from a brand brief.
- Companion documentation, deployment workflows, and onboarding tooling.

## Licensing of contributions

Envisioned's modifications and additions in this repository are released
under the MIT License (see [`LICENSE`](./LICENSE)).

The two paired frontend templates and the installer skill may be released
under different terms — refer to their respective repositories for license
details.

## Trademarks

"BraveBrand", "Digital Home Starter", and any associated logos remain the
property of BraveBrand. Use of those names in this NOTICE is for accurate
attribution only and does not imply endorsement.

"Envisioned" and "Envisioned Intelligent Websites" are trademarks of
Maria-Ines Design Studio (d/b/a Envisioned).

---

For questions about licensing or commercial use, contact hello@mariaines.co.
