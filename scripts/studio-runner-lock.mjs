import { createHash, randomUUID } from "node:crypto";
import { connect, createServer } from "node:net";

const LOCK_HOST = "127.0.0.1";
const LOCK_PORT_BASE = 40_000;
const LOCK_PORT_SPAN = 9_000;
const LOCK_FALLBACK_COUNT = 4;
const LOCK_ELECTION_MAX_ROUNDS = 32;
const LOCK_ELECTION_SETTLE_MS = 20;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export class RunnerLockError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "RunnerLockError";
    this.code = code;
  }
}

export function normalizeRunnerOrigin(raw, label) {
  try {
    return new URL(raw).origin;
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
}

export function runnerProjectRef(origin) {
  const url = new URL(origin);
  return url.hostname.endsWith(".supabase.co")
    ? url.hostname.slice(0, -".supabase.co".length)
    : url.host;
}

export function databaseOriginFingerprint(origin) {
  return sha256(normalizeRunnerOrigin(origin, "Supabase URL"));
}

export function studioRunnerIdentity(backendUrl, supabaseUrl) {
  const backendOrigin = normalizeRunnerOrigin(backendUrl, "STUDIO_BACKEND_URL");
  const databaseOrigin = normalizeRunnerOrigin(
    supabaseUrl,
    "SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL"
  );
  return {
    backendOrigin,
    databaseOrigin,
    databaseOriginSha256: databaseOriginFingerprint(databaseOrigin),
    projectRef: runnerProjectRef(databaseOrigin),
    instanceId: sha256(`${backendOrigin}\n${databaseOrigin}`).slice(0, 12),
  };
}

function validateInstanceId(instanceId) {
  if (!/^[a-f0-9]{12}$/i.test(instanceId)) {
    throw new RunnerLockError("lock_config_invalid", "Invalid Studio runner instance id");
  }
}

function lockOverridePort(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const text = String(raw);
  if (!/^\d+$/.test(text)) {
    throw new RunnerLockError(
      "lock_config_invalid",
      "STUDIO_LOCK_PORT must be a whole-number TCP port between 1024 and 65535"
    );
  }
  const port = Number(text);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    throw new RunnerLockError(
      "lock_config_invalid",
      "STUDIO_LOCK_PORT must be a whole-number TCP port between 1024 and 65535"
    );
  }
  return port;
}

export function runnerLockPort(instanceId) {
  validateInstanceId(instanceId);
  return LOCK_PORT_BASE + (Number.parseInt(instanceId.slice(0, 8), 16) % LOCK_PORT_SPAN);
}

/**
 * Every process for one Home walks the same canonical candidates first. An
 * explicit override is only a supplemental listener after the contender owns
 * a canonical reservation; it can never replace the shared same-Home anchor.
 */
export function runnerLockPorts(instanceId, overrideRaw = process.env.STUDIO_LOCK_PORT) {
  validateInstanceId(instanceId);
  const defaults = [runnerLockPort(instanceId)];
  const override = lockOverridePort(overrideRaw);
  for (let index = 1; defaults.length < LOCK_FALLBACK_COUNT; index += 1) {
    const digest = createHash("sha256")
      .update(`studio-runner-lock:${instanceId}:${index}`)
      .digest();
    const port = LOCK_PORT_BASE + (digest.readUInt32BE(0) % LOCK_PORT_SPAN);
    if (!defaults.includes(port)) defaults.push(port);
  }
  return override && !defaults.includes(override) ? [...defaults, override] : defaults;
}

function probeLock(port) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: LOCK_HOST, port });
    let response = "";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(response.trim());
    };
    socket.setEncoding("utf8");
    socket.setTimeout(2_000, () =>
      finish(new Error("Studio runner lock holder did not identify itself"))
    );
    // A real HTTP request makes ordinary local web servers answer instead of
    // waiting forever for our side to speak. The Studio lock server ignores
    // the request and immediately returns its identity on connect.
    socket.once("connect", () => {
      socket.end("GET /__digital_home_studio_runner_lock__ HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n");
    });
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.includes("\n")) finish();
      else if (response.length > 512) finish(new Error("Studio runner lock response was invalid"));
    });
    socket.once("end", () => finish());
    socket.once("error", (error) => {
      // A tiny foreign server may close immediately after sending its marker;
      // keep a complete response instead of letting a late EPIPE erase it.
      if (response.trim()) finish();
      else finish(error);
    });
  });
}

