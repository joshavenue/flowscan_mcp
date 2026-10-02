/**
 * Hyperliquid request helpers for the opt-in direct mode. Every request body
 * here is the one Flowscan's own JavaScript sends (see the comments for the
 * Flowscan page that makes it); transport and allowlist live in src/upstream.ts.
 */
import { findDex } from "./dex.js";
import { ENDPOINTS, TTL, upstreamGet, upstreamPost, UpstreamError } from "./upstream.js";

type Rec = Record<string, unknown>;

/* ------------------------------ info API ------------------------------ */

export function info<T = unknown>(body: Rec, ttlMs: number): Promise<T> {
  return upstreamPost<T>(ENDPOINTS.info, body, { ttlMs });
}

/** {type:"allMids"}: homepage perp positioning, /revenue HYPE price. */
export const allMids = () => info<Record<string, string>>({ type: "allMids" }, TTL.prices);

/** {type:"metaAndAssetCtxs"} or {type:"metaAndAssetCtxs", dex} (homepage perp positioning; dex only for HIP-3). */
export function metaAndAssetCtxs(dex = ""): Promise<[{ universe: Rec[] } & Rec, Rec[]]> {
  return info(dex ? { type: "metaAndAssetCtxs", dex } : { type: "metaAndAssetCtxs" }, TTL.prices);
}

/** {type:"meta"}: asset index -> name on the tx page and the homepage tx table. */
export const perpMeta = () => info<{ universe: Rec[] } & Rec>({ type: "meta" }, TTL.metas);

/** {type:"spotMeta"}: "@N" -> token name (spot metadata provider on every page). */
export const spotMeta = () => info<{ universe: Rec[]; tokens: Rec[] }>({ type: "spotMeta" }, TTL.metas);

/** {type:"spotMetaAndAssetCtxs"}: address page spot balances (names and prices). */
export const spotMetaAndAssetCtxs = () => info<[{ universe: Rec[]; tokens: Rec[] }, Rec[]]>({ type: "spotMetaAndAssetCtxs" }, TTL.prices);

/** {type:"allPerpMetas"}: /weekend-trading (all perp DEX universes, index = perp dex index). */
export const allPerpMetas = () => info<Array<{ universe: Rec[]; collateralToken?: number } & Rec>>({ type: "allPerpMetas" }, TTL.metas);

/** {type:"validatorSummaries"}: /validators APR, uptime, recent blocks (validator metadata provider). */
export const validatorSummaries = () => info<Rec[]>({ type: "validatorSummaries" }, TTL.metas);

/** {type:"allBorrowLendReserveStates"}: address page Borrow/Lend APY columns. */
export const borrowLendReserves = () => info<Array<[number, Rec]>>({ type: "allBorrowLendReserveStates" }, TTL.metas);

/** {type:"candleSnapshot", req:{coin, interval, startTime, endTime}}: address page position price chart. */
export const candleSnapshot = (coin: string, interval: string, startTime: number, endTime: number) =>
  info<Rec[] | null>({ type: "candleSnapshot", req: { coin, interval, startTime, endTime } }, TTL.prices);

/** api-ui {type:"portfolio", user}: address page account value / PnL chart. */
export const portfolio = (user: string) => upstreamPost<Array<[string, Rec]>>(ENDPOINTS.uiInfo, { type: "portfolio", user: user.toLowerCase() }, { ttlMs: 20_000 });

/* ---------------------------- explorer RPC ---------------------------- */

function explorerCheck(expectType: string, key: string) {
  return (v: unknown): Rec => {
    const r = v as Rec;
    if (r && r.type === "error") {
      const msg = String(r.message ?? "error");
      const what = expectType === "txDetails" ? "Transaction not found" : "Block not found";
      throw new UpstreamError(`${what} (Hyperliquid explorer replied: "${msg}")`, 404, `${ENDPOINTS.explorer} {type:${expectType}}`, r, false);
    }
    if (!r || r.type !== expectType || !r[key]) throw new UpstreamError(`Unexpected explorer response for ${expectType}`, null, `${ENDPOINTS.explorer} {type:${expectType}}`, r, false);
    return r[key] as Rec;
  };
}

