// Re-export from open-sse with localDb integration
import { getModelAliases, getComboByName, getProviderNodes, getCustomModels } from "@/lib/localDb";
import { getCachedSettings } from "@/lib/localDb";
import { getComboStepTarget } from "@/lib/combos/steps";
import {
  parseModel,
  resolveModelAliasFromMap,
  getModelInfoCore,
} from "@omniroute/open-sse/services/model.ts";

export { parseModel };

/**
 * Build a combined model alias map that merges both alias stores:
 * 1. DB-namespace aliases (key_value WHERE namespace='modelAliases') — set via
 *    /api/models/alias/ and seeded at startup (e.g. gemini-cli default aliases).
 * 2. Settings-based aliases (settings.modelAliases) — set via the Settings UI and
 *    /api/settings/model-aliases/ (stored as a JSON blob in namespace='settings').
 *
 * Settings-based aliases take priority so that UI configuration always wins.
 * Without this merge, aliases configured via the Settings UI were never consulted
 * during provider routing, causing provider inference (e.g. /^gpt-/ → openai) to
 * silently override them (issue #2618 / #2208).
 */
async function getCombinedModelAliases(): Promise<Record<string, unknown>> {
  const [dbAliases, settings] = await Promise.all([
    getModelAliases().catch(() => ({})),
    getCachedSettings().catch(() => ({}) as Record<string, unknown>),
  ]);

  const settingsAliases =
    settings.modelAliases &&
    typeof settings.modelAliases === "object" &&
    !Array.isArray(settings.modelAliases)
      ? (settings.modelAliases as Record<string, unknown>)
      : {};

  // Settings-based aliases win over DB-namespace aliases on key collision
  return { ...dbAliases, ...settingsAliases };
}

/**
 * Resolve model alias from localDb
 */
export async function resolveModelAlias(alias) {
  const aliases = await getModelAliases();
  return resolveModelAliasFromMap(alias, aliases);
}

type RouteFormatMeta = { apiFormat?: string; targetFormat?: string };

function routeMetaFromProviderNode(node: any): RouteFormatMeta {
  const apiType = String(node?.apiType ?? node?.api_type ?? "")
    .trim()
    .toLowerCase();
  if (apiType === "responses" || apiType === "openai-responses") {
    return { apiFormat: "responses" };
  }
  return {};
}

async function lookupProviderNode(providerIdOrAlias: string): Promise<any | null> {
  try {
    const nodes = await getProviderNodes();
    return Array.isArray(nodes)
      ? nodes.find(
          (node: any) => node?.id === providerIdOrAlias || node?.prefix === providerIdOrAlias
        ) || null
      : null;
  } catch {
    return null;
  }
}

async function lookupProviderNodeMeta(providerId: string): Promise<RouteFormatMeta> {
  const match = await lookupProviderNode(providerId);
  return routeMetaFromProviderNode(match);
}

/**
 * Look up route-format metadata. Provider-node api_type is provider-wide and
 * customModels metadata is per-model; per-model metadata wins when both exist.
 */
async function lookupModelRouteMeta(
  providerId: string,
  modelId: string,
  providerNode?: any
): Promise<RouteFormatMeta> {
  const providerMeta = providerNode
    ? routeMetaFromProviderNode(providerNode)
    : await lookupProviderNodeMeta(providerId);

  try {
    const models = await getCustomModels(providerId);
    if (!Array.isArray(models)) return providerMeta;
    const match = models.find((m: any) => m.id === modelId);
    if (!match) return providerMeta;
    return {
      ...providerMeta,
      ...(match.apiFormat === "responses" ? { apiFormat: "responses" } : {}),
      ...(typeof match.targetFormat === "string" ? { targetFormat: match.targetFormat } : {}),
    };
  } catch {
    return providerMeta;
  }
}

/**
 * Resolve a dashboard-configured model alias using the same merged alias sources
 * as request routing (DB aliases plus Settings UI aliases, with Settings winning).
 */
export async function resolveConfiguredModelAlias(alias) {
  const aliases = await getCombinedModelAliases();
  const resolved = resolveModelAliasFromMap(alias, aliases);
  if (!resolved?.provider || !resolved?.model) return resolved;

  const providerNode = await lookupProviderNode(String(resolved.provider));
  const providerId = providerNode?.id ? String(providerNode.id) : String(resolved.provider);
  const { apiFormat, targetFormat } = await lookupModelRouteMeta(
    providerId,
    String(resolved.model),
    providerNode
  );
  return {
    ...resolved,
    provider: providerId,
    ...(apiFormat && { apiFormat }),
    ...(targetFormat && { targetFormat }),
  };
}

/**
 * Get full model info (parse or resolve)
 */