function classifyLockHolder(holder, identity) {
  if (holder === identity) {
    // A pre-1.6.3 lock only published the Home identity. Treat it as an
    // established owner, never as a provisional contender that may be
    // displaced by the new election protocol.
    return { state: "same", holder, token: null, phase: "active" };
  }
  if (!holder.startsWith(`${identity}\t`)) {
    return { state: "foreign", holder: holder || "unidentified service" };
  }

  const fields = holder.split("\t");
  const token = fields[1] || "";
  const phase = fields[2] || "";
  if (
    fields.length !== 3
    || !/^[a-f0-9-]{16,64}$/i.test(token)
    || (phase !== "candidate" && phase !== "active")
  ) {
    // A response claiming this Home but not speaking the complete protocol
    // may be a damaged or half-upgraded runner. It is not positive evidence
    // that fallback is safe.
    return { state: "unknown", holder: "Studio runner lock identity was malformed" };
  }
  return { state: "same", holder, token, phase };
}

async function inspectLock(port, identity) {
  try {
    const holder = await probeLock(port);
    return classifyLockHolder(holder, identity);
  } catch (error) {
    if (error?.code === "ECONNREFUSED") return { state: "free" };
    return { state: "unknown", holder: error instanceof Error ? error.message : String(error) };
  }
}

async function inspectLockSet(ports, identity) {
  const inspections = await Promise.all(ports.map((port) => inspectLock(port, identity)));
  const unknownIndexes = inspections
    .map((inspection, index) => inspection.state === "unknown" ? index : -1)
    .filter((index) => index >= 0);
  if (!unknownIndexes.length) return inspections;

  // A server may have accepted the TCP connection immediately before its
  // identity handler became runnable. One complete retry distinguishes that
  // startup edge from a silent/wedged holder; persistent silence fails closed.
  const retried = await Promise.all(
    unknownIndexes.map((index) => inspectLock(ports[index], identity))
  );
  unknownIndexes.forEach((index, retryIndex) => {
    inspections[index] = retried[retryIndex];
  });
  return inspections;
}

function unverifiedHolderError(inspections) {
  const unknown = inspections.filter(({ state }) => state === "unknown");
  if (!unknown.length) return null;
  const loopbackDenied = unknown.some(({ holder }) => /\b(?:EACCES|EPERM)\b/.test(holder));
  return new RunnerLockError(
    "lock_unavailable",
    loopbackDenied
      ? "Studio runner could not probe its local loopback lock because the operating environment denied the connection; allow 127.0.0.1 TCP connections and rerun setup"
      : "A Studio runner lock holder did not identify itself; it may be a wedged same-Home runner, so startup is refusing to create a second owner"
  );
}

function canonicalSquatterError(canonicalPorts) {
  return new RunnerLockError(
    "lock_squatter",
    `Studio runner shared canonical lock candidates are used by other local services (${canonicalPorts.join(", ")}). Free one of those ports and rerun setup; STUDIO_LOCK_PORT cannot bypass the shared same-Home ownership anchor.`
  );
}

async function closeLockServers(servers) {
  await Promise.all(servers.map((server) => new Promise((resolve, reject) => {
    // close() stops new accepts; draining existing probe sockets immediately
    // afterwards lets its callback become the release receipt. Do not return
    // ownership to the caller until Node confirms the listener is closed: the
    // deterministic candidate set can be reused immediately by a restart or a
    // later election in the same process.
    try {
      server.close((error) => {
        if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
        else resolve();
      });
      server.closeAllConnections?.();
      server.closeIdleConnections?.();
    } catch (error) {
      if (error?.code === "ERR_SERVER_NOT_RUNNING") resolve();
      else reject(error);
    }
  })));
}

