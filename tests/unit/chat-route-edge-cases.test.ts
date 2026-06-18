import test from "node:test";
import assert from "node:assert/strict";

import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

const harness = await createChatPipelineHarness("chat-route-edges");
const {
  BaseExecutor,
  buildClaudeResponse,
  buildOpenAIResponse,
  buildRequest,
  handleChat,
  resetStorage,
  seedConnection,
  settingsDb,
  idempotencyLayerModule,
  semanticCacheModule,
} = harness;

const { getBackgroundDegradationConfig } =
  await import("../../open-sse/services/backgroundTaskDetector.ts");
const { setCustomAliases } = await import("../../open-sse/services/modelDeprecation.ts");
const { setModelAlias } = await import("../../src/lib/db/models.ts");
const accountSemaphore = await import("../../open-sse/services/accountSemaphore.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const { getCallLogs, getCallLogById } = await import("../../src/lib/usage/callLogs.ts");

test.beforeEach(async () => {
  BaseExecutor.RETRY_CONFIG.delayMs = 0;
  accountSemaphore.resetAll();
  await resetStorage();
});

test.afterEach(async () => {
  accountSemaphore.resetAll();
  await resetStorage();
});

test.after(async () => {
  await harness.cleanup();
});

test("handleChat queues codex local capacity bursts then routes after a release", async () => {
  const accountA = await seedConnection("codex", {
    name: "codex-cap-a",
    apiKey: "sk-codex-cap-a",
    maxConcurrent: 1,
  });
  const accountB = await seedConnection("codex", {
    name: "codex-cap-b",
    apiKey: "sk-codex-cap-b",
    maxConcurrent: 1,
  });
  const keyA = accountSemaphore.buildAccountSemaphoreKey({
    provider: "codex",
    accountKey: accountA.id,
  });
  const keyB = accountSemaphore.buildAccountSemaphoreKey({
    provider: "codex",
    accountKey: accountB.id,
  });
  const releaseA = await accountSemaphore.acquire(keyA, { maxConcurrency: 1, timeoutMs: 100 });
  const releaseB = await accountSemaphore.acquire(keyB, { maxConcurrency: 1, timeoutMs: 100 });
  let upstreamCalls = 0;

  globalThis.fetch = async () => {
    upstreamCalls++;
    return buildOpenAIResponse("Queued codex response");
  };

  const responsePromise = handleChat(
    buildRequest({
      body: {
        model: "codex/gpt-5",
        stream: false,
        messages: [{ role: "user", content: "queued burst" }],
      },
    })
  );

  await new Promise((resolve) => setTimeout(resolve, 25));
  releaseB();
  const response = await responsePromise;

  assert.equal(response.status, 200);
  assert.equal(upstreamCalls, 1);
  assert.equal(accountSemaphore.getStats()[keyB]?.running ?? 0, 0);

  releaseA();
});

test("handleChat returns sanitized 429 when codex local capacity queue times out", async () => {
  await settingsDb.updateSettings({ call_log_pipeline_enabled: true });
  const accountA = await seedConnection("codex", {
    name: "codex-timeout-a",
    apiKey: "sk-codex-timeout-a",
    maxConcurrent: 1,
  });
  const accountB = await seedConnection("codex", {
    name: "codex-timeout-b",
    apiKey: "sk-codex-timeout-b",
    maxConcurrent: 1,
  });
  const releaseA = await accountSemaphore.acquire(
    accountSemaphore.buildAccountSemaphoreKey({ provider: "codex", accountKey: accountA.id }),
    { maxConcurrency: 1, timeoutMs: 100 }
  );
  const releaseB = await accountSemaphore.acquire(
    accountSemaphore.buildAccountSemaphoreKey({ provider: "codex", accountKey: accountB.id }),
    { maxConcurrency: 1, timeoutMs: 100 }
  );
  const originalTimeout = process.env.CODEX_LOCAL_CAPACITY_QUEUE_TIMEOUT_MS;
  process.env.CODEX_LOCAL_CAPACITY_QUEUE_TIMEOUT_MS = "40";
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls++;
    return buildOpenAIResponse("should not call upstream");
  };

  try {
    const startedAt = Date.now();
    const response = await handleChat(
      buildRequest({
        body: {
          model: "codex/gpt-5",
          stream: false,
          messages: [{ role: "user", content: "timeout burst" }],
        },
      })
    );
    const payload = await response.json();

    assert.equal(response.status, 429);
    assert.equal(payload.error.type, "account_semaphore_capacity");
    assert.equal(payload.error.code, "LOCAL_ACCOUNT_SEMAPHORE_QUEUE_TIMEOUT");
    assert.equal(response.headers.get("Retry-After"), "1");
    assert.equal(upstreamCalls, 0);
    assert.ok(Date.now() - startedAt < 1000);

    const rows = await Promise.all([
      providersDb.getProviderConnectionById(accountA.id),
      providersDb.getProviderConnectionById(accountB.id),
    ]);
    assert.deepEqual(
      rows.map((row) => row.rateLimitedUntil ?? null),
      [null, null]
    );
    assert.deepEqual(
      rows.map((row) => row.backoffLevel ?? 0),
      [0, 0]
    );
  } finally {
    if (originalTimeout === undefined) {
      delete process.env.CODEX_LOCAL_CAPACITY_QUEUE_TIMEOUT_MS;
    } else {
      process.env.CODEX_LOCAL_CAPACITY_QUEUE_TIMEOUT_MS = originalTimeout;
    }
    releaseA();
    releaseB();
  }
});