/** rpc /explorer {height, type:"blockDetails"} (the /block/{height} page). */
export const blockDetails = (height: number) => upstreamPost<Rec>(ENDPOINTS.explorer, { height, type: "blockDetails" }, { ttlMs: TTL.explorer, check: explorerCheck("blockDetails", "blockDetails") });

/** rpc /explorer {hash, type:"txDetails"} (the /tx/{hash} page). */
export const txDetails = (hash: string) => upstreamPost<Rec>(ENDPOINTS.explorer, { hash, type: "txDetails" }, { ttlMs: TTL.explorer, check: explorerCheck("txDetails", "tx") });

/** rpc /evm JSON-RPC, exactly as the address page sends it ({jsonrpc, method, params, id: Date.now()}). */
export function evmCall(method: string, params: unknown[]): Promise<unknown> {
  return upstreamPost(ENDPOINTS.evm, { jsonrpc: "2.0", method, params, id: Date.now() }, {
    ttlMs: TTL.none,
    check: (v) => {
      const r = v as Rec;
      if (r?.error) throw new UpstreamError(`HyperEVM RPC ${method}: ${String((r.error as Rec)?.message ?? JSON.stringify(r.error))}`, null, `${ENDPOINTS.evm} {method:${method}}`, r, false);
      return r?.result;
    },
  });
}

/** GET api.hyperunit.xyz/operations/{address} with accept: application/json (address page "Unit" table). */
export const unitOperations = (address: string) => upstreamGet<Rec>(ENDPOINTS.unitOperations(address), { ttlMs: 30_000, headers: { accept: "application/json" } });

/* ------------------------------ helpers ------------------------------- */

/** Exact decimal string for an integer amount with `decimals` places (no float rounding). */
export function formatUnits(value: bigint, decimals: number): string {
  const neg = value < 0n;
  let v = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  v = v % base;
  const frac = decimals > 0 ? v.toString().padStart(decimals, "0").replace(/0+$/, "") : "";
  return `${neg ? "-" : ""}${whole.toString()}${frac ? `.${frac}` : ""}`;
}

/** eth_getBalance result (hex wei) -> HYPE: exact decimal string plus a float (what the page displays). */
export function weiToHype(hexWei: string): { wei: string; hype: string; hypeFloat: number } {
  if (typeof hexWei !== "string" || !/^0x[0-9a-fA-F]*$/.test(hexWei)) throw new Error(`Not a hex quantity: ${String(hexWei)}`);
  const wei = BigInt(hexWei === "0x" ? "0x0" : hexWei);
  const hype = formatUnits(wei, 18);
  return { wei: wei.toString(), hype, hypeFloat: Number(hype) };
}

/** Candle intervals offered by Flowscan's chart (TIMEFRAMES -> periodToHL), with their span in ms (Flowscan's spanToMs; 1M = 30 days). */
export const CANDLE_INTERVALS = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "12h", "1d", "3d", "1w", "1M"] as const;
export type CandleInterval = (typeof CANDLE_INTERVALS)[number];
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
export const INTERVAL_MS: Record<CandleInterval, number> = {
  "1m": MIN, "3m": 3 * MIN, "5m": 5 * MIN, "15m": 15 * MIN, "30m": 30 * MIN,
  "1h": HOUR, "2h": 2 * HOUR, "4h": 4 * HOUR, "8h": 8 * HOUR, "12h": 12 * HOUR,
  "1d": DAY, "3d": 3 * DAY, "1w": 7 * DAY, "1M": 30 * DAY,
};

/**
 * Candle request window. Without startTime the window is `bars` intervals back
 * from endTime (default now), like Flowscan's chart (which loads 300 bars back).
 */
export function deriveCandleWindow(o: { interval: CandleInterval; bars?: number; startTime?: number; endTime?: number; now?: number }): { startTime: number; endTime: number; bars: number } {
  const bars = o.bars ?? 100;
  const endTime = o.endTime ?? o.now ?? Date.now();
  const startTime = o.startTime ?? endTime - bars * INTERVAL_MS[o.interval];
  if (!(startTime < endTime)) throw new Error(`startTime (${startTime}) must be before endTime (${endTime})`);
  return { startTime, endTime, bars };
}

