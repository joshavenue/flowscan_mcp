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
        "The /spot-stocks page: tokenized stocks on Hyperliquid SPOT: NVDAX, SPYX, QQQX, SKHYX, MUX, SNDKX, SPCXX, TSLAX, AAPLX, CRCLX (xStocks) and SPCXD (Dinari). Per-token price, 24h/all-time volume, holders and liquidity ARE served. section='current' (default): summary + per-token stats. 'timeseries': daily volume/holders/traders/value per token (30 days default). 'liquidity': cumulative depth within 2/5/10/25 bps in tokens and USD. 'topHolders': largest holders.",
      inputSchema: {
        section: z.enum(["current", "timeseries", "liquidity", "topHolders"]).optional(),
        token: z.string().optional().describe("Token/underlying substring ('NVDA')."),
        days: z.number().int().min(1).max(400).optional().describe("timeseries: last N days (default 30). liquidity: history days (default 1 with token)."),
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
          const px = Number(t.markPx ?? 0);
          const latest = t.latest as Rec | null;
          if (latest && px > 0) {
            const depthUsd: Rec = {};
            for (const [lk, lv] of Object.entries(latest)) if (/Depth/.test(lk) && typeof lv === "number") depthUsd[`${lk}Usd`] = Math.round(lv * px * 100) / 100;
            t.latestDepthUsd = depthUsd;
          }
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
