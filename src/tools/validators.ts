/** Validator list helpers shared by the staking and address tools. */
import { post } from "../client.js";

type Rec = Record<string, unknown>;

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** POST /api/staking/info {type:"stakingOverview"} (cached by the client for a short TTL). */
export async function stakingOverview(): Promise<Rec> {
  return (await post("/api/staking/info", { type: "stakingOverview" })) as Rec;
}

export type ValidatorResolution = { status: "resolved"; address: string; name: string | null } | { status: "ambiguous"; candidates: Rec[] } | { status: "notFound"; known: string[] };

/**
 * Resolve a validator address or name. An address is used as-is; a name is matched
 * exactly (case-insensitive) first, then as a substring of the name.
 */
export async function resolveValidator(input: string): Promise<ValidatorResolution> {
  const q = input.trim();
  if (ADDRESS_RE.test(q)) return { status: "resolved", address: q.toLowerCase(), name: null };
  const vals = ((await stakingOverview()).validators as Rec[]) ?? [];
  const ql = q.toLowerCase();
  const exact = vals.filter((v) => String(v.name ?? "").toLowerCase() === ql);
  const hits = exact.length ? exact : vals.filter((v) => String(v.name ?? "").toLowerCase().includes(ql));
  if (hits.length === 1) return { status: "resolved", address: String(hits[0].address).toLowerCase(), name: String(hits[0].name) };
  if (hits.length > 1) return { status: "ambiguous", candidates: hits.map((v) => ({ name: v.name, address: v.address, total_delegated: v.total_delegated, is_jailed: v.is_jailed })) };
  return { status: "notFound", known: vals.map((v) => String(v.name)) };
}
