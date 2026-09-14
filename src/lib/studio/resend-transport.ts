export async function sendResendRequest(
  apiKey: string,
  payload: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 20_000,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let response: Response;
  try {
    response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(Math.max(1, Math.min(60_000, Math.round(timeoutMs)))),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return { ok: false, error: timedOut ? "Resend timed out before the test could be delivered" : "Resend could not be reached" };
  }
  if (!response.ok) {
    let message = "";
    try {
      const text = await response.text();
      const body = JSON.parse(text) as { message?: unknown };
      if (typeof body.message === "string") message = body.message;
    } catch {
      // A provider proxy may return HTML or interrupt its body. The status is
      // enough to fail closed without leaking that body into the UI.
    }
    return { ok: false, error: message || `Resend ${response.status}` };
  }
  return { ok: true };
}
