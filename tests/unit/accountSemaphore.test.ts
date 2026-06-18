import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  acquire,
  buildAccountSemaphoreKey,
  getSnapshot,
  getStats,
  markBlocked,
  reset,
  resetAll,
  tryAcquire,
  waitForAccountSemaphoreCapacity,
} from "../../open-sse/services/accountSemaphore";

afterEach(() => {
  resetAll();
});

describe("accountSemaphore", async () => {
  it("queues requests beyond the account cap and drains on release", async () => {
    const key = buildAccountSemaphoreKey({
      provider: "alibaba",
      accountKey: "acct-1",
    });

    const releaseA = await acquire(key, { maxConcurrency: 2, timeoutMs: 200 });
    const releaseB = await acquire(key, { maxConcurrency: 2, timeoutMs: 200 });
    const queued = acquire(key, { maxConcurrency: 2, timeoutMs: 200 });

    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(getStats()[key], {
      running: 2,
      queued: 1,
      maxConcurrency: 2,
      blockedUntil: null,
    });

    releaseA();
    const releaseC = await queued;

    assert.deepEqual(getStats()[key], {
      running: 2,
      queued: 0,
      maxConcurrency: 2,
      blockedUntil: null,
    });

    releaseA();
    releaseB();
    releaseC();

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(getStats()[key], undefined);
  });

  it("returns a no-op release when concurrency is bypassed", async () => {
    const key = buildAccountSemaphoreKey({
      provider: "alibaba",
      accountKey: "acct-bypass",
    });

    const release = await acquire(key, { maxConcurrency: 0, timeoutMs: 50 });

    assert.deepEqual(getStats(), {});

    release();

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(getStats()[key], undefined);
  });

  it("uses SEMAPHORE_TIMEOUT for timed out queued requests", async () => {
    const key = buildAccountSemaphoreKey({
      provider: "alibaba",
      accountKey: "acct-timeout",
    });

    const releaseA = await acquire(key, { maxConcurrency: 1, timeoutMs: 200 });
    const queued = acquire(key, { maxConcurrency: 1, timeoutMs: 200 });
    const keepAlive = setTimeout(() => {}, 250);

    try {
      await queued;
      assert.fail("Expected timeout error");
    } catch (err: unknown) {
      assert.ok(err instanceof Error);
      const error = err as Error & { code?: string };
      assert.equal(error.code, "SEMAPHORE_TIMEOUT");
    } finally {
      clearTimeout(keepAlive);
    }

    releaseA();

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(getStats()[key], undefined);
  });

  it("keeps release idempotent for finally blocks", async () => {
    const key = buildAccountSemaphoreKey({
      provider: "alibaba",
      accountKey: "acct-idempotent",
    });

    const releaseA = await acquire(key, { maxConcurrency: 1, timeoutMs: 200 });

    // Simulate a finally block calling release twice
    releaseA();
    releaseA();
    releaseA();

    // The second acquire should succeed immediately (slot was released)
    const releaseB = await acquire(key, { maxConcurrency: 1, timeoutMs: 200 });

    assert.deepEqual(getStats()[key], {
      running: 1,
      queued: 0,
      maxConcurrency: 1,
      blockedUntil: null,
    });

    releaseB();

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(getStats()[key], undefined);
  });

  it("supports temporary blocking and explicit reset hooks", async () => {
    const key = buildAccountSemaphoreKey({
      provider: "alibaba",
      accountKey: "acct-blocked",
    });

    await acquire(key, { maxConcurrency: 1, timeoutMs: 200 });

    assert.deepEqual(getStats()[key], {
      running: 1,
      queued: 0,
      maxConcurrency: 1,
      blockedUntil: null,
    });

    markBlocked(key, 50);

    // Should block even though slot is available
    const acquired = acquire(key, { maxConcurrency: 1, timeoutMs: 100 });

    await new Promise((resolve) => setTimeout(resolve, 30));

    // Should still be queued because the gate is blocked
    const stats = getStats()[key];
    assert.equal(stats.running, 1);
    assert.equal(stats.queued, 1);
    assert.equal(stats.maxConcurrency, 1);
    assert.ok(stats.blockedUntil !== null, "blockedUntil should be set");

    reset(key);

    await assert.rejects(async () => {
      await acquired;
    });
  });

  it("preserves existing maxConcurrency when markBlocked is applied", async () => {
    const key = buildAccountSemaphoreKey({
      provider: "alibaba",
      accountKey: "acct-preserve",
    });

    await acquire(key, { maxConcurrency: 2, timeoutMs: 200 });
    markBlocked(key, 50);

    const stats = getStats()[key];
    assert.equal(stats.running, 1);
    assert.equal(stats.queued, 0);
    assert.equal(stats.maxConcurrency, 2);
    assert.ok(stats.blockedUntil !== null, "blockedUntil should be set");
  });

  it("tryAcquire reports full accounts immediately without queueing", async () => {
    const key = buildAccountSemaphoreKey({ provider: "codex", accountKey: "acct-full" });

    const release = await acquire(key, { maxConcurrency: 1, timeoutMs: 200 });
    const result = tryAcquire(key, { maxConcurrency: 1 });

    assert.equal(result.acquired, false);
    assert.equal(result.reason, "full");
    assert.equal(result.snapshot.running, 1);
    assert.equal(result.snapshot.queued, 0);
    assert.deepEqual(getSnapshot(key), {
      running: 1,
      queued: 0,
      maxConcurrency: 1,
      blockedUntil: null,
    });

    result.release();
    release();
    assert.equal(getStats()[key]?.running ?? 0, 0);
  });

  it("tryAcquire reports blocked accounts distinctly without poisoning provider state", async () => {
    const key = buildAccountSemaphoreKey({ provider: "codex", accountKey: "acct-blocked" });

    markBlocked(key, 1_000);
    const result = tryAcquire(key, { maxConcurrency: 1 });

    assert.equal(result.acquired, false);
    assert.equal(result.reason, "blocked");
    assert.equal(result.snapshot.running, 0);
    assert.equal(result.snapshot.queued, 0);
    assert.ok(result.snapshot.blockedUntil);
  });

  it("waitForAccountSemaphoreCapacity wakes on any eligible release without acquiring", async () => {
    const keyA = buildAccountSemaphoreKey({ provider: "codex", accountKey: "acct-a" });
    const keyB = buildAccountSemaphoreKey({ provider: "codex", accountKey: "acct-b" });

    const releaseA = await acquire(keyA, { maxConcurrency: 1, timeoutMs: 200 });
    const releaseB = await acquire(keyB, { maxConcurrency: 1, timeoutMs: 200 });

    const startedAt = Date.now();
    const waiter = waitForAccountSemaphoreCapacity(
      [
        { key: keyA, maxConcurrency: 1 },
        { key: keyB, maxConcurrency: 1 },
      ],
      { timeoutMs: 500, maxWaiters: 5 }
    );

    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseB();

    const result = await waiter;
    assert.equal(result.key, keyB);
    assert.equal(result.reason, "capacity_available");
    assert.ok(result.waitedMs >= 20);
    assert.ok(Date.now() - startedAt < 250);
    assert.equal(getStats()[keyB]?.running ?? 0, 0, "waiter must not acquire the released slot");

    releaseA();
  });

  it("waitForAccountSemaphoreCapacity times out quickly with safe snapshot metadata", async () => {
    const key = buildAccountSemaphoreKey({ provider: "codex", accountKey: "acct-timeout-local" });
    const release = await acquire(key, { maxConcurrency: 1, timeoutMs: 200 });
    const startedAt = Date.now();

    await assert.rejects(
      waitForAccountSemaphoreCapacity([{ key, maxConcurrency: 1 }], {
        timeoutMs: 40,
        maxWaiters: 5,
      }),
      (err: unknown) => {
        const error = err as Error & {
          code?: string;
          waitedMs?: number;
          snapshot?: Record<string, unknown>;
        };
        assert.equal(error.code, "LOCAL_ACCOUNT_SEMAPHORE_QUEUE_TIMEOUT");
        assert.ok(Number(error.waitedMs) >= 30);
        assert.ok(Date.now() - startedAt < 500);
        assert.ok(error.snapshot?.[key]);
        return true;
      }
    );

    release();
  });

  it("waitForAccountSemaphoreCapacity rejects immediately when the local queue is full", async () => {
    const key = buildAccountSemaphoreKey({ provider: "codex", accountKey: "acct-queue-full" });
    const release = await acquire(key, { maxConcurrency: 1, timeoutMs: 200 });
    const firstWaiter = waitForAccountSemaphoreCapacity([{ key, maxConcurrency: 1 }], {
      timeoutMs: 500,
      maxWaiters: 1,
    });

    await assert.rejects(
      waitForAccountSemaphoreCapacity([{ key, maxConcurrency: 1 }], {
        timeoutMs: 500,
        maxWaiters: 1,
      }),
      (err: unknown) => {
        const error = err as Error & { code?: string; waitedMs?: number };
        assert.equal(error.code, "LOCAL_ACCOUNT_SEMAPHORE_QUEUE_FULL");
        assert.equal(error.waitedMs, 0);
        return true;
      }
    );

    release();
    const result = await firstWaiter;
    assert.equal(result.key, key);
  });
});
