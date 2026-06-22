import { handleChat } from "@/sse/handlers/chat";
import { withEarlyStreamKeepalive } from "@omniroute/open-sse/utils/earlyStreamKeepalive";
import { withInjectionGuard } from "@/middleware/promptInjectionGuard";
import { resolveResponsesApiModel } from "@/app/api/internal/codex-responses-ws/modelResolution";
import { getModelInfo, resolveConfiguredModelAlias } from "@/sse/services/model";
import { getComboByName } from "@/lib/db/combos";
import { resolveKeepaliveThreshold } from "@omniroute/open-sse/utils/keepaliveThreshold";
import { requireClientApiAuth } from "@/server/authz/requireClientApiAuth";

// NOTE: We do NOT call initTranslators() here — the translator registry is
// bootstrapped at module level inside open-sse/translator/index.ts when it
// is first imported. Calling it again from a Next.js Route Handler caused a
// "the worker has exited" uncaughtException crash on Codex CLI requests (#450)
// because the dynamic import runs in a Next.js server worker context where
// certain Node APIs used by the translator bootstrap are not available.
// The translators are always initialized via the open-sse side (chatCore),
// so /v1/responses just delegates to handleChat which handles everything.

const CODEX_FALLBACK_RESPONSE_MODELS = new Set([
  "gpt-5.5",
  "gpt5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
]);

type ChatDispatcher = (request: Request) => Promise<Response>;

function isOpenAICompatibleProvider(provider: unknown): provider is string {
  return typeof provider === "string" && provider.startsWith("openai-compatible-");
}

function responseTextLooksLikeCapabilityMismatch(text: string): boolean {
  const lower = text.toLowerCase();
  if (
    /\b(api[-_ ]?key|authorization|unauthori[sz]ed|forbidden|permission|credential|oauth|token)\b/.test(
      lower
    )
  ) {
    return false;
  }

  return (
    /\b(unsupported|not supported|not_support|capabilit|incompatible|format|schema|parameter|messages?|roles?|tools?|responses api|chat completions?)\b/.test(
      lower
    ) &&
    /\b(model|provider|upstream|responses?|chat|format|schema|parameter|tool|message|role)\b/.test(
      lower
    )
  );
}

export async function isRetryableResponsesPrimaryFailure(response: Response): Promise<boolean> {
  const status = Number(response.status || 0);
  if (status === 429 || status === 408 || status === 409 || status === 425) return true;
  if (status >= 500 && status <= 599) return true;
  if (status !== 400) return false;

  try {
    const text = await response.clone().text();
    return responseTextLooksLikeCapabilityMismatch(text.slice(0, 8192));
  } catch {
    return false;
  }
}

export async function resolveCodexFallbackModelForResponses(
  requestedModel: unknown,
  resolveExplicit = resolveConfiguredModelAlias
): Promise<string | null> {
  if (typeof requestedModel !== "string" || !requestedModel || requestedModel.includes("/")) {
    return null;
  }
  if (!CODEX_FALLBACK_RESPONSE_MODELS.has(requestedModel)) return null;

  try {
    const explicit = await resolveExplicit(requestedModel);
    if (!explicit?.provider || explicit.provider === "codex") return null;
    if (!isOpenAICompatibleProvider(explicit.provider)) return null;
    return `codex/${String(explicit.model || requestedModel)}`;
  } catch {
    return null;
  }
}

function requestWithJsonModel(
  request: Request,
  body: Record<string, unknown>,
  model: string
): Request {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify({ ...body, model }),
    signal: request.signal,
  });
}

export async function handleResponsesWithCodexFallback(
  primaryRequest: Request,
  originalBody: Record<string, unknown> | null,
  dispatch: ChatDispatcher = handleChat,
  resolveFallbackModel = resolveCodexFallbackModelForResponses
): Promise<Response> {
  const primaryResponse = await dispatch(primaryRequest);
  if (primaryResponse.ok || !originalBody) return primaryResponse;

  const fallbackModel = await resolveFallbackModel(originalBody.model);
  if (!fallbackModel) return primaryResponse;
  if (!(await isRetryableResponsesPrimaryFailure(primaryResponse))) return primaryResponse;

  return await dispatch(requestWithJsonModel(primaryRequest, originalBody, fallbackModel));
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * Rewrite a bare ChatGPT-style model id to the codex/ prefix when the model
 * resolves to a codex provider. This fixes the Codex CLI WS→HTTP fallback path:
 * the CLI sends bare "gpt-5.5" over HTTP after WS closes (1008 Policy), and
 * without this rewrite OmniRoute routes it to openrouter instead of codex.
 *
 * Safe: only rewrites when codex/model is genuinely registered; all other models
 * pass through unchanged. Errors are caught and the original request is returned.
 */
export async function withCodexPreferredModel(request: Request): Promise<Request | Response> {
  try {
    const clone = request.clone();
    const body = await clone.json().catch(() => null);
    if (!body || typeof body !== "object" || typeof body.model !== "string") {
      return request;
    }
    const { model, changed, error } = await resolveResponsesApiModel(
      body.model,
      getModelInfo,
      async (name) => !!(await getComboByName(name)),
      resolveConfiguredModelAlias
    );
    if (error) {
      return new Response(
        JSON.stringify({ error: { message: error, type: "invalid_request_error" } }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        }
      );
    }
    if (!changed) return request;

    return requestWithJsonModel(request, body as Record<string, unknown>, model);
  } catch {
    return request;
  }
}

/**
 * POST /v1/responses - OpenAI Responses API format
 * Handled by the unified chat handler (openai-responses format auto-detected).
 */
async function postHandler(request, context) {
  // Codex CLI (wire_api="responses") consumes this endpoint over SSE and its reqwest
  // client drops the connection if no bytes arrive within ~5s. Keep the connection
  // warm with early keepalives while the upstream produces its first token (#2544).
  // Non-streaming callers (JSON) keep the original verbatim path untouched.
  const originalBody = await request
    .clone()
    .json()
    .catch(() => null);
  const originalJsonBody =
    originalBody && typeof originalBody === "object" && !Array.isArray(originalBody)
      ? (originalBody as Record<string, unknown>)
      : null;
  const resolved = await withCodexPreferredModel(request);
  if (resolved instanceof Response) return resolved;
  const accept = String(request.headers?.get?.("accept") || "").toLowerCase();
  if (accept.includes("text/event-stream")) {
    // Adaptive threshold: web-session and anonymous-fallback providers are slower
    // to produce the first byte, so use a longer keepalive threshold (15s vs 2s).
    let model;
    try {
      const body = await resolved
        .clone()
        .json()
        .catch(() => null);
      model = body?.model;
    } catch {}
    const thresholdMs = resolveKeepaliveThreshold(model);
    return await withEarlyStreamKeepalive(
      handleResponsesWithCodexFallback(resolved, originalJsonBody),
      {
        signal: request.signal,
        thresholdMs,
      }
    );
  }
  return await handleResponsesWithCodexFallback(resolved, originalJsonBody);
}

const guardedPostHandler = withInjectionGuard(postHandler);

export async function POST(request, context) {
  const authRejection = await requireClientApiAuth(request);
  if (authRejection) return authRejection;
  return guardedPostHandler(request, context);
}
