/**
 * Quota-aware Opus → Sonnet downgrade.
 *
 * Probabilistically rewrites Claude Opus requests to Sonnet based on the
 * relative remaining quota headroom of each tier. Since Anthropic gives a
 * separate (and much larger) weekly Sonnet quota, we use it to absorb Opus
 * traffic when Opus weekly is running low.
 *
 * P(downgrade) = max(0, 1 - opusPct / sonnetPct)
 *   opus=100, sonnet=100  → P=0     (no downgrade)
 *   opus=70,  sonnet=100  → P=0.30  (30% of opus calls go to sonnet)
 *   opus=30,  sonnet=100  → P=0.70
 *   opus=5,   sonnet=100  → P=0.95
 *   opus=100, sonnet=20   → P=0     (sonnet tighter — stay on opus)
 *
 * Uses the MAX remaining percentage across all active accounts (best-case
 * optimism, same signal OmniRoute itself uses for account selection).
 */

import { getDbInstance } from "@/lib/db/core";
import * as log from "../utils/logger";

const OPUS_WINDOW_KEY = "weekly (7d)";
const SONNET_WINDOW_KEY = "weekly sonnet (7d)";

// Minimum sonnet remaining % required before we consider downgrading.
// If sonnet is exhausted, don't bother — sticking with opus is better.
const MIN_SONNET_PCT = 10;

// Downgrade only kicks in below this opus threshold.
// Above it, opus has plenty of room — no reason to degrade quality.
const OPUS_DOWNGRADE_THRESHOLD_PCT = 50;

// Mapping of Opus models to their Sonnet counterparts.
// Order matters: first match wins.
const DOWNGRADE_MAP: Array<[RegExp, string]> = [
  [/^claude-opus-4-7/i, "claude-sonnet-4-6"],
  [/^claude-opus-4-6/i, "claude-sonnet-4-6"],
  [/^claude-opus-4-5/i, "claude-sonnet-4-5-20250929"],
  [/^claude-opus-4/i, "claude-sonnet-4-6"],
];

function getSonnetEquivalent(model: string): string | null {
  for (const [pat, target] of DOWNGRADE_MAP) {
    if (pat.test(model)) return target;
  }
  return null;
}

function maxRemainingPct(provider: string, windowKey: string): number | null {
  try {
    const db = getDbInstance();
    const row = db
      .prepare(
        `SELECT MAX(remaining_percentage) AS max_pct
         FROM quota_snapshots
         WHERE provider = ? AND window_key = ?
           AND id IN (
             SELECT MAX(id) FROM quota_snapshots
             WHERE provider = ? AND window_key = ?
             GROUP BY connection_id
           )`
      )
      .get(provider, windowKey, provider, windowKey) as
      | { max_pct: number | null }
      | undefined;
    if (row && typeof row.max_pct === "number") return row.max_pct;
    return null;
  } catch {
    return null;
  }
}

/**
 * Decide whether to rewrite the incoming model to its sonnet equivalent.
 * Returns the new model string, or null to keep the original.
 */
export function maybeDowngradeOpus(model: string): {
  newModel: string | null;
  opusPct: number | null;
  sonnetPct: number | null;
  probability: number;
} {
  const sonnetTarget = getSonnetEquivalent(model);
  if (!sonnetTarget) {
    return { newModel: null, opusPct: null, sonnetPct: null, probability: 0 };
  }

  const opusPct = maxRemainingPct("claude", OPUS_WINDOW_KEY);
  const sonnetPct = maxRemainingPct("claude", SONNET_WINDOW_KEY);

  if (opusPct === null || sonnetPct === null) {
    return { newModel: null, opusPct, sonnetPct, probability: 0 };
  }

  // No pressure — preserve opus quality.
  if (opusPct >= OPUS_DOWNGRADE_THRESHOLD_PCT) {
    return { newModel: null, opusPct, sonnetPct, probability: 0 };
  }

  // Sonnet too tight — don't offload.
  if (sonnetPct < MIN_SONNET_PCT) {
    return { newModel: null, opusPct, sonnetPct, probability: 0 };
  }

  // Linear ramp: 0% at opus=50%, 95% at opus=0%
  const probability = ((OPUS_DOWNGRADE_THRESHOLD_PCT - opusPct) / OPUS_DOWNGRADE_THRESHOLD_PCT) * 0.95;
  if (probability <= 0) {
    return { newModel: null, opusPct, sonnetPct, probability: 0 };
  }

  const roll = Math.random();
  if (roll < probability) {
    log.info(
      "QUOTA_DOWNGRADE",
      `${model} → ${sonnetTarget} | opus=${opusPct.toFixed(0)}% sonnet=${sonnetPct.toFixed(0)}% P=${(probability * 100).toFixed(0)}% roll=${roll.toFixed(2)}`
    );
    return { newModel: sonnetTarget, opusPct, sonnetPct, probability };
  }

  log.debug(
    "QUOTA_DOWNGRADE",
    `${model} kept | opus=${opusPct.toFixed(0)}% sonnet=${sonnetPct.toFixed(0)}% P=${(probability * 100).toFixed(0)}% roll=${roll.toFixed(2)}`
  );
  return { newModel: null, opusPct, sonnetPct, probability };
}
