/**
 * Hyperliquid-direct address-page panels: portfolio chart (api-ui), HyperEVM
 * HYPE balance (rpc /evm) and Unit bridge operations (api.hyperunit.xyz).
 * Registered only when FLOWSCAN_HYPERLIQUID_DIRECT=1.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool } from "../register.js";
import { ETH_ADDRESS, page, pickRows, result, shapeInput, upstreamEnvelope } from "../shape.js";
import { downsample, evmCall, iso, metaAndAssetCtxs, num, portfolio, spotMetaAndAssetCtxs, unitOperations, weiToHype } from "../hyperliquid.js";
import { ENDPOINTS, UpstreamError } from "../upstream.js";

type Rec = Record<string, unknown>;
const SITE = "https://www.flowscan.xyz";
const WINDOWS = ["day", "week", "month", "allTime", "perpDay", "perpWeek", "perpMonth", "perpAllTime"] as const;

function seriesStats(points: Array<[number, string]>, maxPoints: number) {
  const pts = points.map(([t, v]) => ({ t: Number(t), v: Number(v) })).filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v));
  if (!pts.length) return { points: 0, latest: null };
  const vals = pts.map((p) => p.v);
  const last = pts[pts.length - 1];
  return {
    latest: last.v,
    latestIso: iso(last.t),
    first: pts[0].v,
    firstIso: iso(pts[0].t),
    min: Math.min(...vals),
    max: Math.max(...vals),
    upstreamPoints: pts.length,
    series: downsample(pts, maxPoints).map((p) => ({ t: p.t, tIso: iso(p.t), v: p.v })),
  };
}

/** Flowscan's Unit table decimals (sol 9, btc 8, eth 18, usdc 6; Solana-sourced 9; else unknown -> amount null, amountRaw kept). */
function unitDecimals(asset: string, sourceChain: string, spot: { universe: Rec[]; tokens: Rec[] } | null): number | undefined {
  const a = asset.toLowerCase();
  const s = sourceChain.toLowerCase();
  if (a === "sol") return 9;
  if (a === "btc") return 8;
  if (a === "eth") return 18;
  if (a === "usdc") return 6;
  if (s === "solana") return 9;
  if (s === "hyperliquid" && spot) {
    const name = unitSymbol(asset);
    for (const n of [name, `U${name}`]) {
      const t = spot.tokens.find((x) => x.name === n);
      if (!t) continue;
      const pair = spot.universe.find((u) => Array.isArray(u.tokens) && (u.tokens as number[])[0] === t.index);
      if (pair && pair.szDecimals !== undefined) return Number(pair.szDecimals);
    }
  }
  return undefined;
}

const unitSymbol = (asset: string) => (["spx6900", "spx"].includes(asset.toLowerCase()) ? "SPX" : asset.toUpperCase());

