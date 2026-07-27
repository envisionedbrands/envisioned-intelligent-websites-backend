import type { AdminClient, CrmSettings, CrmSender, SendWindow } from "./types";

// Fallbacks only — the real values live in backend_settings (crm_sender,
// crm_send_window), seeded during installation.
const DEFAULT_SENDER: CrmSender = {
  from_name: "Digital Home",
  from_email: "owner@example.com",
  reply_to: "owner@example.com",
};

const DEFAULT_WINDOW: SendWindow = {
  enabled: false,
  start_hour: 8,
  end_hour: 18,
  timezone: "UTC",
  days: [1, 2, 3, 4, 5],
};

export async function getCrmSettings(supabase: AdminClient): Promise<CrmSettings> {
  const { data } = await supabase
    .from("backend_settings")
    .select("key, value")
    .in("key", ["crm_safe_mode", "crm_sender", "crm_send_window", "crm_capture_key", "crm_funnel_secret"]);

  const map = new Map((data || []).map((r) => [r.key, r.value]));

  const sender = { ...DEFAULT_SENDER, ...((map.get("crm_sender") as object) || {}) } as CrmSender;
  const send_window = { ...DEFAULT_WINDOW, ...((map.get("crm_send_window") as object) || {}) } as SendWindow;

  return {
    // Default to safe mode unless explicitly disabled
    safe_mode: map.get("crm_safe_mode") !== false,
    sender,
    send_window,
    capture_key: typeof map.get("crm_capture_key") === "string" ? (map.get("crm_capture_key") as string) : null,
    funnel_secret: typeof map.get("crm_funnel_secret") === "string" ? (map.get("crm_funnel_secret") as string) : null,
  };
}