/** Evenly downsample to at most n points, always keeping the first and last. */
export function downsample<T>(xs: T[], n: number): T[] {
  if (xs.length <= n || n < 2) return xs.slice(0, Math.max(n, 0) || xs.length);
  const out: T[] = [];
  const step = (xs.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) out.push(xs[Math.round(i * step)]);
  return out;
}

export const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export const iso = (ms: unknown): string | null => {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
};

/* ---------------------------- coin resolution ---------------------------- */

export type ResolvedCoin = { coin: string; kind: "perp" | "hip3" | "spot" | "outcome"; dex?: string; base?: string; note?: string };

function splitDex(input: string): { dex: string; name: string } | null {
  const i = input.indexOf(":");
  if (i <= 0) return null;
  return { dex: input.slice(0, i), name: input.slice(i + 1) };
}

/**
 * Map user input to the coin string Hyperliquid expects:
 *   "BTC"/"hype" -> main perp; "xyz:TSLA"/"XYZ:tsla"/"KM:US500" -> HIP-3 perp ("mkts:US500");
 *   "@702", "PURR/USDC" -> spot pair; "NVDAX" (a spot token, not a perp) -> its USDC pair "@702";
 *   "#14730" -> HIP-4 outcome side.
 */
export async function resolveCoin(input: string): Promise<ResolvedCoin> {
  const q = input.trim();
  if (!q) throw new UpstreamError("Empty coin", 400, "coin");
  const hip3 = splitDex(q);
  if (hip3) {
    const d = findDex(hip3.dex);
    const prefix = d?.prefix ?? hip3.dex.toLowerCase();
    const r = await metaAndAssetCtxs(prefix).catch(() => null);
    const meta = Array.isArray(r) && r[0] && Array.isArray(r[0].universe) ? r[0] : null;
    if (!meta) throw new UpstreamError(`Unknown HIP-3 dex '${hip3.dex}' (known: ${(await allPerpMetas()).map((m) => dexPrefixOf(m)).filter(Boolean).join(", ")})`, 404, "coin");
    const want = `${prefix}:${hip3.name}`.toLowerCase();
    const hit = (meta.universe as Rec[]).find((u) => String(u.name).toLowerCase() === want);
    if (!hit) throw new UpstreamError(`No market '${hip3.name}' on HIP-3 dex '${prefix}'`, 404, "coin");
    return { coin: String(hit.name), kind: "hip3", dex: prefix };
  }
  const mids = await allMids();
  if (q.startsWith("#")) {
    if (q in mids) return { coin: q, kind: "outcome" };
    throw new UpstreamError(`Unknown HIP-4 outcome coin '${q}'`, 404, "coin");
  }
  if (q.startsWith("@") || q.includes("/")) {
    const key = Object.keys(mids).find((k) => k.toUpperCase() === q.toUpperCase());
    if (key) return { coin: key, kind: "spot" };
    throw new UpstreamError(`Unknown spot pair '${q}'`, 404, "coin");
  }
  const perpKey = Object.keys(mids).find((k) => !k.startsWith("@") && !k.startsWith("#") && !k.includes("/") && k.toUpperCase() === q.toUpperCase());
  if (perpKey) return { coin: perpKey, kind: "perp" };
  // Not a main-dex perp: try a spot token name and use its USDC pair.
  const sm = await spotMeta();
  const tok = sm.tokens.find((t) => String(t.name).toUpperCase() === q.toUpperCase());
  if (tok) {
    const pair = sm.universe.find((u) => Array.isArray(u.tokens) && (u.tokens as number[])[0] === tok.index && (u.tokens as number[])[1] === 0) ?? sm.universe.find((u) => Array.isArray(u.tokens) && (u.tokens as number[])[0] === tok.index);
    if (pair) return { coin: String(pair.name), kind: "spot", base: String(tok.name), note: `${tok.name} is a spot token; using its spot pair ${pair.name}` };
  }
  throw new UpstreamError(`Unknown coin '${q}'. Use a perp name (BTC), a HIP-3 market (xyz:TSLA), a spot pair (@107, PURR/USDC) or a spot token name (NVDAX).`, 404, "coin");
}

/** "" for the main dex, else the prefix shared by the dex's market names ("xyz"). */
export function dexPrefixOf(m: { universe: Rec[] }): string {
  const n = String(m.universe?.[0]?.name ?? "");
  const i = n.indexOf(":");
  return i > 0 ? n.slice(0, i) : "";
}

