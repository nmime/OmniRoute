import test from "node:test";
import assert from "node:assert/strict";

import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

process.env.STREAM_IDLE_TIMEOUT_MS = "50";
process.env.STREAM_READINESS_TIMEOUT_MS = "50";

const harness = await createChatPipelineHarness("chat-cooldown-aware-retry");
const auth = await import("../../src/sse/services/auth.ts");
const { getProviderConnectionById } = await import("../../src/lib/db/providers.ts");
const {
  BaseExecutor,
  buildOpenAIResponse,
  buildRequest,
  handleChat,
  resetStorage,
  seedConnection,
  settingsDb,
} = harness;
const textEncoder = new TextEncoder();
const originalRetryConfig = {
  maxAttempts: BaseExecutor.RETRY_CONFIG.maxAttempts,
  delayMs: BaseExecutor.RETRY_CONFIG.delayMs,
};

function buildRequestWithSignal(body, signal) {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function buildZombieSseResponse() {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(textEncoder.encode(": keepalive\n\n"));
        controller.enqueue(textEncoder.encode(`data: ${JSON.stringify({ type: "ping" })}\n\n`));
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }
  );
}

test.beforeEach(async () => {
  BaseExecutor.RETRY_CONFIG.maxAttempts = originalRetryConfig.maxAttempts;
  BaseExecutor.RETRY_CONFIG.delayMs = 0;
  await resetStorage();
});

test.afterEach(async () => {
  BaseExecutor.RETRY_CONFIG.maxAttempts = originalRetryConfig.maxAttempts;
  BaseExecutor.RETRY_CONFIG.delayMs = originalRetryConfig.delayMs;
  await resetStorage();
});

test.after(async () => {
  await harness.cleanup();
});

test("handleChat waits for a short cooldown and retries once within the configured budget", async () => {
  await seedConnection("openai", {
    apiKey: "sk-openai-cooldown-short",
    rateLimitedUntil: new Date(Date.now() + 950).toISOString(),
    lastError: "short cooldown window",
    errorCode: 429,
  });
  await settingsDb.updateSettings({
    requestRetry: 1,
    maxRetryIntervalSec: 1,
  });

  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return buildOpenAIResponse("recovered after cooldown");
  };

  const startedAt = Date.now();
  const response = await handleChat(
    buildRequest({
      body: {
        model: "openai/gpt-4.1",
        stream: false,
        messages: [{ role: "user", content: "retry after short cooldown" }],
      },
    })
  );
  const elapsedMs = Date.now() - startedAt;
  const body = (await response.json()) as any;

  assert.equal(response.status, 200);
  assert.equal(fetchCalls, 1);
  assert.ok(elapsedMs >= 250, `expected cooldown-aware retry wait, got ${elapsedMs}ms`);
  assert.equal(body.choices[0].message.content, "recovered after cooldown");
});

test("handleChat recovers from a real 429 once the connection cooldown expires", async () => {
  await seedConnection("openai", {
    apiKey: "sk-openai-live-429",
  });
  await settingsDb.updateSettings({
    requestRetry: 1,
    maxRetryIntervalSec: 3,
  });

  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    if (fetchCalls <= 3) {
      return new Response(
        JSON.stringify({
          error: {
            message: "Rate limit exceeded.",
          },
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "2",
          },
        }
      );
    }

    return buildOpenAIResponse("recovered after live 429");
  };

  const startedAt = Date.now();
  const response = await handleChat(
    buildRequest({
      body: {
        model: "openai/gpt-4.1",
        stream: false,
        messages: [{ role: "user", content: "trigger upstream 429 then recover" }],
      },
    })
  );
  const elapsedMs = Date.now() - startedAt;
  const body = (await response.json()) as any;

  assert.equal(response.status, 200);
  assert.equal(fetchCalls, 4);
  assert.ok(elapsedMs >= 1900, `expected retry wait after 429, got ${elapsedMs}ms`);
  assert.equal(body.choices[0].message.content, "recovered after live 429");
});