test("handleChat returns and persists sanitized 429 when codex local capacity queue is full", async () => {
  const account = await seedConnection("codex", {
    name: "codex-queue-full-chat",
    apiKey: "sk-codex-queue-full-chat",
    maxConcurrent: 1,
  });
  const key = accountSemaphore.buildAccountSemaphoreKey({
    provider: "codex",
    accountKey: account.id,
  });
  const release = await accountSemaphore.acquire(key, { maxConcurrency: 1, timeoutMs: 100 });
  const originalTimeout = process.env.CODEX_LOCAL_CAPACITY_QUEUE_TIMEOUT_MS;
  const originalMaxWaiters = process.env.CODEX_LOCAL_CAPACITY_QUEUE_MAX_WAITERS;
  process.env.CODEX_LOCAL_CAPACITY_QUEUE_TIMEOUT_MS = "500";
  process.env.CODEX_LOCAL_CAPACITY_QUEUE_MAX_WAITERS = "1";
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls++;
    return buildOpenAIResponse("queued after full");
  };

  try {
    const first = handleChat(
      buildRequest({
        body: {
          model: "codex/gpt-5",
          stream: false,
          messages: [{ role: "user", content: "first waiter" }],
        },
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 25));

    const response = await handleChat(
      buildRequest({
        body: {
          model: "codex/gpt-5",
          stream: false,
          messages: [{ role: "user", content: "second waiter" }],
        },
      })
    );
    const payload = await response.json();

    assert.equal(response.status, 429);
    assert.equal(payload.error.type, "account_semaphore_capacity");
    assert.equal(payload.error.code, "LOCAL_ACCOUNT_SEMAPHORE_QUEUE_FULL");
    assert.equal(upstreamCalls, 0);

    await new Promise((resolve) => setTimeout(resolve, 25));
    const rows = await getCallLogs({ limit: 5 });
    const detail = rows[0] ? await getCallLogById(rows[0].id) : null;
    assert.equal(detail?.requestBody ?? null, null);
    assert.equal(detail?.responseBody ?? null, null);
    assert.equal(detail?.error?.code, "LOCAL_ACCOUNT_SEMAPHORE_QUEUE_FULL");
    assert.equal(detail?.error?.type, "account_semaphore_capacity");

    release();
    const firstResponse = await first;
    assert.equal(firstResponse.status, 200);
    assert.equal(upstreamCalls, 1);
  } finally {
    if (originalTimeout === undefined) {
      delete process.env.CODEX_LOCAL_CAPACITY_QUEUE_TIMEOUT_MS;
    } else {
      process.env.CODEX_LOCAL_CAPACITY_QUEUE_TIMEOUT_MS = originalTimeout;
    }
    if (originalMaxWaiters === undefined) {
      delete process.env.CODEX_LOCAL_CAPACITY_QUEUE_MAX_WAITERS;
    } else {
      process.env.CODEX_LOCAL_CAPACITY_QUEUE_MAX_WAITERS = originalMaxWaiters;
    }
    release();
  }
});