/* ---------------------------- asset naming ---------------------------- */

export interface AssetNames {
  perp?: Rec[];
  spot?: { universe: Rec[]; tokens: Rec[] };
  allPerp?: Array<{ universe: Rec[] }>;
}

/** Load only the metadata needed to name these asset ids (meta / spotMeta / allPerpMetas). */
export async function loadAssetNames(ids: number[]): Promise<AssetNames> {
  const needPerp = ids.some((a) => a < 10_000);
  const needSpot = ids.some((a) => a >= 10_000 && a < 100_000);
  const needHip3 = ids.some((a) => a >= 100_000);
  const [perp, spot, allPerp] = await Promise.all([
    needPerp ? perpMeta().then((m) => m.universe).catch(() => undefined) : undefined,
    needSpot ? spotMeta().catch(() => undefined) : undefined,
    needHip3 ? allPerpMetas().catch(() => undefined) : undefined,
  ]);
  return { perp, spot, allPerp };
}

/**
 * Asset id -> display name. Perps (id < 10000) as on Flowscan's tx page
 * (meta.universe[id]); spot (10000 + pair index) as the base token name; HIP-3
 * (100000 + dexIndex*10000 + i) as "dex:NAME". Unknown -> "Asset <id>" (Flowscan's fallback).
 */
export function assetName(a: unknown, names: AssetNames): { name: string; market: "perp" | "spot" | "hip3" | "unknown" } {
  const id = Number(a);
  if (!Number.isInteger(id) || id < 0) return { name: `Asset ${String(a)}`, market: "unknown" };
  if (id < 10_000) {
    const n = names.perp?.[id]?.name;
    return n ? { name: String(n), market: "perp" } : { name: `Asset ${id}`, market: "unknown" };
  }
  if (id < 100_000) {
    const idx = id - 10_000;
    const pair = names.spot?.universe.find((u) => u.index === idx);
    if (pair) {
      const base = names.spot?.tokens.find((t) => t.index === (pair.tokens as number[])?.[0]);
      return { name: base ? String(base.name) : String(pair.name), market: "spot" };
    }
    return { name: `Asset ${id}`, market: "unknown" };
  }
  const dexIdx = Math.floor((id - 100_000) / 10_000);
  const i = (id - 100_000) % 10_000;
  const n = names.allPerp?.[dexIdx]?.universe?.[i]?.name;
  return n ? { name: String(n), market: "hip3" } : { name: `Asset ${id}`, market: "unknown" };
}

/** Asset ids referenced by an action (orders, cancels, modifies, twaps). */
export function actionAssetIds(action: unknown): number[] {
  const a = action as Rec;
  if (!a || typeof a !== "object") return [];
  const out: number[] = [];
  const push = (v: unknown) => {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 0) out.push(n);
  };
  if (Array.isArray(a.orders)) for (const o of a.orders as Rec[]) push(o?.a);
  if (Array.isArray(a.cancels)) for (const c of a.cancels as Rec[]) push(c?.a ?? c?.asset);
  if (a.order && typeof a.order === "object") push((a.order as Rec).a);
  if (Array.isArray(a.modifies)) for (const m of a.modifies as Rec[]) push((m?.order as Rec)?.a);
  if (a.twap && typeof a.twap === "object") push((a.twap as Rec).a);
  return out;
}

/* ---------------------------- action labels ---------------------------- */