async function listenForLock(port, holder) {
  const server = createServer((socket) => {
    // Wait until the contender's HTTP probe has reached the kernel before
    // closing our side. Replying immediately on accept can race its first
    // write into EPIPE/ECONNRESET, causing simultaneous same-Home starts to
    // misclassify one another as unknown holders.
    let replied = false;
    const reply = () => {
      if (replied || socket.destroyed) return;
      replied = true;
      socket.end(`${holder.identity}\t${holder.token}\t${holder.phase}\n`);
    };
    socket.setTimeout(2_000, () => socket.destroy());
    socket.once("data", reply);
    socket.once("error", () => {});
  });
  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host: LOCK_HOST, port, exclusive: true });
    });
    return server;
  } catch (error) {
    server.removeAllListeners();
    throw error;
  }
}

const waitForElection = () => new Promise((resolve) => {
  setTimeout(resolve, LOCK_ELECTION_SETTLE_MS);
});

function activeOtherIndex(inspections, token) {
  return inspections.findIndex((inspection) =>
    inspection.state === "same"
    && inspection.phase === "active"
    && inspection.token !== token
  );
}

function otherCandidateTokens(inspections, token) {
  return [...new Set(inspections
    .filter((inspection) =>
      inspection.state === "same"
      && inspection.phase === "candidate"
      && inspection.token !== token
    )
    .map((inspection) => inspection.token))];
}

/**
 * Kernel-owned loopback lock. There is no PID file to survive a crash and no
 * stale path to unlink. Provisional contenders reserve every presently free
 * deterministic candidate, publish a unique token, and stabilize the complete
 * candidate set before one token may become active. That whole-set election is
 * what keeps a positively identified foreign service disappearing mid-scan
 * from splitting ownership between the canonical and fallback ports.
 *
 * A same-Home active identity always stops the election. Only an identified
 * foreign service permits fallback; an unresponsive holder fails closed
 * because it may be a wedged same-Home runner whose event loop cannot answer
 * the handshake.
 */
