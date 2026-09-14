/**
 * Studio auth — one door for both callers:
 *  - Browser: admin session (the /studio UI).
 *  - Machines: `Authorization: Bearer <API_SECRET_KEY>` (the runner and the
 *    ingest CLI) — the same master-key boundary the rest of the machine API
 *    uses. The bearer check is vendored here so the Studio module stays
 *    self-contained against any starter version (the shared auth lib's
 *    bearer helper is newer than some floors).
 */
import { NextRequest } from "next/server";
import { timingSafeEqual } from "crypto";
import { authenticateSession, type AuthResult } from "@/lib/api/auth";

function bearerMatchesMasterKey(header: string): boolean {
  const match = header.match(/^Bearer\s+(.+)$/i);
  const secret = process.env.API_SECRET_KEY;
  if (!match || !secret) return false;
  const presented = Buffer.from(match[1].trim(), "utf8");
  const expected = Buffer.from(secret, "utf8");
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

export async function studioAuth(request: NextRequest): Promise<AuthResult> {
  const header = request.headers.get("authorization");
  if (header?.match(/^Bearer\s+/i)) {
    if (bearerMatchesMasterKey(header)) {
      return { authenticated: true, mode: "api-key", agent: "master" };
    }
    return { authenticated: false, error: "Invalid machine key" };
  }
  return authenticateSession(request);
}

/** Machine-only door (the runner's claim/report pair): bearer master key,
 *  no session fallback. */
export function studioMachineAuth(request: NextRequest): AuthResult {
  const header = request.headers.get("authorization") ?? "";
  if (bearerMatchesMasterKey(header)) {
    return { authenticated: true, mode: "api-key", agent: "master" };
  }
  return { authenticated: false, error: "Invalid machine key" };
}
