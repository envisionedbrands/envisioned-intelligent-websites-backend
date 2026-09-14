import { NextRequest, NextResponse } from "next/server";
import { studioMachineAuth } from "@/lib/studio/auth";
import {
  studioDatabaseOriginFingerprint,
  studioRunnerInstanceId,
} from "@/lib/studio/runner-server-identity";
import { createAdminClient } from "@/lib/supabase/server";

type UntypedRpcClient = {
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
};

function originOf(raw?: string) {
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

function projectRef(origin: string) {
  const url = new URL(origin);
  return url.hostname.endsWith(".supabase.co")
    ? url.hostname.slice(0, -".supabase.co".length)
    : url.host;
}

/**
 * Machine-only runner preflight. The Supabase origin is a public browser
 * setting, not a credential. The project ref is display-only; the fingerprint
 * covers the full normalized origin so self-hosted protocol/port differences
 * cannot collapse into one Home before either side processes a job.
 */
export async function GET(request: NextRequest) {
  const auth = studioMachineAuth(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const publicOrigin = originOf(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const serverOrigin = originOf(process.env.SUPABASE_URL);
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && !publicOrigin) {
    return NextResponse.json(
      { error: "NEXT_PUBLIC_SUPABASE_URL is not a valid URL.", code: "database_identity_invalid" },
      { status: 503 }
    );
  }
  if (process.env.SUPABASE_URL && !serverOrigin) {
    return NextResponse.json(
      { error: "SUPABASE_URL is not a valid URL.", code: "database_identity_invalid" },
      { status: 503 }
    );
  }
  if (!publicOrigin && !serverOrigin) {
    return NextResponse.json(
      { error: "The backend database identity is not configured.", code: "database_identity_missing" },
      { status: 503 }
    );
  }
  if (publicOrigin && serverOrigin && publicOrigin !== serverOrigin) {
    return NextResponse.json(
      { error: "The backend Supabase URLs point to different projects.", code: "database_identity_mismatch" },
      { status: 503 }
    );
  }
  const databaseOrigin = publicOrigin || serverOrigin!;
  const supabase = createAdminClient();

  // Prove both the service-role capability and the Studio queue on the
  // backend's own configured project. No row is created or changed.
  const { error: adminError } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1 });
  if (adminError) {
    return NextResponse.json(
      { error: "The backend could not verify its Supabase service credential.", code: "database_credential_invalid" },
      { status: 503 }
    );
  }
  const { error: queueError } = await supabase
    .from("studio_ingest_jobs")
    .select("id", { head: true, count: "exact" })
    .limit(1);
  if (queueError) {
    return NextResponse.json(
      { error: "The backend could not read its Studio queue.", code: "database_queue_unreadable" },
      { status: 503 }
    );
  }

  const [
    { error: genSchemaError },
    { error: healthSchemaError },
    { error: boardSchemaError },
    { error: uploadSchemaError },
    { data: schemaContract, error: schemaContractError },
  ] = await Promise.all([
    supabase
      .from("studio_gen_jobs")
      .select("id,provider_request_id,submission_started_at,submitted_at,materialized_at", { head: true, count: "exact" })
      .limit(1),
    supabase
      .from("studio_runner_health")
      .select("instance_id,status,failure_code,capabilities,last_seen_at", { head: true, count: "exact" })
      .limit(1),
    supabase
      .from("studio_boards")
      .select("id,status,graph_revision", { head: true, count: "exact" })
      .limit(1),
    supabase
      .from("studio_upload_receipts")
      .select("id,bucket,object_path,media,content_type,expected_size,status,source_id,job_id,expires_at", { head: true, count: "exact" })
      .limit(1),
    (supabase as unknown as UntypedRpcClient).rpc("studio_167_schema_contract", {}),
  ]);
  const schemaRecord = schemaContract
    && typeof schemaContract === "object"
    && !Array.isArray(schemaContract)
    ? schemaContract as Record<string, unknown>
    : null;
  const carouselExecutionLanes = [
    "studio_165_ready",
    "carousel_execution_columns",
    "carousel_execution_constraints",
    "carousel_decision_rpc",
    "carousel_decision_acl",
    "carousel_cleanup_rpc",
    "carousel_cleanup_acl",
    "carousel_cleanup_liveness",
    "carousel_materialize_rpc",
    "carousel_materialize_acl",
  ] as const;
  const schemaReady = Boolean(
    schemaRecord
    && schemaRecord.ready === true
    && schemaRecord.contract_revision === "studio_167_carousel_execution_v1"
    && carouselExecutionLanes.every((lane) => schemaRecord[lane] === true)
  );
  if (
    genSchemaError
    || healthSchemaError
    || boardSchemaError
    || uploadSchemaError
    || schemaContractError
    || !schemaReady
  ) {
    return NextResponse.json(
      {
        error: "Studio 1.6.7 database migrations are not fully applied. Deploy the 1.6.7 backend migrations before runner setup.",
        code: "studio_167_schema_missing",
      },
      { status: 503 },
    );
  }

  const backendOrigin = new URL(request.url).origin;

  return NextResponse.json(
    {
      project_ref: projectRef(databaseOrigin),
      database_origin_sha256: await studioDatabaseOriginFingerprint(databaseOrigin),
      runner_instance_id: await studioRunnerInstanceId(backendOrigin, databaseOrigin),
      queue_readable: true,
      // Keep the prior release proof visible to older diagnostics while the
      // current runner gates on the composed 1.6.7 contract.
      studio_163_schema_ready: true,
      studio_163_schema_contract: "presence_shape_acl",
      studio_164_schema_ready: true,
      studio_164_schema_contract: "1.6.3_plus_board_hydration_shape_acl",
      studio_165_schema_ready: true,
      studio_165_schema_contract: "1.6.4_plus_atomic_idempotent_broadcast_queue_and_decision",
      studio_167_schema_ready: true,
      studio_167_schema_contract: "studio_167_carousel_execution_v1",
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
