import test from "node:test";
import assert from "node:assert/strict";

import {
  handleResponsesWithCodexFallback,
  isRetryableResponsesPrimaryFailure,
  resolveCodexFallbackModelForResponses,
} from "../../src/app/api/v1/responses/route.ts";

const arimaAlias = async (model: string) =>
  model === "gpt-5.5" || model === "gpt5.5"
    ? {
        provider: "openai-compatible-chat-93db733c-9e86-4777-9d0a-d1c336141559",
        model,
      }
    : null;

test("bare gpt-5.5/gpt5.5 configured to Arima resolves Arima primary with Codex fallback model", async () => {
  assert.equal(await resolveCodexFallbackModelForResponses("gpt-5.5", arimaAlias), "codex/gpt-5.5");
  assert.equal(await resolveCodexFallbackModelForResponses("gpt5.5", arimaAlias), "codex/gpt5.5");
});

test("explicit Codex and explicit Arima requests are not surprise-rerouted by responses fallback", async () => {
  const throwingResolver = async () => {
    throw new Error("provider-prefixed ids must not be resolved for fallback");
  };

  assert.equal(
    await resolveCodexFallbackModelForResponses("codex/gpt-5.5", throwingResolver),
    null
  );
  assert.equal(await resolveCodexFallbackModelForResponses("cx/gpt-5.5", throwingResolver), null);
  assert.equal(
    await resolveCodexFallbackModelForResponses("ar-op/gpt-5.5", throwingResolver),
    null
  );
});

test("Arima retryable failure falls back to Codex and succeeds for /v1/responses", async () => {
  const seenModels: string[] = [];
  const request = new Request("https://example.test/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.5", input: "ping" }),
  });

  const response = await handleResponsesWithCodexFallback(
    request,
    { model: "gpt-5.5", input: "ping" },
    async (req) => {
      const body = await req.clone().json();
      seenModels.push(body.model);
      if (seenModels.length === 1) {
        return new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      assert.equal(body.model, "codex/gpt-5.5");
      return new Response(JSON.stringify({ id: "resp_ok", output_text: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    async () => "codex/gpt-5.5"
  );

  assert.equal(response.status, 200);
  assert.deepEqual(seenModels, ["gpt-5.5", "codex/gpt-5.5"]);
});

test("Arima safe 400 capability/format failure is retryable but auth/client failures are not", async () => {
  assert.equal(
    await isRetryableResponsesPrimaryFailure(
      new Response(
        JSON.stringify({ error: { message: "unsupported response format for this model" } }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        }
      )
    ),
    true
  );

  assert.equal(
    await isRetryableResponsesPrimaryFailure(
      new Response(JSON.stringify({ error: { message: "invalid api key for provider" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })
    ),
    false
  );

  assert.equal(
    await isRetryableResponsesPrimaryFailure(
      new Response(JSON.stringify({ error: { message: "unauthorized" } }), { status: 401 })
    ),
    false
  );
});

test("non-retryable Arima client failure does not fall back to Codex", async () => {
  let calls = 0;
  const request = new Request("https://example.test/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.5", input: "ping" }),
  });

  const response = await handleResponsesWithCodexFallback(
    request,
    { model: "gpt-5.5", input: "ping" },
    async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: "invalid api key for provider" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    },
    async () => "codex/gpt-5.5"
  );

  assert.equal(response.status, 400);
  assert.equal(calls, 1);
});
