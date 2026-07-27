import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default {
  ...defineCloudflareConfig({}),
  // The package.json build script runs `next build && opennextjs-cloudflare build`.
  // Without this override, the OpenNext step re-runs that same script and recurses forever.
  buildCommand: "npx next build",
};
