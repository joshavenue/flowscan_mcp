/**
 * HIP-3 DEX naming. Flowscan's /hip-3 analytics (dex-stats routes) use display
 * names ("KM", "Paragon"), while on-chain market symbols, the perp snapshot, the
 * weekend routes, deployer fees and Hyperliquid info requests use the deployed
 * dex prefix ("mkts:", "para:"). Verified on 2026-10-02 by matching market lists
 * and activity dates between /api/dex-stats/per-dex, /api/perp-snapshot/markets
 * and the deployerFeeSummary series.
 */
export interface DexAlias {
  /** Name used by the dex-stats routes and the /hip-3 page. */
  name: string;
  /** Current on-chain dex prefix (as in "xyz:TSLA"). */
  prefix: string;
  /** Earlier prefixes whose history is merged into the same dex-stats series. */
  formerPrefixes: string[];
  collateral: string;
  note?: string;
}

export const DEX_ALIASES: DexAlias[] = [
  { name: "XYZ", prefix: "xyz", formerPrefixes: [], collateral: "USDC" },
  { name: "FLX", prefix: "flx", formerPrefixes: [], collateral: "USDH", note: "inactive since 2026-06" },
  { name: "Hyena", prefix: "hyna", formerPrefixes: [], collateral: "USDe", note: "inactive since 2026-09" },
  { name: "KM", prefix: "mkts", formerPrefixes: ["km"], collateral: "USDC", note: "deployed as 'km' until 2026-06, as 'mkts' since 2026-07" },
  { name: "VNTL", prefix: "vntl", formerPrefixes: [], collateral: "USDH", note: "inactive since 2026-06" },
  { name: "Dreamcash", prefix: "cash", formerPrefixes: [], collateral: "USDT", note: "inactive since 2026-07" },
  { name: "Paragon", prefix: "para", formerPrefixes: [], collateral: "USDC" },
  { name: "Entropy", prefix: "io", formerPrefixes: [], collateral: "USDC" },
];

/** Find a DEX by display name or by current/former prefix (case-insensitive). */
export function findDex(input: string): DexAlias | undefined {
  const q = input.trim().toLowerCase().replace(/:$/, "");
  return DEX_ALIASES.find((d) => d.name.toLowerCase() === q || d.prefix === q || d.formerPrefixes.includes(q));
}

/** All on-chain prefixes (current and former) for an input; [] when unknown. */
export function dexPrefixes(input: string): string[] {
  const d = findDex(input);
  return d ? [d.prefix, ...d.formerPrefixes] : [];
}

export const KNOWN_DEX_HELP = DEX_ALIASES.map((d) => `${d.name}=${d.prefix}`).join(", ");

/** Compact table for tool outputs. */
export function dexAliasTable(): Array<Record<string, unknown>> {
  return DEX_ALIASES.map((d) => ({ name: d.name, prefix: d.prefix, ...(d.formerPrefixes.length ? { formerPrefixes: d.formerPrefixes } : {}), collateral: d.collateral, ...(d.note ? { note: d.note } : {}) }));
}
