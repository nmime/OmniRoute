/**
 * Account Semaphore
 *
 * In-memory provider/account concurrency limiter keyed by provider and account.
 * Requests beyond a selected account cap can queue on that account for non-Codex
 * providers. Codex uses waitForAccountSemaphoreCapacity() to wait briefly for any
 * eligible account to free capacity, then re-runs account selection instead of
 * queueing behind one already-full account.
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

interface CapacityWaiter {
  keys: Set<string>;
  resolve: (result: WaitForAccountSemaphoreCapacityResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup: () => void;
  startedAt: number;
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

export interface AccountSemaphoreCapacityKey {
  key: string;
  maxConcurrency?: number | null;
}

export interface WaitForAccountSemaphoreCapacityOptions {
  timeoutMs?: number;
  maxWaiters?: number;
  signal?: AbortSignal | null;
}

export type WaitForAccountSemaphoreCapacityReason =
  | "already_available"
  | "capacity_available"
  | "bypassed";

export interface WaitForAccountSemaphoreCapacityResult {
  key: string | null;
  reason: WaitForAccountSemaphoreCapacityReason;
  waitedMs: number;
  snapshot: Record<string, AccountSemaphoreStatsEntry>;
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
const DEFAULT_CAPACITY_WAIT_TIMEOUT_MS = 12_000;
const DEFAULT_CAPACITY_MAX_WAITERS = 30;

const gates = new Map<string, AccountGate>();
const capacityWaiters = new Set<CapacityWaiter>();

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
      notifyCapacityWaiters(semaphoreKey);
      return;
    }

    notifyCapacityWaiters(semaphoreKey);
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

function normalizeCapacityKey(
  entry: string | AccountSemaphoreCapacityKey
): AccountSemaphoreCapacityKey {
  if (typeof entry === "string") return { key: entry };
  return entry;
}

function snapshotKeys(keys: Iterable<string>): Record<string, AccountSemaphoreStatsEntry> {
  const snapshots: Record<string, AccountSemaphoreStatsEntry> = {};
  for (const key of keys) {
    const gate = gates.get(key);
    if (gate) snapshots[key] = snapshotGate(gate);
  }
  return snapshots;
}

function findAvailableCapacity(
  entries: AccountSemaphoreCapacityKey[]
): { key: string | null; reason: WaitForAccountSemaphoreCapacityReason } | null {
  for (const entry of entries) {
    if (!entry.key) continue;
    if (isBypassed(entry.maxConcurrency)) {
      return { key: entry.key, reason: "bypassed" };
    }

    const maxConcurrency = Number(entry.maxConcurrency);
    const gate = ensureGate(entry.key, maxConcurrency);
    clearCleanupTimer(gate);
    if (!isBlocked(gate) && gate.running < gate.maxConcurrency) {
      return { key: entry.key, reason: "capacity_available" };
    }
  }
  return null;
}

function notifyCapacityWaiters(releasedKey: string): void {
  if (capacityWaiters.size === 0) return;
  const now = Date.now();

  for (const waiter of Array.from(capacityWaiters)) {
    if (!waiter.keys.has(releasedKey)) continue;

    const available = findAvailableCapacity(
      Array.from(waiter.keys).map((key) => ({
        key,
        maxConcurrency: gates.get(key)?.maxConcurrency ?? null,
      }))
    );
    if (!available) continue;

    waiter.cleanup();
    waiter.resolve({
      key: available.key,
      reason: "capacity_available",
      waitedMs: Math.max(0, now - waiter.startedAt),
      snapshot: snapshotKeys(waiter.keys),
    });
  }
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

  const gate = ensureGate(semaphoreKey, Number(maxConcurrency));
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
 * Wait briefly until at least one of several account semaphore keys has capacity.
 *
 * This is intentionally NOT an acquire: callers must re-run account selection and
 * use tryAcquire() so a burst waiter is not pinned to the account that happened
 * to release. The waiter pool is process-wide, bounded, short-lived, and woken
 * by semaphore releases (no per-account 30s FIFO).
 */
export function waitForAccountSemaphoreCapacity(
  keys: Array<string | AccountSemaphoreCapacityKey>,
  {
    timeoutMs = DEFAULT_CAPACITY_WAIT_TIMEOUT_MS,
    maxWaiters = DEFAULT_CAPACITY_MAX_WAITERS,
    signal = null,
  }: WaitForAccountSemaphoreCapacityOptions = {}
): Promise<WaitForAccountSemaphoreCapacityResult> {
  const normalized = keys.map(normalizeCapacityKey).filter((entry) => entry.key);
  const keySet = new Set(normalized.map((entry) => entry.key));
  const startedAt = Date.now();

  const available = findAvailableCapacity(normalized);
  if (available) {
    return Promise.resolve({
      key: available.key,
      reason: "already_available",
      waitedMs: 0,
      snapshot: snapshotKeys(keySet),
    });
  }

  if (signal?.aborted) {
    return Promise.reject(makeAbortError(signal));
  }

  if (capacityWaiters.size >= maxWaiters) {
    const err = new Error(`Account semaphore capacity queue full (${maxWaiters})`) as Error & {
      code: string;
      waitedMs: number;
      snapshot: Record<string, AccountSemaphoreStatsEntry>;
    };
    err.code = "LOCAL_ACCOUNT_SEMAPHORE_QUEUE_FULL";
    err.waitedMs = 0;
    err.snapshot = snapshotKeys(keySet);
    return Promise.reject(err);
  }

  return new Promise((resolve, reject) => {
    let abortListener: (() => void) | null = null;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    let waiter: CapacityWaiter;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (waiter) capacityWaiters.delete(waiter);
      if (abortListener && signal) {
        signal.removeEventListener("abort", abortListener);
      }
    };

    const rejectWithCapacityError = (code: string, message: string) => {
      const err = new Error(message) as Error & {
        code: string;
        waitedMs: number;
        snapshot: Record<string, AccountSemaphoreStatsEntry>;
      };
      err.code = code;
      err.waitedMs = Math.max(0, Date.now() - startedAt);
      err.snapshot = snapshotKeys(keySet);
      cleanup();
      reject(err);
    };

    timer = setTimeout(() => {
      rejectWithCapacityError(
        "LOCAL_ACCOUNT_SEMAPHORE_QUEUE_TIMEOUT",
        `Account semaphore capacity queue timed out after ${timeoutMs}ms`
      );
    }, timeoutMs);
    timer.unref?.();

    waiter = {
      keys: keySet,
      resolve: (result) => {
        cleanup();
        resolve(result);
      },
      reject: (error) => {
        cleanup();
        reject(error);
      },
      timer,
      cleanup,
      startedAt,
    };

    capacityWaiters.add(waiter);

    if (signal) {
      abortListener = () => {
        const error = makeAbortError(signal);
        cleanup();
        reject(error);
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

  const gate = ensureGate(semaphoreKey, Number(maxConcurrency));
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
  for (const waiter of Array.from(capacityWaiters)) {
    if (!waiter.keys.has(semaphoreKey)) continue;
    waiter.cleanup();
    waiter.reject(new Error("Semaphore reset"));
  }

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
  for (const waiter of Array.from(capacityWaiters)) {
    waiter.cleanup();
    waiter.reject(new Error("Semaphore reset"));
  }
  for (const key of gates.keys()) {
    reset(key);
  }
}