export async function getModelInfo(modelStr) {
  const parsed = parseModel(modelStr);
  const { extendedContext } = parsed;

  const attachCustomApiFormat = async (info: any) => {
    if (!info?.provider || !info?.model) return info;
    const providerNode = await lookupProviderNode(String(info.provider));
    const providerId = providerNode?.id ? String(providerNode.id) : String(info.provider);
    const { apiFormat, targetFormat } = await lookupModelRouteMeta(
      providerId,
      String(info.model),
      providerNode
    );
    if (providerNode || apiFormat || targetFormat) {
      return {
        ...info,
        provider: providerId,
        ...(apiFormat && { apiFormat }),
        ...(targetFormat && { targetFormat }),
      };
    }
    return info;
  };

  // Check custom provider nodes first (for both alias and non-alias formats)
  if (parsed.providerAlias || parsed.provider) {
    // Ensure prefixToCheck is always a concise identifier, not a full model string
    const prefixToCheck = parsed.providerAlias || parsed.provider;

    // Check OpenAI Compatible nodes
    // Match by node.prefix (user-defined alias) OR node.id (internal UUID id stored by
    // combo steps), so that combo targets using the internal node id still resolve
    // correctly (#2778).
    const openaiNodes = await getProviderNodes({ type: "openai-compatible" });
    const matchedOpenAI = openaiNodes.find(
      (node) => node.prefix === prefixToCheck || node.id === prefixToCheck
    );
    if (matchedOpenAI) {
      const { apiFormat, targetFormat } = await lookupModelRouteMeta(
        matchedOpenAI.id as string,
        parsed.model as string,
        matchedOpenAI
      );
      return {
        provider: matchedOpenAI.id,
        model: parsed.model,
        extendedContext,
        ...(apiFormat && { apiFormat }),
        ...(targetFormat && { targetFormat }),
      };
    }

    // Check Anthropic Compatible nodes
    const anthropicNodes = await getProviderNodes({ type: "anthropic-compatible" });
    const matchedAnthropic = anthropicNodes.find(
      (node) => node.prefix === prefixToCheck || node.id === prefixToCheck
    );
    if (matchedAnthropic) {
      const { apiFormat, targetFormat } = await lookupModelRouteMeta(
        matchedAnthropic.id as string,
        parsed.model as string,
        matchedAnthropic
      );
      return {
        provider: matchedAnthropic.id,
        model: parsed.model,
        extendedContext,
        ...(apiFormat && { apiFormat }),
        ...(targetFormat && { targetFormat }),
      };
    }

    // stripModelPrefix: if enabled, strip provider prefix and re-resolve
    // the bare model name using existing heuristics (claude-* → anthropic, etc.)
    try {
      const settings = await getCachedSettings();
      if (settings.stripModelPrefix === true) {
        const strippedResult = await getModelInfoCore(parsed.model, getCombinedModelAliases);
        return { ...strippedResult, extendedContext };
      }
    } catch {
      // If settings read fails, fall through to normal resolution
    }
  }

  if (!parsed.isAlias) {
    return await attachCustomApiFormat(await getModelInfoCore(modelStr, null));
  }

  return await attachCustomApiFormat(await getModelInfoCore(modelStr, getCombinedModelAliases));
}

/**
 * Check if model is a combo and return the full combo object
 * @returns {Promise<Object|null>} Full combo object or null if not a combo
 */
export async function getCombo(modelStr) {
  // Try exact match first (supports combos actually named "combo/ANY")
  let combo = await getComboByName(modelStr);
  if (combo && combo.models && combo.models.length > 0) {
    return combo;
  }

  // Fallback: Strip combo/ prefix if present
  if (modelStr.startsWith("combo/")) {
    const nameToSearch = modelStr.substring(6);
    combo = await getComboByName(nameToSearch);
    if (combo && combo.models && combo.models.length > 0) {
      return combo;
    }
  }

  return null;
}

/**
 * Check if model matches a combo by name OR by model-combo mapping pattern.
 * This augments getCombo() with glob-based model-to-combo resolution (#563).
 *
 * Resolution order:
 * 1. Exact combo name match (existing behavior)
 * 2. Model-combo mapping pattern match (new — glob patterns by priority)
 * 3. null (no combo — single-model request)
 */
export async function getComboForModel(modelStr) {
  // 1. Existing behavior — exact combo name match
  const combo = await getCombo(modelStr);
  if (combo) return combo;

  // 2. NEW — check model-combo mappings table (pattern match)
  try {
    const { resolveComboForModel } = await import("@/lib/localDb");
    const mapped = await resolveComboForModel(modelStr);
    if (mapped && (mapped as any).models?.length > 0) {
      return mapped;
    }
  } catch {
    // If the mappings table doesn't exist yet (pre-migration), continue gracefully
  }

  return null;
}

/**
 * Legacy: get combo models as string array
 * @returns {Promise<string[]|null>}
 */
export async function getComboModels(modelStr) {
  const combo = await getCombo(modelStr);
  if (!combo) return null;
  return (combo.models || [])
    .map((entry) => getComboStepTarget(entry))
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}