export function registerAccountDirectTools(server: McpServer): void {
  defineTool(
    server,
    "flowscan_address_portfolio",
    {
      title: "Address portfolio chart (account value & PnL history)",
      description:
        "The /address page portfolio chart (api-ui portfolio): account value and PnL history for a window (day, week, month, allTime; perp* = perps only; Flowscan default allTime), downsampled to maxPoints with ISO times, plus latest/min/max and window volume. `windows` summarises every window (latest account value, PnL, volume) so one call answers 'PnL this week/month/all-time'.",
      inputSchema: {
        address: ETH_ADDRESS,
        window: z.enum(WINDOWS).optional().describe("Default allTime."),
        series: z.enum(["accountValue", "pnl", "both"]).optional().describe("Default both."),
        maxPoints: z.number().int().min(2).max(1000).optional().describe("Default 200."),
      },
    },
    async (args) => {
      const raw = await portfolio(args.address);
      if (!Array.isArray(raw)) throw new UpstreamError("Unexpected portfolio response", null, `${ENDPOINTS.uiInfo} {type:portfolio}`, raw);
      const byWindow = new Map<string, Rec>();
      for (const [k, v] of raw) if (v && typeof v === "object") byWindow.set(k, v);
      const window = args.window ?? "allTime";
      const w = byWindow.get(window);
      if (!w) throw new UpstreamError(`No '${window}' window in portfolio (available: ${[...byWindow.keys()].join(", ")})`, 404, `${ENDPOINTS.uiInfo} {type:portfolio}`);
      const series = args.series ?? "both";
      const maxPoints = args.maxPoints ?? 200;
      const lastOf = (pts: unknown) => (Array.isArray(pts) && pts.length ? num((pts[pts.length - 1] as [number, string])[1]) : null);
      const windows = Object.fromEntries(
        [...byWindow.entries()].map(([k, v]) => [k, { accountValue: lastOf(v.accountValueHistory), pnl: lastOf(v.pnlHistory), volume: num(v.vlm) }]),
      );
      const data: Rec = { address: args.address.toLowerCase(), window, volume: num(w.vlm) };
      if (series !== "pnl") data.accountValue = seriesStats((w.accountValueHistory as Array<[number, string]>) ?? [], maxPoints);
      if (series !== "accountValue") data.pnl = seriesStats((w.pnlHistory as Array<[number, string]>) ?? [], maxPoints);
      data.windows = windows;
      return result(
        upstreamEnvelope(ENDPOINTS.uiInfo, `${SITE}/address/${args.address}`, data, {
          request: { type: "portfolio", user: args.address.toLowerCase() },
          note: "pnl.latest is the PnL over the window (allTime = lifetime PnL). Values in USD.",
        }),
      );
    },
  );

  defineTool(
    server,
    "flowscan_address_evm_balance",
    {
      title: "HYPE balance on HyperEVM",
      description: "The /address page 'EVM' HYPE balance: eth_getBalance on HyperEVM (rpc.hyperliquid.xyz/evm), returned exactly (wei and HYPE decimal string) and as a float. HyperCore spot balances are in flowscan_address_summary.",
      inputSchema: { address: ETH_ADDRESS },
    },
    async (args) => {
      const hex = await evmCall("eth_getBalance", [args.address, "latest"]);
      const b = weiToHype(String(hex));
      return result(
        upstreamEnvelope(ENDPOINTS.evm, `${SITE}/address/${args.address}`, { address: args.address, balanceHype: b.hype, balanceHypeFloat: b.hypeFloat, wei: b.wei, rawHex: hex }, {
          request: { jsonrpc: "2.0", method: "eth_getBalance", params: [args.address, "latest"] },
        }),
      );
    },
  );

  defineTool(
    server,
    "flowscan_address_unit_operations",
    {
      title: "Unit bridge operations (deposits/withdrawals)",
      description:
        "The /address page 'Unit' table (api.hyperunit.xyz): bridge operations between Hyperliquid and Bitcoin/Ethereum/Solana, newest first: created time, asset, from/to chain, direction, amount (Flowscan's decimals), USD value at current prices, state, tx hashes and addresses. Totals by direction and asset.",
      inputSchema: {
        address: ETH_ADDRESS,
        direction: z.enum(["deposit", "withdrawal"]).optional().describe("Only deposits or only withdrawals."),
        ...shapeInput,
      },
    },
    async (args) => {
      const res = await unitOperations(args.address);
      const ops = Array.isArray(res?.operations) ? (res.operations as Rec[]) : [];
      let spot: { universe: Rec[]; tokens: Rec[] } | null = null;
      let price = (_asset: string): number | null => null;
      const requests: Rec[] = [];
      if (ops.length) {
        // Flowscan values each op at the perp mark (main dex), else the token's spot mark/mid.
        const [perp, spotAll] = await Promise.all([metaAndAssetCtxs("").catch(() => null), spotMetaAndAssetCtxs().catch(() => null)]);
        requests.push({ type: "metaAndAssetCtxs" }, { type: "spotMetaAndAssetCtxs" });
        spot = spotAll ? spotAll[0] : null;
        const spotCtx = new Map((spotAll?.[1] ?? []).map((c) => [String(c.coin), c]));
        price = (asset) => {
          const sym = unitSymbol(asset);
          if (sym === "USDC") return 1;
          if (perp) {
            const i = (perp[0].universe as Rec[]).findIndex((u) => u.name === sym);
            const px = i >= 0 ? num(perp[1][i]?.markPx) : null;
            if (px) return px;
          }
          if (spot) {
            for (const n of [sym, `U${sym}`]) {
              const t = spot.tokens.find((x) => x.name === n);
              if (!t) continue;
              const pair = spot.universe.find((u) => Array.isArray(u.tokens) && (u.tokens as number[])[0] === t.index);
              const c = pair ? spotCtx.get(String(pair.name)) : undefined;
              const px = num(c?.markPx) || num(c?.midPx);
              if (px && px > 0) return px;
            }
          }
          return null;
        };
      }
      let rows: Rec[] = ops.map((o) => {
        const asset = String(o.asset ?? "");
        const src = String(o.sourceChain ?? "");
        const dec = unitDecimals(asset, src, spot);
        const rawAmt = String(o.sourceAmount ?? "0");
        const amount = dec !== undefined && /^\d+$/.test(rawAmt) ? Number(rawAmt) / 10 ** dec : null;
        const px = price(asset);
        return {
          created: o.opCreatedAt,
          asset: unitSymbol(asset),
          from: src,
          to: o.destinationChain,
          direction: String(o.destinationChain).toLowerCase() === "hyperliquid" ? "deposit" : src.toLowerCase() === "hyperliquid" ? "withdrawal" : "other",
          amount,
          amountRaw: rawAmt,
          ...(dec !== undefined ? { decimals: dec } : {}),
          usdValue: amount !== null && px !== null ? Math.round(amount * px * 100) / 100 : null,
          state: o.state,
          sourceTxHash: o.sourceTxHash,
          destinationTxHash: o.destinationTxHash,
          sourceAddress: o.sourceAddress,
          destinationAddress: o.destinationAddress,
          ...(o.destinationFeeAmount !== undefined ? { destinationFeeRaw: o.destinationFeeAmount } : {}),
          ...(o.sweepFeeAmount !== undefined && o.sweepFeeAmount !== "0" ? { sweepFeeRaw: o.sweepFeeAmount } : {}),
          stateUpdatedAt: o.stateUpdatedAt,
        };
      });
      rows.sort((a, b) => Date.parse(String(b.created)) - Date.parse(String(a.created)));
      const totals: Rec = {
        operations: rows.length,
        deposits: rows.filter((r) => r.direction === "deposit").length,
        withdrawals: rows.filter((r) => r.direction === "withdrawal").length,
        totalUsd: Math.round(rows.reduce((s, r) => s + Math.abs(Number(r.usdValue ?? 0)), 0) * 100) / 100,
        byAsset: Object.fromEntries(
          [...new Set(rows.map((r) => String(r.asset)))].map((a) => {
            const rs = rows.filter((r) => r.asset === a);
            return [a, { count: rs.length, amount: rs.every((r) => r.amount !== null) ? rs.reduce((s, r) => s + Number(r.amount), 0) : null }];
          }),
        ),
      };
      if (args.direction) rows = rows.filter((r) => r.direction === args.direction);
      const { items, paging } = page(rows, args, 50);
      const { rows: picked, report } = pickRows(items, args.fields);
      return result(
        upstreamEnvelope(ENDPOINTS.unitOperations(args.address), `${SITE}/address/${args.address}`, picked, {
          request: { method: "GET", headers: { accept: "application/json" }, ...(requests.length ? { pricing: requests.map((r) => ({ url: ENDPOINTS.info, ...r })) } : {}) },
          totals,
          paging,
          ...(ops.length === 0 ? { note: "No Unit bridge operations for this address." } : {}),
          ...report,
        }),
      );
    },
  );
}
