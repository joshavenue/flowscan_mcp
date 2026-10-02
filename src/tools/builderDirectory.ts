/**
 * Builder name/id/address resolution shared by the builder tools.
 *
 * Flowscan identifies builders inconsistently across routes: the metrics table and
 * /api/builders/all-daily-revenue key well-known builders by a slug id ("pvp",
 * "phantom", "fomo") and everyone else by their 0x builder address, while the
 * /api/dashboard/* routes only accept the 0x address. Names are not unique either
 * (there is an id "fomo" named "FOMO" and an address-keyed builder named "fomo").
 * This module merges the lists so a query can be resolved, or reported as ambiguous.
 */
import { get, LONG_TTL_MS } from "../client.js";

type Rec = Record<string, unknown>;

export interface BuilderEntry {
  id: string;
  name: string;
  category: string | null;
  /** 0x builder-code address when known (the id itself, or from the user-series id->address map). */
  address: string | null;
  revenue: Rec | null;
  volume: Rec | null;
  total_users: number | null;
  active_users?: number | null;
  intelligenceTracked: boolean;
  /** Other ids the same builder appears under in some routes (e.g. slug 'quote' for an address-keyed builder). */
  aliasIds?: string[];
}

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export async function loadBuilderDirectory(): Promise<BuilderEntry[]> {
  const [metrics, users, intel] = await Promise.all([
    get("/api/buildersv2/landing/metrics-table", {}, { ttlMs: LONG_TTL_MS }) as Promise<Rec>,
    (get("/api/builders-user-series/user-series", {}, { ttlMs: LONG_TTL_MS }) as Promise<Rec>).catch(() => null),
    (get("/api/intelligence/builders", {}, { ttlMs: LONG_TTL_MS }) as Promise<Rec>).catch(() => null),
  ]);

  const addrById = new Map<string, string>();
  for (const b of ((users?.byBuilder as Rec[]) ?? [])) {
    const id = String(b.id ?? "").toLowerCase();
    const addr = String(b.address ?? "").toLowerCase();
    if (id && ADDRESS_RE.test(addr)) addrById.set(id, addr);
  }
  const intelById = new Map<string, Rec>();
  for (const b of ((intel?.builders as Rec[]) ?? [])) intelById.set(String(b.id ?? "").toLowerCase(), b);

  const seen = new Set<string>();
  const out: BuilderEntry[] = [];
  for (const b of ((metrics.builders as Rec[]) ?? [])) {
    const id = String(b.id ?? "");
    const idL = id.toLowerCase();
    if (!id || seen.has(idL)) continue;
    seen.add(idL);
    const m = (b.metrics as Rec) ?? {};
    const totalUsers = (m.total_users as Rec | undefined)?.all_time;
    const intelRow = intelById.get(idL);
    out.push({
      id,
      name: String(b.name ?? id),
      category: (b.category as string) ?? null,
      address: ADDRESS_RE.test(id) ? idL : addrById.get(idL) ?? null,
      revenue: (m.revenue as Rec) ?? null,
      volume: (m.volume as Rec) ?? null,
      total_users: typeof totalUsers === "number" ? totalUsers : null,
      ...(intelRow ? { active_users: (intelRow.active_users as number) ?? null } : {}),
      intelligenceTracked: Boolean(intelRow),
    });
  }
  // Slug ids from user-series that point at an address-keyed builder (e.g. 'quote' -> 0x459b...).
  const slugsByAddr = new Map<string, string[]>();
  for (const [id, addr] of addrById) if (!ADDRESS_RE.test(id)) slugsByAddr.set(addr, [...(slugsByAddr.get(addr) ?? []), id]);
  for (const e of out) {
    const extra = (e.address ? slugsByAddr.get(e.address) ?? [] : []).filter((x) => x !== e.id.toLowerCase() && !seen.has(x));
    if (extra.length) e.aliasIds = extra;
  }
  // Builders only present in the intelligence list.
  for (const [idL, b] of intelById) {
    if (seen.has(idL)) continue;
    const id = String(b.id);
    out.push({
      id,
      name: String(b.name ?? id),
      category: (b.category as string) ?? null,
      address: ADDRESS_RE.test(id) ? idL : addrById.get(idL) ?? null,
      revenue: { all_time: b.total_revenue ?? null },
      volume: { all_time: b.total_volume ?? null },
      total_users: (b.total_users as number) ?? null,
      active_users: (b.active_users as number) ?? null,
      intelligenceTracked: true,
    });
  }
  return out;
}

