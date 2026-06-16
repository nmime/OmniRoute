import { isDashboardSessionAuthenticated } from "@/shared/utils/apiAuth.ts";
import { isRequireApiKeyEnabled } from "@/shared/utils/featureFlags";
import { extractApiKey } from "@/sse/services/auth.ts";
import { getApiKeyMetadata, validateApiKey } from "@/lib/db/apiKeys";
import type { AuthOutcome, PolicyContext, RoutePolicy } from "../context";
import { allow, reject } from "../context";

function extractBearer(request: Request): string | null {
  const raw = request.headers.get("authorization") ?? request.headers.get("Authorization");
  const xApiKey = request.headers.get("x-api-key") ?? request.headers.get("X-Api-Key");
  if (raw) {
    const trimmed = raw.trim();
    if (trimmed.toLowerCase().startsWith("bearer ")) {
      const token = trimmed.slice(7).trim();
      if (token) return token;
    }
    // A non-"Bearer <token>" Authorization header (an empty "Bearer ", or a
    // client's own non-OmniRoute token — VS Code Copilot sends one even when the
    // OmniRoute key lives in the URL path of a /vscode tokenized endpoint) must
    // NOT short-circuit auth. Fall through to x-api-key and the path-scoped URL
    // token below instead of rejecting the request with "Authentication required".
  }

  if (xApiKey) {
    return xApiKey.trim() || null;
  }

  return extractApiKey(request);
}

function maskKeyId(apiKey: string): string {
  const tail = apiKey.slice(-4);
  return `key_${tail}`;
}

function isProviderBackedPostEndpoint(path: string, method: string): boolean {
  if (String(method).toUpperCase() !== "POST") return false;
  if (path === "/api/v1/responses" || path.startsWith("/api/v1/responses/")) return true;
  if (path === "/api/v1/chat/completions") return true;
  if (/^\/api\/v1\/providers\/[^/]+\/chat\/completions\/?$/.test(path)) return true;
  return false;
}

export const clientApiPolicy: RoutePolicy = {
  routeClass: "CLIENT_API",
  async evaluate(ctx: PolicyContext): Promise<AuthOutcome> {
    const bearer = extractBearer(ctx.request as Request);
    if (!bearer) {
      if (await isDashboardSessionAuthenticated(ctx.request)) {
        return allow({ kind: "dashboard_session", id: "dashboard" });
      }

      if (!isProviderBackedPostEndpoint(ctx.classification.normalizedPath, ctx.request.method)) {
        if (!isRequireApiKeyEnabled()) {
          return allow({ kind: "anonymous", id: "local" });
        }
      }

      return reject(401, "AUTH_002", "Authentication required");
    }

    const ok = await validateApiKey(bearer);
    const apiKeyInfo = ok ? await getApiKeyMetadata(bearer) : null;
    if (!ok || !apiKeyInfo) {
      // Issue #2257: when REQUIRE_API_KEY is off, a stale CLI config (Codex
      // Desktop auto-config, Hermes, etc.) carrying an invalid Bearer
      // shouldn't 401 the whole request — REQUIRE_API_KEY=false means
      // "anonymous traffic is allowed", so an invalid key should degrade to
      // anonymous instead of rejecting. We log a warning so the bad key is
      // still observable in the request log.
      if (!isProviderBackedPostEndpoint(ctx.classification.normalizedPath, ctx.request.method)) {
        if (!isRequireApiKeyEnabled()) {
          console.warn(
            `[clientApiPolicy] invalid bearer presented to ${ctx.classification.normalizedPath} ` +
              `but REQUIRE_API_KEY=false — falling through to anonymous (key_id=${maskKeyId(bearer)})`
          );
          return allow({ kind: "anonymous", id: "local" });
        }
      }
      return reject(401, "AUTH_002", "Invalid API key");
    }

    return allow({
      kind: "client_api_key",
      id: apiKeyInfo.id || maskKeyId(bearer),
      label: apiKeyInfo.name || undefined,
      scopes: apiKeyInfo.scopes || [],
    });
  },
};
