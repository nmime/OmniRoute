/**
 * Model resolution for the Codex Responses-over-WebSocket bridge.
 *
 * The bridge is codex-only, but the OpenAI Codex CLI rejects provider-prefixed
 * model ids (e.g. "codex/gpt-5.5") client-side when `supports_websockets` is
 * enabled — it only accepts bare ChatGPT model ids (e.g. "gpt-5.5"). Those bare
 * ids can resolve to a different default provider (openai / openrouter) under
 * OmniRoute's global model routing, which the bridge would then reject with
 * `codex_ws_provider_required` (or fail the credentials lookup).
 *
 * Since this endpoint only ever talks to the Codex upstream, re-resolve a bare
 * id under the `codex/` prefix so it is treated as codex. Provider-prefixed ids
 * (already containing a "/") are left untouched.
 *
 * See docs/reference/API_REFERENCE.md → "Responses over WebSocket (Codex)".
 */

export interface ResolvedModelInfo {
  provider?: string;
  model?: string;
  [key: string]: unknown;
}

export type ModelResolver = (modelStr: string) => Promise<ResolvedModelInfo>;

export type ExplicitModelResolver = (
  modelStr: string
) => Promise<ResolvedModelInfo | null | undefined> | ResolvedModelInfo | null | undefined;

function isOpenAICompatibleProvider(provider: unknown): provider is string {
  return typeof provider === "string" && provider.startsWith("openai-compatible-");
}

function isChatCapableOpenAICompatible(info: ResolvedModelInfo): boolean {
  if (info.apiFormat === "responses" || info.targetFormat === "openai-responses") {
    return true;
  }

  if (typeof info.provider !== "string") return false;
  if (info.provider.includes("responses") || info.provider.includes("chat")) return true;

  // Legacy custom provider ids may be just "openai-compatible-<uuid>" and default
  // to the chat executor. Exclude endpoint-specific compatible providers that
  // cannot accept translated Chat Completions payloads.
  return !/(?:embeddings|audio-transcriptions|audio-speech|images-generations)/.test(info.provider);
}

function shouldHonorExplicitResponsesAlias(info: ResolvedModelInfo): boolean {
  if (!info.provider) return false;
  if (info.provider === "codex") return true;

  // A /v1/responses request can safely use a dashboard alias that targets an
  // OpenAI-compatible chat provider: the main chat pipeline translates common
  // Responses API inputs to Chat Completions before executing the provider.
  // Keep blocking non-chat compatible endpoints (embeddings/audio/images), which
  // cannot serve either Responses or Chat Completions payloads.
  if (isOpenAICompatibleProvider(info.provider)) {
    return isChatCapableOpenAICompatible(info);
  }

  // Built-in/non-compatible providers already have explicit translator paths in
  // the main chat pipeline, so preserve their dashboard alias behavior.
  return true;
}

/**
 * Resolve a Responses-WebSocket model id, preferring the codex provider.
 *
 * @param requestedModel the bare/prefixed model id sent by the client
 * @param resolve a `getModelInfo`-style resolver
 * @returns the codex-preferred resolution, or the original resolution if the
 *          model genuinely does not map to codex.
 */
export async function resolveCodexWsModelInfo(
  requestedModel: string,
  resolve: ModelResolver
): Promise<ResolvedModelInfo> {
  const info = await resolve(requestedModel);

  // Already codex, or explicitly provider-prefixed → respect it.
  if (info?.provider === "codex" || requestedModel.includes("/")) {
    return info;
  }

  // Bare id resolved to a non-codex provider; retry as a codex model.
  const codexInfo = await resolve(`codex/${requestedModel}`);
  return codexInfo?.provider === "codex" ? codexInfo : info;
}

