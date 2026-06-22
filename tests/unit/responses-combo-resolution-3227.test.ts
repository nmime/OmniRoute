/**
 * #3227 / #3233 — combo names broke on /v1/responses in v3.8.9+.
 *
 * The generic HTTP Responses resolver must leave bare names available for
 * combo/model-combo routing and must not silently retry bare ids as codex/*;
 * Codex preference is limited to the codex-only WebSocket bridge or to normal
 * configured routing that already selected the Codex provider.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { resolveResponsesApiModel } from "../../src/app/api/internal/codex-responses-ws/modelResolution.ts";

// Resolver where bare ids resolve to a non-codex default, but codex accepts anything
// (mirrors real getModelInfo: the codex provider passes arbitrary model strings).
const resolver = async (modelStr: string) => {
  if (modelStr.startsWith("codex/")) return { provider: "codex", model: modelStr.slice(6) };
  if (modelStr === "gpt-5.5") return { provider: "openrouter", model: "gpt-5.5" };
  return { provider: "openrouter", model: modelStr };
};

test("a bare combo name is NOT rewritten to codex/ (it must resolve as a combo)", async () => {
  const isCombo = async (name: string) => name === "n8n-text" || name === "paid-premium";

  for (const combo of ["n8n-text", "paid-premium"]) {
    const out = await resolveResponsesApiModel(combo, resolver, isCombo);
    assert.equal(out.changed, false, `${combo} must not be codex-prefixed`);
    assert.equal(out.model, combo);
  }
});

test("a bare ChatGPT model id follows normal HTTP Responses routing without codex fallback", async () => {
  const isCombo = async () => false;
  const out = await resolveResponsesApiModel("gpt-5.5", resolver, isCombo);
  assert.equal(out.changed, false);
  assert.equal(out.model, "gpt-5.5");
});

test("a /v1/responses dashboard alias to chat-only OpenAI-compatible is preserved", async () => {
  const isCombo = async () => false;
  const resolveExplicit = async () => ({
    provider: "openai-compatible-chat-93db7",
    model: "gpt-5.5",
  });

  const out = await resolveResponsesApiModel("gpt-5.5", resolver, isCombo, resolveExplicit);

  assert.equal(out.changed, false);
  assert.equal(out.model, "gpt-5.5");
  assert.equal(out.error, undefined);
});

test("a /v1/responses dashboard alias to a Responses-capable custom provider is honored", async () => {
  const isCombo = async () => false;
  const resolveExplicit = async () => ({
    provider: "openai-compatible-chat-custom",
    model: "gpt-5.5",
    apiFormat: "responses",
  });

  const out = await resolveResponsesApiModel("gpt-5.5", resolver, isCombo, resolveExplicit);

  assert.equal(out.changed, false);
  assert.equal(out.model, "gpt-5.5");
  assert.equal(out.error, undefined);
});

test("an explicit provider-prefixed Responses request remains unchanged", async () => {
  const out = await resolveResponsesApiModel(
    "ar-op/gpt-5.5",
    async () => {
      throw new Error("provider-prefixed models should not be re-resolved");
    },
    async () => {
      throw new Error("provider-prefixed models should not be checked as combos");
    },
    async () => {
      throw new Error("provider-prefixed models should not be checked as aliases");
    }
  );

  assert.equal(out.changed, false);
  assert.equal(out.model, "ar-op/gpt-5.5");
});

test("a chat-only OpenAI-compatible responses alias is not converted to Codex when Codex is unavailable", async () => {
  const noCodexResolver = async (modelStr: string) => ({
    provider: "openai",
    model: modelStr,
  });
  const resolveExplicit = async () => ({
    provider: "openai-compatible-chat-93db7",
    model: "gpt-5.5",
  });

  const out = await resolveResponsesApiModel(
    "gpt-5.5",
    noCodexResolver,
    async () => false,
    resolveExplicit
  );

  assert.equal(out.changed, false);
  assert.equal(out.model, "gpt-5.5");
  assert.equal(out.error, undefined);
});

test("provider-prefixed ids pass through unchanged", async () => {
  const out = await resolveResponsesApiModel(
    "anthropic/claude-opus-4-8",
    resolver,
    async () => false
  );
  assert.equal(out.changed, false);
  assert.equal(out.model, "anthropic/claude-opus-4-8");
});