export async function acquireRunnerLock(
  instanceId,
  { overridePort = process.env.STUDIO_LOCK_PORT } = {}
) {
  const canonicalPorts = runnerLockPorts(instanceId, "");
  const canonicalPortSet = new Set(canonicalPorts);
  const ports = runnerLockPorts(instanceId, overridePort);
  const identity = `studio-runner:${instanceId}`;
  const holder = { identity, token: randomUUID(), phase: "candidate" };
  const owned = new Map();
  let stablePasses = 0;
  const hasCanonicalReservation = () =>
    [...owned.keys()].some((port) => canonicalPortSet.has(port));

  const releaseOwned = async () => {
    const servers = [...owned.values()];
    owned.clear();
    await closeLockServers(servers);
  };
  const rejectForUnknown = async (inspections) => {
    const unverified = unverifiedHolderError(inspections);
    if (!unverified) return;
    await releaseOwned();
    throw unverified;
  };
  const rejectForActive = async (inspections) => {
    const index = activeOtherIndex(inspections, holder.token);
    if (index < 0) return null;
    await releaseOwned();
    return {
      acquired: false,
      port: ports[index],
      activeToken: inspections[index].token,
      reason: "active",
      release: async () => {},
    };
  };

  for (let round = 0; round < LOCK_ELECTION_MAX_ROUNDS; round += 1) {
    const beforeBind = await inspectLockSet(ports, identity);
    const active = await rejectForActive(beforeBind);
    if (active) return active;
    await rejectForUnknown(beforeBind);

    if (
      !hasCanonicalReservation()
      && beforeBind
        .slice(0, canonicalPorts.length)
        .every((inspection) => inspection.state === "foreign")
    ) {
      await releaseOwned();
      throw canonicalSquatterError(canonicalPorts);
    }

    // A contender that has released its provisional reservations must wait
    // for the visible winner to publish an active receipt. Rebinding the
    // winner's newly free ports here would restart the split election, while
    // returning now would falsely report a candidate's temporary port as the
    // final active lock. If the candidate disappears, a later scan sees no
    // token and this process re-enters the election normally.
    if (!owned.size && otherCandidateTokens(beforeBind, holder.token).length) {
      stablePasses = 0;
      await waitForElection();
      continue;
    }

    // Reserve every port that is currently free. Multiple contenders can win
    // disjoint bind races, so these listeners remain provisional until the
    // complete set has reached a stable, deterministic token election.
    let reservedThisRound = false;
    for (let index = 0; index < ports.length; index += 1) {
      const port = ports[index];
      if (beforeBind[index].state !== "free" || owned.has(port)) continue;
      // The override is supplemental, never a provisional ownership island.
      // Canonicals are ordered first, so it is reserved only after this
      // contender already owns a shared anchor.
      if (!canonicalPortSet.has(port) && !hasCanonicalReservation()) continue;
      try {
        owned.set(port, await listenForLock(port, holder));
        reservedThisRound = true;
      } catch (error) {
        if (error?.code === "EADDRINUSE") continue;
        await releaseOwned();
        throw new RunnerLockError(
          "lock_unavailable",
          `Studio runner could not bind its loopback lock on ${LOCK_HOST}:${port} (${error?.code || "unknown error"})`,
          error
        );
      }
    }
    // A newly reserved port is a candidate-set change, not a quiet pass. In
    // particular, this prevents two contenders with an earlier stable view
    // from each activating after separate foreign listeners disappear.
    if (reservedThisRound) stablePasses = 0;

    const stabilized = await inspectLockSet(ports, identity);
    const stabilizedActive = await rejectForActive(stabilized);
    if (stabilizedActive) return stabilizedActive;
    await rejectForUnknown(stabilized);

    // Losing one of our provisional reservations is not a condition under
    // which fallback is safe. Fail closed instead of continuing from a stale
    // view of the candidate set.
    for (const port of owned.keys()) {
      const index = ports.indexOf(port);
      const inspection = stabilized[index];
      if (
        inspection.state !== "same"
        || inspection.token !== holder.token
        || inspection.phase !== "candidate"
      ) {
        await releaseOwned();
        throw new RunnerLockError(
          "lock_unavailable",
          "Studio runner lost a provisional lock reservation during startup; rerun setup"
        );
      }
    }

    if (stabilized.some((inspection) => inspection.state === "free")) {
      stablePasses = 0;
      await waitForElection();
      continue;
    }

    const otherTokens = otherCandidateTokens(stabilized, holder.token);
    if (otherTokens.length) {
      stablePasses = 0;
      if (!owned.size) {
        await waitForElection();
        continue;
      }
      const winningToken = [holder.token, ...otherTokens].sort()[0];
      if (winningToken !== holder.token) {
        await releaseOwned();
        await waitForElection();
        continue;
      }
      // We are the provisional winner, but cannot become active while any
      // losing token still owns a candidate. Give it time to close, then scan
      // and reserve the now-free port before activation.
      await waitForElection();
      continue;
    }

    if (!owned.size) {
      throw canonicalSquatterError(canonicalPorts);
    }

    // Require two quiet whole-set observations. A foreign listener that
    // disappears during either scan becomes free on the next pass and must be
    // reserved (or won by a visible contender) before anyone can activate.
    stablePasses += 1;
    if (stablePasses < 2) {
      await waitForElection();
      continue;
    }

    // An override is not shared by contenders whose local configuration
    // differs, so it can supplement an owner but can never be the ownership
    // proof. Every active runner must hold at least one port from the identical
    // four-port canonical set or two differing overrides could both activate.
    if (!hasCanonicalReservation()) {
      await releaseOwned();
      throw canonicalSquatterError(canonicalPorts);
    }

    holder.phase = "active";
    const port = ports.find((candidate) => owned.has(candidate));
    let released = false;
    return {
      acquired: true,
      port,
      activeToken: holder.token,
      release: async () => {
        if (released) return;
        released = true;
        await releaseOwned();
      },
    };
  }

  await releaseOwned();
  throw new RunnerLockError(
    "lock_unavailable",
    "Studio runner lock election did not stabilize; rerun setup"
  );
}
