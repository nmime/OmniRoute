import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omr-require-client-auth-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "test-secret";
process.env.REQUIRE_API_KEY = "false";

const core = await import("../../../src/lib/db/core.ts");
const apiKeysDb = await import("../../../src/lib/db/apiKeys.ts");
const { requireClientApiAuth } = await import("../../../src/server/authz/requireClientApiAuth.ts");

function resetStorage() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  process.env.REQUIRE_API_KEY = "false";
}

test.beforeEach(() => {
  resetStorage();
});

test.after(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("requireClientApiAuth blocks unauthenticated /v1/responses before malformed body parsing", async () => {
  const request = new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not-json",
  });

  const response = await requireClientApiAuth(request);

  assert.ok(response);
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error.code, "AUTH_002");
});

test("requireClientApiAuth blocks unauthenticated /v1/chat/completions", async () => {
  const response = await requireClientApiAuth(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test/model", messages: [] }),
    })
  );

  assert.ok(response);
  assert.equal(response.status, 401);
});

test("requireClientApiAuth allows a valid API key to reach the route handler", async () => {
  const created = await apiKeysDb.createApiKey("route-auth-key", "machine-test-1234");
  assert.ok(created?.key, "createApiKey must return a key");

  const response = await requireClientApiAuth(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "x-api-key": created.key },
      body: JSON.stringify({ model: "test/model", input: "hi" }),
    })
  );

  assert.equal(response, null);
});
