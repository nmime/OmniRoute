/**
 * Account Semaphore
 *
 * In-memory provider/account concurrency limiter keyed by provider and account.
 * Requests beyond the configured concurrency cap wait in a FIFO queue until a slot opens,
 * the gate is unblocked, or the queue timeout expires.
 */

export interface AccountSemaphoreKeyParts {
  provider: string;
  accountKey: string;
}

interface QueuedAcquire {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface AccountGate {
  running: number;
  maxConcurrency: number;
  queue: QueuedAcquire[];
  blockedUntil: number | null;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

export interface AcquireAccountSemaphoreOptions {
  maxConcurrency?: number | null;
  timeoutMs?: number;
  signal?: AbortSignal | null;
  maxQueueSize?: number;
}

export interface AccountSemaphoreStatsEntry {
  running: number;
  queued: number;
  maxConcurrency: number;
  blockedUntil: string | null;
}

export type TryAcquireAccountSemaphoreReason = "acquired" | "bypassed" | "full" | "blocked";

export interface TryAcquireAccountSemaphoreResult {
  acquired: boolean;
  release: () => void;
  reason: TryAcquireAccountSemaphoreReason;
  snapshot: AccountSemaphoreStatsEntry;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_QUEUE_SIZE = 20;

const gates = new Map<string, AccountGate>();

/**
 * Build the canonical account semaphore key.
 */
export function buildAccountSemaphoreKey({
  provider,
  accountKey,
}: AccountSemaphoreKeyParts): string {
  return `${String(provider)}:${String(accountKey)}`;
}

function isBypassed(maxConcurrency?: number | null): boolean {
  return maxConcurrency == null || maxConcurrency <= 0;
}

function createNoopReleaseFn(): () => void {
  let released = false;

  return () => {
    if (released) return;
    released = true;
  };
}

function ensureGate(semaphoreKey: string, maxConcurrency: number): AccountGate {
  const existing = gates.get(semaphoreKey);
  if (existing) {
    existing.maxConcurrency = maxConcurrency;
    return existing;
  }

  const created: AccountGate = {
    running: 0,
    maxConcurrency,
    queue: [],
    blockedUntil: null,
    cleanupTimer: null,
  };
  gates.set(semaphoreKey, created);
  return created;
}

function isBlocked(gate: AccountGate): boolean {
  if (!gate.blockedUntil) return false;
  if (Date.now() >= gate.blockedUntil) {
    gate.blockedUntil = null;
    return false;
  }
  return true;
}

function clearCleanupTimer(gate: AccountGate): void {
  if (!gate.cleanupTimer) return;
  clearTimeout(gate.cleanupTimer);
  gate.cleanupTimer = null;
}

function cleanupGateIfIdle(semaphoreKey: string): void {
  const gate = gates.get(semaphoreKey);
  if (!gate) return;
  if (gate.running > 0 || gate.queue.length > 0 || isBlocked(gate)) return;
  clearCleanupTimer(gate);
  gates.delete(semaphoreKey);
}

function scheduleCleanup(semaphoreKey: string): void {
  const gate = gates.get(semaphoreKey);
  if (!gate) return;
  clearCleanupTimer(gate);

  gate.cleanupTimer = setTimeout(() => {
    gate.cleanupTimer = null;
    cleanupGateIfIdle(semaphoreKey);
  }, 0);

  gate.cleanupTimer.unref?.();
}

function drainQueue(semaphoreKey: string): void {
  const gate = gates.get(semaphoreKey);
  if (!gate) return;

  while (gate.queue.length > 0 && gate.running < gate.maxConcurrency && !isBlocked(gate)) {
    const next = gate.queue.shift();
    if (!next) break;
    clearTimeout(next.timer);
    gate.running++;
    next.resolve(createReleaseFn(semaphoreKey));
  }

  if (gate.running === 0 && gate.queue.length === 0) {
    scheduleCleanup(semaphoreKey);
  }
}

function createReleaseFn(semaphoreKey: string): () => void {
  let released = false;

  return () => {
    if (released) return;
    released = true;

    const gate = gates.get(semaphoreKey);
    if (!gate) return;
    if (gate.running > 0) {
      gate.running--;
    }

    if (gate.queue.length > 0) {
      drainQueue(semaphoreKey);
      return;
    }

    scheduleCleanup(semaphoreKey);
  };
}

function createSemaphoreTimeoutError(
  semaphoreKey: string,
  timeoutMs: number
): Error & { code: string } {
  const error = new Error(`Semaphore timeout after ${timeoutMs}ms for ${semaphoreKey}`) as Error & {
    code: string;
  };
  error.code = "SEMAPHORE_TIMEOUT";
  return error;
}

function snapshotGate(gate: AccountGate): AccountSemaphoreStatsEntry {
  return {
    running: gate.running,
    queued: gate.queue.length,
    maxConcurrency: gate.maxConcurrency,
    blockedUntil: gate.blockedUntil ? new Date(gate.blockedUntil).toISOString() : null,
  };
}

function createBypassedSnapshot(): AccountSemaphoreStatsEntry {
  return {
    running: 0,
    queued: 0,
    maxConcurrency: 0,
    blockedUntil: null,
  };
}


function makeAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === "string" ? reason : "The operation was aborted");
  err.name = "AbortError";
  return err;
}

/**
 * Try to acquire a slot without queueing.
 *
 * This is intended for routing paths that can choose another eligible account
 * when the selected account is already at local capacity. It never creates a
 * waiter and never waits for DEFAULT_TIMEOUT_MS.
 */
export function tryAcquire(
  semaphoreKey: string,
  { maxConcurrency = null }: Pick<AcquireAccountSemaphoreOptions, "maxConcurrency"> = {}
): TryAcquireAccountSemaphoreResult {
  if (isBypassed(maxConcurrency)) {
    return {
      acquired: true,
      release: createNoopReleaseFn(),
      reason: "bypassed",
      snapshot: createBypassedSnapshot(),
    };
  }

  const gate = ensureGate(semaphoreKey, maxConcurrency);
  clearCleanupTimer(gate);

  const blocked = isBlocked(gate);
  if (!blocked && gate.running < gate.maxConcurrency) {
    gate.running++;
    return {
      acquired: true,
      release: createReleaseFn(semaphoreKey),
      reason: "acquired",
      snapshot: snapshotGate(gate),
    };
  }

  return {
    acquired: false,
    release: createNoopReleaseFn(),
    reason: blocked ? "blocked" : "full",
    snapshot: snapshotGate(gate),
  };
}

/**
 * Return one semaphore key snapshot without mutating the gate map.
 */
export function getSnapshot(semaphoreKey: string): AccountSemaphoreStatsEntry | null {
  const gate = gates.get(semaphoreKey);
  return gate ? snapshotGate(gate) : null;
}

/**
 * Acquire a slot for a provider/model/account tuple.
 * Returns an idempotent release function that is safe to call in finally blocks.
 */
export function acquire(
  semaphoreKey: string,
  {
    maxConcurrency = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal = null,
    maxQueueSize = DEFAULT_MAX_QUEUE_SIZE,
  }: AcquireAccountSemaphoreOptions = {}
): Promise<() => void> {
  if (isBypassed(maxConcurrency)) {
    return Promise.resolve(createNoopReleaseFn());
  }

  if (signal?.aborted) {
    return Promise.reject(makeAbortError(signal));
  }

  const gate = ensureGate(semaphoreKey, maxConcurrency);
  clearCleanupTimer(gate);

  if (gate.running < gate.maxConcurrency && !isBlocked(gate)) {
    gate.running++;
    return Promise.resolve(createReleaseFn(semaphoreKey));
  }

  if (gate.queue.length >= maxQueueSize) {
    const err = new Error(`Semaphore queue full (${maxQueueSize}) for ${semaphoreKey}`) as Error & {
      code: string;
    };
    err.code = "SEMAPHORE_QUEUE_FULL";
    return Promise.reject(err);
  }

  return new Promise((resolve, reject) => {
    let abortListener: (() => void) | null = null;

    const cleanup = () => {
      if (abortListener && signal) {
        signal.removeEventListener("abort", abortListener);
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      const nextGate = gates.get(semaphoreKey);
      if (!nextGate) {
        reject(createSemaphoreTimeoutError(semaphoreKey, timeoutMs));
        return;
      }

      const queueIndex = nextGate.queue.findIndex((item) => item.timer === timer);
      if (queueIndex !== -1) {
        nextGate.queue.splice(queueIndex, 1);
      }

      if (nextGate.running === 0 && nextGate.queue.length === 0) {
        scheduleCleanup(semaphoreKey);
      }

      reject(createSemaphoreTimeoutError(semaphoreKey, timeoutMs));
    }, timeoutMs);

    timer.unref?.();

    const queueItem: QueuedAcquire = {
      resolve: (release) => {
        cleanup();
        resolve(release);
      },
      reject: (error) => {
        cleanup();
        reject(error);
      },
      timer,
    };

    gate.queue.push(queueItem);

    if (signal) {
      abortListener = () => {
        cleanup();
        clearTimeout(timer);

        const nextGate = gates.get(semaphoreKey);
        if (!nextGate) {
          reject(makeAbortError(signal));
          return;
        }

        const queueIndex = nextGate.queue.findIndex((item) => item.timer === timer);
        if (queueIndex !== -1) {
          nextGate.queue.splice(queueIndex, 1);
        }

        if (nextGate.running === 0 && nextGate.queue.length === 0) {
          scheduleCleanup(semaphoreKey);
        }

        reject(makeAbortError(signal));
      };
      if (signal.aborted) {
        abortListener();
      } else {
        signal.addEventListener("abort", abortListener);
      }
    }
  });
}

/**
 * Temporarily block new acquisitions for a key while allowing in-flight requests to finish.
 */
export function markBlocked(semaphoreKey: string, cooldownMs: number): void {
  const safeCooldownMs = Number.isFinite(cooldownMs) && cooldownMs > 0 ? cooldownMs : 0;
  if (safeCooldownMs <= 0) {
    const gate = gates.get(semaphoreKey);
    if (!gate) return;
    gate.blockedUntil = null;
    drainQueue(semaphoreKey);
    return;
  }

  const gate = gates.get(semaphoreKey) ?? ensureGate(semaphoreKey, 1);
  clearCleanupTimer(gate);
  gate.blockedUntil = Date.now() + safeCooldownMs;

  const timer = setTimeout(() => {
    const nextGate = gates.get(semaphoreKey);
    if (!nextGate) return;
    if (nextGate.blockedUntil && Date.now() >= nextGate.blockedUntil) {
      nextGate.blockedUntil = null;
      drainQueue(semaphoreKey);
      if (nextGate.running === 0 && nextGate.queue.length === 0) {
        scheduleCleanup(semaphoreKey);
      }
    }
  }, safeCooldownMs + 50);

  timer.unref?.();
}

/**
 * Return the current in-memory semaphore snapshot.
 */
export function getStats(): Record<string, AccountSemaphoreStatsEntry> {
  const stats: Record<string, AccountSemaphoreStatsEntry> = {};

  for (const [key, gate] of gates) {
    stats[key] = snapshotGate(gate);
  }

  return stats;
}

/**
 * Reset a single key and reject queued waiters.
 */
export function reset(semaphoreKey: string): void {
  const gate = gates.get(semaphoreKey);
  if (!gate) return;

  clearCleanupTimer(gate);
  for (const entry of gate.queue) {
    clearTimeout(entry.timer);
    entry.reject(new Error("Semaphore reset"));
  }
  gates.delete(semaphoreKey);
}

/**
 * Reset all keys and reject queued waiters.
 */
export function resetAll(): void {
  for (const key of gates.keys()) {
    reset(key);
  }
}