test("handleChat does not wait when the cooldown exceeds maxRetryIntervalSec", async () => {
  await seedConnection("openai", {
    apiKey: "sk-openai-cooldown-long",
    rateLimitedUntil: new Date(Date.now() + 100000).toISOString(),
    lastError: "cooldown too long",
    errorCode: 429,
  });
  await settingsDb.updateSettings({
    requestRetry: 2,
    maxRetryIntervalSec: 1,
  });

  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return buildOpenAIResponse("should not be called");
  };

  const response = await handleChat(
    buildRequest({
      body: {
        model: "openai/gpt-4.1",
        stream: false,
        messages: [{ role: "user", content: "do not wait beyond configured interval" }],
      },
    })
  );
  const body = (await response.json()) as any;

  assert.equal(fetchCalls, 0);
  assert.equal(response.status, 503);
  assert.match(body.error.message, /unavailable/i);
  assert.match(body.error.message, /reset after/i);
});

test("handleChat returns model_cooldown when every credential for the requested model is locked", async () => {
  const first = await seedConnection("gemini", {
    apiKey: "gemini-model-lock-first",
  });
  const second = await seedConnection("gemini", {
    apiKey: "gemini-model-lock-second",
  });
  await settingsDb.updateSettings({
    requestRetry: 0,
    maxRetryIntervalSec: 0,
  });

  await auth.markAccountUnavailable(
    (first as any).id,
    429,
    "too many requests",
    "gemini",
    "gemini-2.5-pro"
  );
  await auth.markAccountUnavailable(
    (second as any).id,
    429,
    "too many requests",
    "gemini",
    "gemini-2.5-pro"
  );

  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return buildOpenAIResponse("should not be called");
  };

  const response = await handleChat(
    buildRequest({
      body: {
        model: "gemini/gemini-2.5-pro",
        stream: false,
        messages: [{ role: "user", content: "model cooldown response" }],
      },
    })
  );
  const body = (await response.json()) as any;

  assert.equal(fetchCalls, 0);
  assert.equal(response.status, 429);
  assert.equal(body.error.code, "model_cooldown");
  assert.equal(body.error.type, "rate_limit_error");
  assert.equal(body.error.model, "gemini-2.5-pro");
  assert.ok(body.error.reset_seconds >= 1);
  assert.ok(Number(response.headers.get("Retry-After")) >= 1);
});

test("handleChat returns stream readiness timeout without entering cooldown-aware retry or account lockout", async () => {
  const connection = await seedConnection("openai", {
    apiKey: "sk-openai-stream-readiness-timeout",
  });
  await settingsDb.updateSettings({
    requestRetry: 1,
    maxRetryIntervalSec: 10,
  });

  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return buildZombieSseResponse();
  };

  const response = await handleChat(
    buildRequest({
      body: {
        model: "openai/gpt-4.1",
        stream: true,
        messages: [{ role: "user", content: "trigger zombie stream" }],
      },
    })
  );
  const body = (await response.json()) as any;

  assert.equal(response.status, 504);
  assert.equal(fetchCalls, 1);
  assert.equal(body.error.code, "STREAM_READINESS_TIMEOUT");

  const refreshedConnection = (await getProviderConnectionById((connection as any).id)) as any;
  assert.equal(refreshedConnection.testStatus, "active");
  assert.ok(refreshedConnection.rateLimitedUntil == null);
  assert.ok(refreshedConnection.errorCode == null);
  assert.equal(refreshedConnection.backoffLevel, 0);
});

test("handleChat aborts the pending cooldown wait when the client disconnects", async () => {
  await seedConnection("openai", {
    apiKey: "sk-openai-cooldown-abort",
    rateLimitedUntil: new Date(Date.now() + 5_000).toISOString(),
    lastError: "abort retry wait",
    errorCode: 429,
  });
  await settingsDb.updateSettings({
    requestRetry: 1,
    maxRetryIntervalSec: 10,
  });

  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return buildOpenAIResponse("should not run");
  };

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 40);

  const startedAt = Date.now();
  const response = await handleChat(
    buildRequestWithSignal(
      {
        model: "openai/gpt-4.1",
        stream: false,
        messages: [{ role: "user", content: "abort retry wait" }],
      },
      controller.signal
    )
  );
  const elapsedMs = Date.now() - startedAt;
  const body = (await response.json()) as any;

  assert.equal(fetchCalls, 0);
  assert.ok(elapsedMs < 1_000, `should abort cooldown wait promptly, got ${elapsedMs}ms`);
  assert.equal(response.status, 499);
  assert.equal(body.error.message, "Request aborted");
});


