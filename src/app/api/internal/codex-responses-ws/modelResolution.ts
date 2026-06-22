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
 * Resolve a model ID for the generic HTTP Responses path without changing the
 * product routing order. Bare models are intentionally not retried as codex/*
 * here: dashboard aliases, combo mappings, custom provider metadata, provider
 * capabilities, and normal inference must decide the provider. The codex-only
 * WebSocket bridge keeps its own codex preference above because that endpoint
 * cannot talk to any other upstream.
 *
 * @returns { model, changed } — changed=true only when normal configured routing
 *          already resolved the bare model to Codex and adding the codex/ prefix
 *          preserves that configured choice for downstream handlers.
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

  // #3509: "auto" is OmniRoute's zero-config auto-routing keyword. It must
  // never be rewritten to a provider-prefixed model.
  if (requestedModel === "auto") {
    return { model: requestedModel, changed: false };
  }

  // Bare combo names must pass through so combo/model-combo routing wins before
  // any single-provider model inference.
  if (isCombo) {
    try {
      if (await isCombo(requestedModel)) return { model: requestedModel, changed: false };
    } catch {
      // Combo lookup unavailable — continue to configured single-model routing.
    }
  }

  // Dashboard-configured aliases/provider mappings are explicit routing choices.
  // Preserve non-Codex targets (including chat-only compatible providers that the
  // unified Responses->Chat translator can handle) and only prefix when the alias
  // itself chose Codex.
  if (resolveExplicit) {
    try {
      const explicit = await resolveExplicit(requestedModel);
      if (explicit?.provider) {
        if (explicit.provider === "codex") {
          return { model: `codex/${explicit.model || requestedModel}`, changed: true };
        }
        return { model: requestedModel, changed: false };
      }
    } catch {
      // Explicit mapping lookup unavailable — fall through to normal resolver.
    }
  }

  try {
    const resolved = await resolve(requestedModel);
    if (resolved?.provider === "codex") {
      return { model: `codex/${resolved.model || requestedModel}`, changed: true };
    }
  } catch {
    // Resolver unavailable — pass through unchanged.
  }

  return { model: requestedModel, changed: false };
}
