// GENERATED FILE — do not edit by hand.
// Source: Task #19 audit 2026-09-01 (scripts/tmp-du-mapping-audit.ts +
// scripts/tmp-du-mapping-verdicts.ts, read-only). Every pair was verified
// live: same brand, same category (where a base product exists), identical
// supplier image sets (or no contradicting images) — the `_du` price-feed
// duplicate of exactly one Yugcontract base product.
//
// FAIL-CLOSED CONTRACT:
//  - a `_du` id absent from this list is NEVER mapped (no fuzzy/name
//    matching anywhere in the write path);
//  - regenerate from a fresh read-only audit; new `_du` products stay
//    unmapped until the new pairs are verified and added.
//
// Consumers (Task #20): content-import.ts (planner + product loader) and
// content-dry-run.ts (dry-run / fetch --plan parity). Executors, batching,
// checkpoints, CLI and sanitization are untouched.

export interface DuContentPair {
  duYc: string;
  baseYc: string;
}

export const DU_CONTENT_PAIRS: readonly DuContentPair[] = Object.freeze([
  { duYc: '3047192_du', baseYc: '3047192' },
  { duYc: '5924679_du', baseYc: '5924679' },
  { duYc: '5967725_du', baseYc: '5967725' },
  { duYc: '6241811_du', baseYc: '6241811' },
  { duYc: '6284421_du', baseYc: '6284421' },
  { duYc: '6313699_du', baseYc: '6313699' },
  { duYc: '6348981_du', baseYc: '6348981' },
  { duYc: '6349848_du', baseYc: '6349848' },
  { duYc: '6352159_du', baseYc: '6352159' },
  { duYc: '6376339_du', baseYc: '6376339' },
  { duYc: '6398700_du', baseYc: '6398700' },
  { duYc: '6409008_du', baseYc: '6409008' },
  { duYc: '6446612_du', baseYc: '6446612' },
  { duYc: '6474753_du', baseYc: '6474753' },
  { duYc: '6482008_du', baseYc: '6482008' },
  { duYc: '6489771_du', baseYc: '6489771' },
  { duYc: '6496818_du', baseYc: '6496818' },
  { duYc: '6521818_du', baseYc: '6521818' },
  { duYc: '6527338_du', baseYc: '6527338' },
  { duYc: '6542557_du', baseYc: '6542557' },
  { duYc: '6615810_du', baseYc: '6615810' },
  { duYc: '6629656_du', baseYc: '6629656' },
  { duYc: '6651531_du', baseYc: '6651531' },
  { duYc: '6655515_du', baseYc: '6655515' },
  { duYc: '6661880_du', baseYc: '6661880' },
  { duYc: '6666894_du', baseYc: '6666894' },
  { duYc: '6669622_du', baseYc: '6669622' },
  { duYc: '6703011_du', baseYc: '6703011' },
  { duYc: '6711226_du', baseYc: '6711226' },
  { duYc: '6720857_du', baseYc: '6720857' },
  { duYc: '6745446_du', baseYc: '6745446' },
  { duYc: '6764593_du', baseYc: '6764593' },
  { duYc: '6790006_du', baseYc: '6790006' },
  { duYc: '6811303_du', baseYc: '6811303' },
  { duYc: '6821456_du', baseYc: '6821456' },
  { duYc: '6839342_du', baseYc: '6839342' },
  { duYc: '6840744_du', baseYc: '6840744' },
  { duYc: '6849632_du', baseYc: '6849632' },
  { duYc: '6871226_du', baseYc: '6871226' },
  { duYc: '6873343_du', baseYc: '6873343' },
  { duYc: '6875715_du', baseYc: '6875715' },
  { duYc: '6881881_du', baseYc: '6881881' },
  { duYc: '6884549_du', baseYc: '6884549' },
  { duYc: '6885495_du', baseYc: '6885495' },
  { duYc: '6906759_du', baseYc: '6906759' },
  { duYc: '6924604_du', baseYc: '6924604' },
  { duYc: '6932802_du', baseYc: '6932802' },
  { duYc: '6932803_du', baseYc: '6932803' },
  { duYc: '6935524_du', baseYc: '6935524' },
  { duYc: '6965699_du', baseYc: '6965699' },
  { duYc: '6965981_du', baseYc: '6965981' },
  { duYc: '6966588_du', baseYc: '6966588' },
  { duYc: '6976884_du', baseYc: '6976884' },
  { duYc: '6983775_du', baseYc: '6983775' },
  { duYc: '6984892_du', baseYc: '6984892' },
  { duYc: '6985231_du', baseYc: '6985231' },
  { duYc: '6988689_du', baseYc: '6988689' },
  { duYc: '6988988_du', baseYc: '6988988' },
  { duYc: '6990162_du', baseYc: '6990162' },
  { duYc: '6992422_du', baseYc: '6992422' },
  { duYc: '6993614_du', baseYc: '6993614' },
  { duYc: '6993837_du', baseYc: '6993837' },
  { duYc: '6996159_du', baseYc: '6996159' },
  { duYc: '6996846_du', baseYc: '6996846' },
  { duYc: '7007001_du', baseYc: '7007001' },
  { duYc: '7019427_du', baseYc: '7019427' },
  { duYc: '7022284_du', baseYc: '7022284' },
  { duYc: '7023706_du', baseYc: '7023706' },
  { duYc: '7024506_du', baseYc: '7024506' },
  { duYc: '7024832_du', baseYc: '7024832' },
  { duYc: '7025027_du', baseYc: '7025027' },
  { duYc: '7030819_du', baseYc: '7030819' },
  { duYc: '7051690_du', baseYc: '7051690' },
  { duYc: '7051997_du', baseYc: '7051997' },
  { duYc: '7053687_du', baseYc: '7053687' },
  { duYc: '7056171_du', baseYc: '7056171' },
  { duYc: '7064284_du', baseYc: '7064284' },
  { duYc: '7067155_du', baseYc: '7067155' },
  { duYc: '7083113_du', baseYc: '7083113' },
  { duYc: '7086538_du', baseYc: '7086538' },
  { duYc: '7088394_du', baseYc: '7088394' },
  { duYc: '7094176_du', baseYc: '7094176' },
  { duYc: '7095348_du', baseYc: '7095348' },
  { duYc: '7096065_du', baseYc: '7096065' },
  { duYc: '7109372_du', baseYc: '7109372' },
  { duYc: '7120201_du', baseYc: '7120201' },
  { duYc: '7138500_du', baseYc: '7138500' },
  { duYc: '7153553_du', baseYc: '7153553' },
  { duYc: '7161075_du', baseYc: '7161075' },
  { duYc: '7163805_du', baseYc: '7163805' },
  { duYc: '7163829_du', baseYc: '7163829' },
  { duYc: '7169040_du', baseYc: '7169040' },
  { duYc: '7169071_du', baseYc: '7169071' },
  { duYc: '7185654_du', baseYc: '7185654' },
  { duYc: '7193446_du', baseYc: '7193446' },
  { duYc: '7198084_du', baseYc: '7198084' },
  { duYc: '7198085_du', baseYc: '7198085' },
  { duYc: '7200561_du', baseYc: '7200561' },
  { duYc: '7204300_du', baseYc: '7204300' },
  { duYc: '7204794_du', baseYc: '7204794' },
  { duYc: '7205163_du', baseYc: '7205163' },
  { duYc: '7220881_du', baseYc: '7220881' },
  { duYc: '7220882_du', baseYc: '7220882' },
  { duYc: '7220896_du', baseYc: '7220896' },
  { duYc: '7220908_du', baseYc: '7220908' },
  { duYc: '7220910_du', baseYc: '7220910' },
  { duYc: '7220911_du', baseYc: '7220911' },
  { duYc: '7221668_du', baseYc: '7221668' },
  { duYc: '7224534_du', baseYc: '7224534' },
  { duYc: '7229839_du', baseYc: '7229839' },
  { duYc: '7232093_du', baseYc: '7232093' },
  { duYc: '7232191_du', baseYc: '7232191' },
  { duYc: '7232192_du', baseYc: '7232192' },
  { duYc: '7240037_du', baseYc: '7240037' },
  { duYc: '7243919_du', baseYc: '7243919' },
  { duYc: '7246355_du', baseYc: '7246355' },
  { duYc: '7248612_du', baseYc: '7248612' },
  { duYc: '7259030_du', baseYc: '7259030' },
  { duYc: '7262655_du', baseYc: '7262655' },
  { duYc: '7264937_du', baseYc: '7264937' },
  { duYc: '7269799_du', baseYc: '7269799' },
  { duYc: '7270046_du', baseYc: '7270046' },
  { duYc: '7270074_du', baseYc: '7270074' },
  { duYc: '7278766_du', baseYc: '7278766' },
  { duYc: '7282004_du', baseYc: '7282004' },
  { duYc: '7283135_du', baseYc: '7283135' },
  { duYc: '7290718_du', baseYc: '7290718' },
  { duYc: '7290720_du', baseYc: '7290720' },
  { duYc: '7291169_du', baseYc: '7291169' },
  { duYc: '7297145_du', baseYc: '7297145' },
]);

/** duYc → baseYc. */
export const DU_CONTENT_BY_DU_YC: ReadonlyMap<string, string> = new Map(
  DU_CONTENT_PAIRS.map((p) => [p.duYc, p.baseYc])
);

/** baseYc → duYc[] (deterministic order). */
export const DU_BASE_TO_DU: ReadonlyMap<string, string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const p of DU_CONTENT_PAIRS) {
    const list = map.get(p.baseYc);
    if (list) list.push(p.duYc);
    else map.set(p.baseYc, [p.duYc]);
  }
  return map;
})();

/**
 * Base Yugcontract id for an allowlisted `<id>_du` product id, else null.
 * The ONLY mapping entry point — every consumer goes through this gate.
 */
export function duBaseIdOf(ycId: string | null | undefined): string | null {
  if (ycId === null || ycId === undefined) return null;
  if (!ycId.endsWith('_du')) return null;
  return DU_CONTENT_BY_DU_YC.get(ycId) ?? null;
}