test("handleChat routes Codex from saturated selected account to another account with capacity", async () => {
  const selected = await seedConnection("codex", {
    name: "codex-selected-saturated",
    apiKey: "sk-codex-selected-saturated",
    maxConcurrent: 1,
  });
  const fallback = await seedConnection("codex", {
    name: "codex-fallback-capacity",
    apiKey: "sk-codex-fallback-capacity",
    maxConcurrent: 1,
  });
  await settingsDb.updateSettings({ fallbackStrategy: "fill-first" });

  const { buildAccountSemaphoreKey, acquire, getStats } = await import(
    "../../open-sse/services/accountSemaphore.ts"
  );
  const selectedKey = buildAccountSemaphoreKey({ provider: "codex", accountKey: (selected as any).id });
  const releaseSelected = await acquire(selectedKey, { maxConcurrency: 1, timeoutMs: 200 });

  let fetchCalls = 0;
  let usedAuth = "";
  globalThis.fetch = async (_url, init) => {
    fetchCalls += 1;
    usedAuth = String((init as any)?.headers?.Authorization || (init as any)?.headers?.authorization || "");
    return buildOpenAIResponse("codex fallback capacity");
  };

  try {
    const response = await handleChat(
      buildRequest({
        body: {
          model: "codex/gpt-5.5",
          stream: false,
          messages: [{ role: "user", content: "route around saturated account" }],
        },
      })
    );
    const body = (await response.json()) as any;

    assert.equal(response.status, 200);
    assert.equal(fetchCalls, 1);
    assert.match(usedAuth, /sk-codex-fallback-capacity/);
    assert.ok(body.id || body.choices || body.output, "expected a successful Codex response body");

    const stats = getStats();
    const fallbackKey = buildAccountSemaphoreKey({ provider: "codex", accountKey: (fallback as any).id });
    assert.equal(stats[selectedKey].running, 1);
    assert.equal(stats[fallbackKey]?.running ?? 0, 0);
  } finally {
    releaseSelected();
  }
});

test("handleChat fast-fails local Codex capacity without upstream call or provider poisoning", async () => {
  const first = await seedConnection("codex", {
    name: "codex-full-a",
    apiKey: "sk-codex-full-a",
    maxConcurrent: 1,
    priority: 1,
  });
  const second = await seedConnection("codex", {
    name: "codex-full-b",
    apiKey: "sk-codex-full-b",
    maxConcurrent: 1,
    priority: 2,
  });

  const { buildAccountSemaphoreKey, acquire } = await import(
    "../../open-sse/services/accountSemaphore.ts"
  );
  const releases = await Promise.all(
    [first, second].map((connection) =>
      acquire(buildAccountSemaphoreKey({ provider: "codex", accountKey: (connection as any).id }), {
        maxConcurrency: 1,
        timeoutMs: 200,
      })
    )
  );

  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return buildOpenAIResponse("should not be called");
  };

  const startedAt = Date.now();
  try {
    const response = await handleChat(
      buildRequest({
        body: {
          model: "codex/gpt-5.5",
          stream: false,
          messages: [{ role: "user", content: "all codex accounts full" }],
        },
      })
    );
    const elapsedMs = Date.now() - startedAt;
    const body = (await response.json()) as any;

    assert.equal(response.status, 429);
    assert.equal(fetchCalls, 0);
    assert.ok(elapsedMs < 1_000, `expected fast local capacity failure, got ${elapsedMs}ms`);
    assert.equal(body.error.code, "LOCAL_ACCOUNT_SEMAPHORE_FULL");
    assert.equal(body.error.type, "account_semaphore_capacity");

    const refreshedFirst = (await getProviderConnectionById((first as any).id)) as any;
    const refreshedSecond = (await getProviderConnectionById((second as any).id)) as any;
    for (const connection of [refreshedFirst, refreshedSecond]) {
      assert.equal(connection.testStatus, "active");
      assert.ok(connection.rateLimitedUntil == null);
      assert.ok(connection.errorCode == null);
      assert.equal(connection.backoffLevel, 0);
    }
  } finally {
    for (const release of releases) release();
  }
});