/** Flowscan's transaction-type labels (getTransactionTypeConfig) for the tx page badge. */
const TYPE_LABELS: Record<string, string> = {
  accountActivationGas: "Account Activation", accountClassTransfer: "Account Class Transfer", activateDexAbstraction: "Abstraction Enable",
  agentEnableDexAbstraction: "Enable Abstraction", batchModify: "Batch Modify", cDeposit: "Core Deposit", cStakingTransfer: "Staking Transfer",
  cWithdraw: "Staking Withdrawal", cWithdrawal: "Core Withdrawal", cancel: "Cancel Order", cancelByCloid: "Cancel Order", cdeposit: "Core Deposit",
  cwithdrawal: "Core Withdrawal", delegation: "Delegation", deployGasAuction: "Deploy Gas Auction", deposit: "Deposit", funding: "Funding",
  gossipPriorityBid: "Gossip Priority Bid", gossipPriorityGasAuction: "Gossip Priority Gas Auction", internalTransfer: "Internal Transfer",
  liquidate: "Liquidate", liquidation: "Liquidation", modify: "Modify Order", order: "Order", perpDeploy: "Perp Deploy",
  perpDexClassTransfer: "Perp DEX Transfer", rewardsClaim: "Rewards Claim", scheduleCancel: "Schedule Cancel", send: "Send", sendAsset: "Send Asset",
  setReferrer: "Set Referrer", spotGenesis: "Spot Genesis", spotSend: "Spot Send", spotTransfer: "Spot Transfer", subAccountTransfer: "Sub Account Transfer",
  tokenDelegate: "Token Delegate", usdClassTransfer: "USD Class Transfer", usdSend: "USD Send", validatorRewards: "Validator Rewards",
  vaultCreate: "Vault Create", vaultDeposit: "Vault Deposit", vaultDistribution: "Vault Distribution", vaultLeaderCommission: "Vault Commission",
  vaultTransfer: "Vault Transfer", vaultWithdraw: "Vault Withdraw", withdraw: "Withdraw",
};

export function actionLabel(action: Rec): string {
  const t = String(action?.type ?? "");
  if ((t === "usdClassTransfer" || t === "accountClassTransfer" || t === "perpDexClassTransfer") && typeof action.toPerp === "boolean") return action.toPerp ? "Transfer to Perp" : "Transfer to Spot";
  return TYPE_LABELS[t] ?? t;
}

const fmtUsd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Structured action summary, following the homepage "Action / Details" column
 * (asset, side, size, price, notional for orders/modifies; amount for USD class
 * transfers; token + amount for spot sends; dex for perp deploys), plus the
 * common transfer/staking/vault fields. `summary` is a one-line rendering.
 */
