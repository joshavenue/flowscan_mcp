import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { get } from "../client.js";
import { defineTool } from "../register.js";
import { envelope, matches, page, pick, result, shapeInput, tail } from "../shape.js";

type Rec = Record<string, unknown>;

function filterTokens(byToken: Rec, token?: string): Rec {
  if (!token) return byToken;
  const out: Rec = {};
  for (const [k, v] of Object.entries(byToken)) if (matches(k, token) || matches((v as Rec)?.underlying, token)) out[k] = v;
  return out;
}

export function registerSpotStockTools(server: McpServer): void {
  defineTool(
    server,
    "flowscan_spot_stocks",
    {
      title: "Tokenized stocks on Hyperliquid spot (xStocks, Dinari)",
      description:
        "The /spot-stocks page. section='current' (default): summary (market count, providers, 24h/all-time volume, unique holders/traders, total value USD) and per-token stats (underlying, spot market id, provider, mark/mid/prev-day price, circulating supply, 24h/all-time volume, volume/value share, holders, traders, value USD, current order-book depth). 'timeseries': daily volume/holders/traders/valueUsd overall and per token (most recent 30 days by default). 'liquidity': latest order-book depth (best bid/ask, bid/ask depth within 2/5/10/25 bps, in tokens) plus a sampled history of average depth (tokens and USD) over the last `days` (default 1 when `token` is set; omitted for all tokens unless `days` is given). 'topHolders': largest holders per token (address, balance, value USD, % of supply). Source: flowscan.xyz /api/spot-stocks/*.",
      inputSchema: {
        section: z.enum(["current", "timeseries", "liquidity", "topHolders"]).optional(),
        token: z.string().optional().describe("Filter to tokens matching this symbol/underlying substring (e.g. 'NVDA', 'TSLAX')."),
        days: z.number().int().min(1).max(400).optional().describe("timeseries: most recent N days (default 30). liquidity: history window in days (default 1 with `token`, none without)."),
        ...shapeInput,
      },
    },
    async (args) => {
      const section = args.section ?? "current";
      if (section === "current") {
        const data = (await get("/api/spot-stocks/current")) as Rec;
        const out = { ...data, by_token: filterTokens((data.by_token as Rec) ?? {}, args.token) };
        return result(envelope("/api/spot-stocks/current", pick(out, args.fields)));
      }
      if (section === "timeseries") {
        const data = (await get("/api/spot-stocks/timeseries")) as Rec;
        let rows = tail((data.timeseries as Rec[]) ?? [], args.days ?? 30);
        if (args.token) rows = rows.map((r) => ({ ...r, by_token: filterTokens((r.by_token as Rec) ?? {}, args.token) }));
        const { items, paging } = page(rows, args, 400);
        return result(envelope("/api/spot-stocks/timeseries", pick({ metadata: data.metadata, timeseries: items }, args.fields), { paging }));
      }
      if (section === "liquidity") {
        // /api/spot-stocks/current carries `underlying`, needed to match e.g. token='NVDA'.
        const [liq, cur] = await Promise.all([get("/api/spot-stocks/liquidity") as Promise<Rec>, args.token ? (get("/api/spot-stocks/current") as Promise<Rec>) : null]);
        const underlying = ((cur?.by_token as Rec) ?? {}) as Rec;
        const merged: Rec = {};
        for (const [k, v] of Object.entries(liq)) merged[k] = { ...(v as Rec), underlying: (underlying[k] as Rec | undefined)?.underlying };
        const data = filterTokens(merged, args.token);
        // History is ~hourly samples (denser recently). Across all tokens it is large, so without a
        // token filter it is only included when `days` is given explicitly.
        const days = args.days ?? (args.token ? 1 : 0);
        const since = Date.now() - days * 86_400_000;
        const out: Rec = {};
        for (const [k, v] of Object.entries(data)) {
          const { underlying: _u, history: h, ...t } = v as Rec;
          const all = (h as Rec[]) ?? [];
          const history = days > 0 ? all.filter((x) => Number(x.timestamp ?? 0) >= since) : [];
          out[k] = { ...t, historyPoints: history.length, ...(days > 0 ? { history } : {}) };
        }
        return result(envelope("/api/spot-stocks/liquidity", pick(out, args.fields), { historyDays: days, ...(days === 0 ? { note: "history omitted; pass `token` or `days` to include it" } : {}) }));
      }
      const data = filterTokens((await get("/api/spot-stocks/top-holders")) as Rec, args.token);
      const out: Rec = {};
      for (const [k, v] of Object.entries(data)) {
        const t = v as Rec;
        const { items, paging } = page((t.top_100 as Rec[]) ?? [], args, args.token ? 25 : 10);
        const { top_100: _t, ...rest } = t;
        out[k] = { ...rest, holders: items, paging };
      }
      return result(envelope("/api/spot-stocks/top-holders", pick(out, args.fields)));
    },
  );
}
