/** Keep a fenced carousel lease alive throughout any long local operation. */
export async function withStudioCarouselLeaseHeartbeat({
  heartbeatMs,
  leaseMs,
  report,
  task,
}) {
  if (
    !Number.isFinite(heartbeatMs)
    || !Number.isFinite(leaseMs)
    || heartbeatMs <= 0
    || heartbeatMs >= leaseMs
  ) {
    throw new Error("Studio carousel heartbeat must be positive and shorter than its claim lease");
  }
  if (typeof report !== "function" || typeof task !== "function") {
    throw new TypeError("Studio carousel heartbeat requires report and task functions");
  }

  const controller = new AbortController();
  let timer = null;
  let stopped = false;
  let leaseFailureError = null;
  const leaseFailure = new Promise((_, reject) => {
    const pulse = async () => {
      if (stopped) return;
      try {
        // An otherwise empty fenced report extends the lease without replacing
        // the member-visible progress filed by the active operation.
        await report({});
        if (!stopped) timer = setTimeout(pulse, heartbeatMs);
      } catch (error) {
        if (stopped) return;
        leaseFailureError = error;
        controller.abort(error);
        reject(error);
      }
    };
    timer = setTimeout(pulse, heartbeatMs);
  });
  const taskPromise = Promise.resolve().then(() => task(controller.signal));

  try {
    return await Promise.race([taskPromise, leaseFailure]);
  } catch (error) {
    if (leaseFailureError) {
      // Abort is cooperative. A Chrome/storage/database adapter may already be
      // inside a boundary that cannot stop synchronously, so never let cleanup
      // race a detached task. The runner's concrete adapters are themselves
      // abort-aware and time-bounded; drain settlement before returning the
      // lease failure to the cleanup state machine.
      controller.abort(leaseFailureError);
      try {
        await taskPromise;
      } catch {
        // The lease failure is the authoritative outcome at this boundary.
      }
      throw leaseFailureError;
    }
    throw error;
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}