const allTimeRevenue = (b: BuilderEntry) => Number(b.revenue?.all_time ?? 0) || 0;

export function sortByAllTimeRevenue(list: BuilderEntry[]): BuilderEntry[] {
  return [...list].sort((a, b) => allTimeRevenue(b) - allTimeRevenue(a));
}

/** Case-insensitive search over id, name and address. */
export function searchBuilders(dir: BuilderEntry[], query: string): { exact: BuilderEntry[]; partial: BuilderEntry[] } {
  const q = query.trim().toLowerCase();
  const exact: BuilderEntry[] = [];
  const partial: BuilderEntry[] = [];
  for (const b of dir) {
    const id = b.id.toLowerCase();
    const name = b.name.toLowerCase();
    const addr = b.address ?? "";
    const aliases = b.aliasIds ?? [];
    if (id === q || name === q || addr === q || aliases.includes(q)) exact.push(b);
    else if (id.includes(q) || name.includes(q) || (addr && addr.includes(q)) || aliases.some((a) => a.includes(q))) partial.push(b);
  }
  return { exact: sortByAllTimeRevenue(exact), partial: sortByAllTimeRevenue(partial) };
}

export type Resolution =
  | { status: "resolved"; builder: BuilderEntry; via: "id" | "address" | "exact" | "partial" | "unlisted-address" }
  | { status: "ambiguous"; candidates: BuilderEntry[] }
  | { status: "notFound" };

/**
 * Resolve a query to exactly one builder. "id:<slug>" matches ids only. An address
 * always resolves (it may be unlisted); otherwise exact id/name matches win, then
 * substring matches, and more than one hit at the deciding level is ambiguous.
 */
export function resolveBuilder(dir: BuilderEntry[], query: string): Resolution {
  let q = query.trim().toLowerCase();
  // "id:<slug>" matches the builder id only (ids are unique; names are not).
  if (q.startsWith("id:")) {
    q = q.slice(3).trim();
    const hit = dir.find((b) => b.id.toLowerCase() === q) ?? dir.find((b) => b.aliasIds?.includes(q));
    if (hit) return { status: "resolved", builder: hit, via: "id" };
    if (!ADDRESS_RE.test(q)) return { status: "notFound" };
  }
  if (ADDRESS_RE.test(q)) {
    const hit = dir.find((b) => b.address === q || b.id.toLowerCase() === q);
    if (hit) return { status: "resolved", builder: hit, via: "address" };
    return {
      status: "resolved",
      via: "unlisted-address",
      builder: { id: q, name: q, category: null, address: q, revenue: null, volume: null, total_users: null, intelligenceTracked: false },
    };
  }
  const { exact, partial } = searchBuilders(dir, q);
  if (exact.length === 1) return { status: "resolved", builder: exact[0], via: "exact" };
  if (exact.length > 1) return { status: "ambiguous", candidates: exact };
  if (partial.length === 1) return { status: "resolved", builder: partial[0], via: "partial" };
  if (partial.length > 1) return { status: "ambiguous", candidates: partial };
  return { status: "notFound" };
}

/** Compact public view of a directory entry. */
export function builderSummary(b: BuilderEntry): Rec {
  const r = b.revenue ?? {};
  const pickWin = (o: Rec | null) => (o ? Object.fromEntries(["1d", "7d", "30d", "90d", "all_time"].filter((k) => k in o).map((k) => [k, o[k]])) : null);
  return {
    id: b.id,
    name: b.name,
    category: b.category,
    address: b.address,
    revenueUsd: pickWin(r),
    volumeUsd: pickWin(b.volume),
    total_users: b.total_users,
    ...(b.active_users !== undefined ? { active_users: b.active_users } : {}),
    intelligenceTracked: b.intelligenceTracked,
    ...(b.aliasIds ? { aliasIds: b.aliasIds } : {}),
  };
}