export function summarizeAction(action: unknown, names: AssetNames): Rec & { summary: string } {
  const a = (action && typeof action === "object" ? action : {}) as Rec;
  const type = String(a.type ?? "");
  const d: Rec = { type };
  const parts: string[] = [];
  const orderLike = (o: Rec | undefined) => {
    if (!o) return;
    const an = o.a !== undefined ? assetName(o.a, names) : null;
    if (an) {
      d.asset = an.name;
      if (an.market !== "perp" && an.market !== "unknown") d.market = an.market;
    }
    d.side = o.b === true ? "buy" : "sell";
    if (o.s !== undefined) d.size = String(o.s);
    if (o.p !== undefined) d.price = String(o.p);
    const s = Number(o.s);
    const p = Number(o.p);
    if (Number.isFinite(s) && Number.isFinite(p)) d.notionalUsd = Math.round(s * p * 100) / 100;
    if (o.r === true) d.reduceOnly = true;
    const tif = (o.t as Rec)?.limit as Rec | undefined;
    if (tif?.tif) d.tif = tif.tif;
    if ((o.t as Rec)?.trigger) d.trigger = (o.t as Rec).trigger;
    if (an) parts.push(an.name);
    const sideWord = an?.market === "spot" ? (o.b === true ? "Buy" : "Sell") : o.b === true ? "Long" : "Short";
    parts.push(d.notionalUsd !== undefined ? `${sideWord} ${fmtUsd(d.notionalUsd as number)} (${d.size} @ ${d.price})` : sideWord);
  };
  switch (type) {
    case "order": {
      const os = Array.isArray(a.orders) ? (a.orders as Rec[]) : [];
      orderLike(os[0]);
      if (os.length > 1) {
        d.orders = os.length;
        parts.push(`${os.length} orders batched`);
      }
      if (a.builder) d.builder = (a.builder as Rec).b;
      break;
    }
    case "modify":
      orderLike(a.order as Rec);
      break;
    case "batchModify": {
      const ms = Array.isArray(a.modifies) ? (a.modifies as Rec[]) : [];
      orderLike(ms[0]?.order as Rec);
      if (ms.length > 1) {
        d.orders = ms.length;
        parts.push(`${ms.length} modifies`);
      }
      break;
    }
    case "cancel":
    case "cancelByCloid": {
      const cs = Array.isArray(a.cancels) ? (a.cancels as Rec[]) : [];
      const first = cs[0];
      const id = first?.a ?? first?.asset;
      if (id !== undefined) {
        d.asset = assetName(id, names).name;
        parts.push(String(d.asset));
      }
      if (type === "cancel" && first?.o !== undefined) d.oid = first.o;
      d.orders = cs.length;
      parts.push(`${cs.length} order${cs.length === 1 ? "" : "s"}`);
      break;
    }
    case "twapOrder": {
      const t = a.twap as Rec | undefined;
      if (t) {
        const an = assetName(t.a, names);
        Object.assign(d, { asset: an.name, side: t.b === true ? "buy" : "sell", size: String(t.s), minutes: t.m, reduceOnly: t.r === true || undefined });
        parts.push(an.name, `${t.b === true ? "Buy" : "Sell"} ${t.s} over ${t.m}m`);
      }
      break;
    }
    case "usdClassTransfer":
      Object.assign(d, { amount: a.amount, toPerp: a.toPerp });
      parts.push(a.toPerp ? "to Perp" : "to Spot", `$${a.amount}`);
      break;
    case "usdSend":
    case "withdraw3":
      Object.assign(d, { amount: a.amount, destination: a.destination });
      parts.push(`$${a.amount}`, `to ${a.destination}`);
      break;
    case "spotSend":
    case "sendAsset": {
      const token = typeof a.token === "string" ? a.token.split(":")[0] : null;
      Object.assign(d, { token, amount: a.amount, destination: a.destination });
      if (a.sourceDex !== undefined) d.sourceDex = a.sourceDex;
      if (a.destinationDex !== undefined) d.destinationDex = a.destinationDex;
      parts.push(`${a.amount} ${token ?? ""}`.trim(), `to ${a.destination}`);
      break;
    }
    case "tokenDelegate": {
      const wei = typeof a.wei === "number" || typeof a.wei === "string" ? BigInt(String(a.wei)) : null;
      const amt = wei !== null ? formatUnits(wei, 8) : null;
      Object.assign(d, { validator: a.validator, amountHype: amt, isUndelegate: a.isUndelegate === true });
      parts.push(`${a.isUndelegate ? "Undelegate" : "Delegate"} ${amt ?? "?"} HYPE`, `validator ${a.validator}`);
      break;
    }
    case "cDeposit":
    case "cWithdraw": {
      const wei = a.wei !== undefined ? BigInt(String(a.wei)) : null;
      const amt = wei !== null ? formatUnits(wei, 8) : null;
      d.amountHype = amt;
      parts.push(`${amt ?? "?"} HYPE`);
      break;
    }
    case "vaultTransfer":
      Object.assign(d, { vault: a.vaultAddress, isDeposit: a.isDeposit, usd: a.usd });
      parts.push(a.isDeposit ? "Deposit" : "Withdraw", `vault ${a.vaultAddress}`);
      break;
    case "perpDeploy": {
      const dex = (a.setOracle as Rec)?.dex ?? (Object.values(a).find((v) => v && typeof v === "object" && "dex" in (v as Rec)) as Rec | undefined)?.dex;
      if (dex) {
        d.dex = dex;
        parts.push(String(dex));
      }
      break;
    }
    case "evmRawTx":
      d.dataBytes = typeof a.data === "string" ? Math.max(0, (a.data.length - 2) / 2) : null;
      break;
    default:
      break;
  }
  const label = actionLabel(a);
  d.label = label;
  const summary = [type === "evmRawTx" ? "EVM Raw Tx" : label || type || "Unknown", ...parts.filter(Boolean)].join(" • ");
  return { ...d, summary };
}

/** Replace very long strings (EVM raw tx hex, signatures) so a payload fits the result cap. */
export function clipLongStrings(v: unknown, max = 2_000): { value: unknown; clipped: number } {
  let clipped = 0;
  const walk = (x: unknown): unknown => {
    if (typeof x === "string" && x.length > max) {
      clipped++;
      return `${x.slice(0, max)}…[${x.length - max} more chars clipped]`;
    }
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x as Rec).map(([k, y]) => [k, walk(y)]));
    return x;
  };
  return { value: walk(v), clipped };
}