test("handleChat resolves model alias before routing", async () => {
  await seedConnection("openai", { apiKey: "sk-openai" });
  // setModelAlias writes to key_value namespace='modelAliases', which is the
  // namespace that getModelAliases() (used by getModelInfo in chatCore) reads from.
  // settingsDb.updateSettings({ modelAliases }) writes to namespace='settings' and
  // triggers setCustomAliases (in-memory only) — a separate store not consulted here.
  await setModelAlias("alias-model", "openai/gpt-4.1");

  const seenModels = [];
  globalThis.fetch = async (_url, init = {}) => {
    try {
      const body = JSON.parse(String(init.body));
      seenModels.push(body.model);
    } catch {}
    return buildOpenAIResponse("Alias response");
  };

  const response = await handleChat(
    buildRequest({
      body: {
        model: "alias-model",
        stream: false,
        messages: [{ role: "user", content: "Test alias" }],
      },
    })
  );

  assert.equal(response.status, 200, "Should succeed with 200 OK");
  assert.equal(seenModels[0], "gpt-4.1", "Model alias should be resolved to gpt-4.1");
});

test("Test 3: handleChat returns cached response directly for Semantic Cache hits", async () => {
  await seedConnection("openai", { apiKey: "sk-openai-semantic" });
  let fetchCount = 0;

  globalThis.fetch = async (_url, init) => {
    fetchCount++;
    const bodyStr = String(init.body);
    const body = JSON.parse(bodyStr);
    assert.equal(body.temperature, 0);

    return new Response(
      JSON.stringify({
        id: `chatcmpl_${fetchCount}`,
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: `Cache Generation ${fetchCount}` },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const req1 = buildRequest({
    body: {
      model: "openai/gpt-4",
      stream: false,
      temperature: 0,
      messages: [{ role: "user", content: "semantic hit" }],
    },
  });

  const res1 = await handleChat(req1);
  await res1.json();
  assert.equal(fetchCount, 1);
  await new Promise((r) => setTimeout(r, 100)); // allow background cache write

  const req2 = buildRequest({
    body: {
      model: "openai/gpt-4",
      stream: false,
      temperature: 0,
      messages: [{ role: "user", content: "semantic hit" }],
    },
  });

  const res2 = await handleChat(req2);
  const json2 = (await res2.json()) as any;

  assert.equal(fetchCount, 1, "Should have hit the semantic cache without calling fetch again");
  assert.equal(json2.choices[0].message.content, "Cache Generation 1");
  assert.equal(res2.headers.get("X-OmniRoute-Cache"), "HIT");
});

test("Test 4: handleChat supports X-OmniRoute-Progress tracking header for streams", async () => {
  await seedConnection("openai", { apiKey: "sk-openai-progress" });

  globalThis.fetch = async () => {
    return new Response(
      [
        `data: {"id":"chatcmpl","choices":[{"delta":{"content":"P"},"index":0}]}`,
        `data: {"id":"chatcmpl","choices":[{"delta":{"content":"rogress"},"index":0}]}`,
        `data: [DONE]`,
        "",
      ].join("\n\n"),
      {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }
    );
  };

  const response = await handleChat(
    buildRequest({
      headers: {
        "X-OmniRoute-Progress": "true",
      },
      body: {
        model: "openai/gpt-4",
        stream: true,
        messages: [{ role: "user", content: "progress check" }],
      },
    })
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-OmniRoute-Progress"), "enabled");

  const raw = await response.text();
  assert.match(raw, /event: progress/); // check that progress chunks were injected
  assert.match(raw, /content":"P"/);
});

test("Test 5: isTokenExpiringSoon detects token boundaries", async () => {
  const { isTokenExpiringSoon } = await import("../../open-sse/handlers/chatCore.ts");
  const now = Date.now();

  assert.equal(isTokenExpiringSoon(null), false);
  assert.equal(
    isTokenExpiringSoon(new Date(now + 10 * 60 * 1000).toISOString(), 5 * 60 * 1000),
    false
  );
  assert.equal(
    isTokenExpiringSoon(new Date(now + 2 * 60 * 1000).toISOString(), 5 * 60 * 1000),
    true
  );
  assert.equal(
    isTokenExpiringSoon(new Date(now - 1 * 60 * 1000).toISOString(), 5 * 60 * 1000),
    true
  );
});

test("handleChat returns cached response directly for Idempotency hits", async () => {
  await seedConnection("openai", { apiKey: "sk-openai-idem" });

  globalThis.fetch = async () => buildOpenAIResponse("Original response");

  const reqBody = {
    model: "openai/gpt-4",
    stream: false,
    messages: [{ role: "user", content: "Idempotent req" }],
  };

  // First request: hits API and saves idempotency
  const response1 = await handleChat(
    buildRequest({
      headers: { "idempotency-key": "req-idempotent-123" },
      body: reqBody,
    })
  );
  await response1.json(); // Consume body

  const response2 = await handleChat(
    buildRequest({
      headers: { "idempotency-key": "req-idempotent-123" },
      body: reqBody,
    })
  );

  const json2 = (await response2.json()) as any;
  assert.equal(response2.status, 200);
  assert.equal(response2.headers.get("X-OmniRoute-Idempotent"), "true");
  assert.equal(json2.choices[0].message.content, "Original response");
});

test("Test 6: handleChat correctly sets isResponsesEndpoint for /v1/responses", async () => {
  await seedConnection("openai", { apiKey: "sk-openai-responses" });

  globalThis.fetch = async (_url, init) => {
    return new Response(
      JSON.stringify({
        id: "chatcmpl-responses",
        object: "chat.completion",
        choices: [
          { message: { role: "assistant", content: "Responses OK" }, finish_reason: "stop" },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const response = await handleChat(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-4",
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      }),
    })
  );

  const json = (await response.json()) as any;
  assert.equal(response.status, 200);
  const responseText = json.output_text || json.output?.[0]?.content?.[0]?.text;
  assert.equal(responseText, "Responses OK");
});

test("handleChat returns Semantic Cache hit", async () => {
  await seedConnection("openai", { apiKey: "sk-openai-semantic" });
  globalThis.fetch = async () => buildOpenAIResponse("Semantic API response");

  const model = "openai/gpt-4";
  const messages = [{ role: "user", content: "Semantic query test" }];
  const reqBody = {
    model,
    stream: false,
    temperature: 0, // required for cacheable
    messages,
  };

  // First request: hits API and saves semantic cache
  const response1 = await handleChat(buildRequest({ body: reqBody }));
  await response1.json(); // Consume body

  // Second request: should hit semantic cache
  const response2 = await handleChat(buildRequest({ body: reqBody }));

  const json2 = (await response2.json()) as any;
  assert.equal(response2.status, 200);
  assert.equal(response2.headers.get("X-OmniRoute-Cache"), "HIT");
  assert.equal(json2.choices[0].message.content, "Semantic API response");
});
