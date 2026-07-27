import type { createAdminClient } from "@/lib/supabase/server";
import type { Tables } from "@/types/database";

export type AdminClient = ReturnType<typeof createAdminClient>;

export type Lead = Tables<"leads">;
export type Workflow = Tables<"workflows">;
export type Enrollment = Tables<"workflow_enrollments">;
export type EmailTemplate = Tables<"email_templates">;

export type WorkflowStepType =
  | "send_email"
  | "wait"
  | "add_tag"
  | "remove_tag"
  | "set_status"
  | "move_stage"
  | "update_field"
  | "webhook"
  | "create_task";

export interface WorkflowStep {
  id: string;
  type: WorkflowStepType;
  config: Record<string, unknown>;
}

export type TriggerType =
  | "manual"
  | "lead_created"
  | "form_submitted"
  | "tag_added"
  | "status_changed"
  | "stage_changed";

export interface SendWindow {
  enabled: boolean;
  start_hour: number;
  end_hour: number;
  timezone: string;
  days: number[]; // 0 = Sunday … 6 = Saturday
}

export interface CrmSender {
  from_name: string;
  from_email: string;
  reply_to?: string;
  address?: string; // physical address for the email footer (CAN-SPAM)
}

export interface CrmSettings {
  safe_mode: boolean;
  sender: CrmSender;
  send_window: SendWindow;
  capture_key: string | null;
  funnel_secret: string | null;
}

export const WORKFLOW_STEP_TYPES: WorkflowStepType[] = [
  "send_email",
  "wait",
  "add_tag",
  "remove_tag",
  "set_status",
  "move_stage",
  "update_field",
  "webhook",
  "create_task",
];

export function parseSteps(raw: unknown): WorkflowStep[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (s): s is WorkflowStep =>
      !!s && typeof s === "object" && typeof (s as WorkflowStep).type === "string"
  );
}