/**
 * Resolve a model ID for the HTTP Responses path, applying codex preference
 * for bare ChatGPT-style model IDs (those without a provider prefix).
 *
 * When the Codex CLI falls back from WebSocket to HTTP (#15492), it sends bare
 * model IDs like "gpt-5.5" to /v1/responses. Without this resolution, OmniRoute
 * routes them to openrouter/openai instead of the configured codex OAuth
 * connections, producing "No credentials for provider: openrouter".
 *
 * @param requestedModel the model id from the Responses API request body
 * @param resolve a getModelInfo-style resolver
 * @param isCombo optional predicate — when the bare id is a combo name, skip the codex
 *        rewrite so downstream combo routing resolves it (#3227/#3233).
 * @param resolveExplicit optional dashboard-alias/provider-mapping resolver — when the
 *        bare id explicitly maps to a chat-capable provider, skip the codex rewrite
 *        so dashboard distribution wins over the Codex CLI HTTP fallback preference.
 * @returns { model, changed, error? } — model is the (possibly rewritten) id;
 *          changed=true means a codex/ prefix was applied. error is set when a
 *          dashboard alias targets a provider that cannot handle Responses API
 *          traffic and no compatible Codex fallback exists.
 */
export async function resolveResponsesApiModel(
  requestedModel: string,
  resolve: ModelResolver,
  isCombo?: (name: string) => Promise<boolean> | boolean,
  resolveExplicit?: ExplicitModelResolver
): Promise<{ model: string; changed: boolean; error?: string }> {
  if (!requestedModel || requestedModel.includes("/")) {
    return { model: requestedModel, changed: false };
  }

  // #3509: "auto" is OmniRoute's zero-config auto-routing keyword (handled by the
  // isAutoRouting path in chat.ts, not a DB combo). It must NEVER be rewritten to
  // "codex/auto" — ChatGPT rejects it with "The 'auto' model is not supported when using
  // Codex with a ChatGPT account". ("auto/<strategy>" already returns via the slash guard above.)
  if (requestedModel === "auto") {
    return { model: requestedModel, changed: false };
  }

  // #3227/#3233: a bare combo name (e.g. "n8n-text", "paid-premium") must NOT be
  // force-prefixed to codex/ — Codex accepts arbitrary model strings, so the rewrite
  // would shadow the combo and route to codex. Let downstream combo routing handle it.
  if (isCombo) {
    try {
      if (await isCombo(requestedModel)) return { model: requestedModel, changed: false };
    } catch {
      // combo lookup unavailable — fall through to normal codex-preference resolution
    }
  }

  // Dashboard-configured model aliases/provider mappings are explicit routing choices.
  // Honor those before applying the Codex CLI HTTP fallback preference for bare
  // ChatGPT-style IDs. Otherwise an alias like
  // "gpt-5.5" -> "openai-compatible-chat-.../gpt-5.5" would be shadowed by
  // the permissive codex/<model> retry below and incorrectly routed to Codex.
  let unsupportedExplicitResponsesAlias: ResolvedModelInfo | null = null;
  if (resolveExplicit) {
    try {
      const explicit = await resolveExplicit(requestedModel);
      if (explicit?.provider) {
        if (!shouldHonorExplicitResponsesAlias(explicit)) {
          unsupportedExplicitResponsesAlias = explicit;
        } else {
          if (explicit.provider !== "codex") {
            return { model: requestedModel, changed: false };
          }

          const prefixed = `codex/${explicit.model || requestedModel}`;
          return { model: prefixed, changed: true };
        }
      }
    } catch {
      // Explicit mapping lookup unavailable — fall through to existing codex preference.
    }
  }

  try {
    const resolved = await resolveCodexWsModelInfo(requestedModel, resolve);
    if (resolved?.provider !== "codex") {
      if (unsupportedExplicitResponsesAlias) {
        const error = `Model alias '${requestedModel}' targets an OpenAI-compatible provider endpoint that cannot serve /v1/responses. Use a chat/responses-capable provider, or request a provider-prefixed model that supports the Responses API.`;
        return {
          model: requestedModel,
          changed: false,
          error,
        };
      }
      return { model: requestedModel, changed: false };
    }

    const prefixed = `codex/${resolved.model || requestedModel}`;
    return { model: prefixed, changed: true };
  } catch {
    return { model: requestedModel, changed: false };
  }
}
