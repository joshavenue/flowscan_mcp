/**
 * Hyperliquid-direct explorer tools: /block/{height}, /tx/{hash} and the
 * homepage live block/transaction feed. Registered only when
 * FLOWSCAN_HYPERLIQUID_DIRECT=1.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool } from "../register.js";
import { page, pickRows, pick, result, shapeInput, upstreamEnvelope } from "../shape.js";
import { actionAssetIds, blockDetails, clipLongStrings, iso, loadAssetNames, summarizeAction, txDetails, validatorSummaries } from "../hyperliquid.js";
import { ENDPOINTS, wsCollect } from "../upstream.js";

type Rec = Record<string, unknown>;
const SITE = "https://www.flowscan.xyz";

/** The block proposer is a validator's signer address; name it (and give the validator address) from validatorSummaries. */
async function proposerInfo(address: unknown): Promise<Rec> {
  if (typeof address !== "string") return {};
  try {
    const a = address.toLowerCase();
    const vs = await validatorSummaries();
    const v = vs.find((x) => String(x.signer).toLowerCase() === a) ?? vs.find((x) => String(x.validator).toLowerCase() === a);
    if (!v) return {};
    return { proposerName: v.name, ...(String(v.validator).toLowerCase() !== a ? { proposerValidator: v.validator } : {}) };
  } catch {
    return {};
  }
}

/** Live-feed tx row: like the homepage "Recent Transactions" table (user, action/details, status). */
function txRow(t: Rec, names: Awaited<ReturnType<typeof loadAssetNames>>, blockTime?: number): Rec {
  const s = summarizeAction(t.action, names);
  const row: Rec = { hash: t.hash, user: t.user, type: s.type, status: t.error ? "error" : "success", summary: s.summary };
  if (t.error) row.error = t.error;
  if (blockTime === undefined || t.time !== blockTime) {
    row.time = t.time;
    row.timeIso = iso(t.time);
  }
  if (blockTime === undefined && t.block !== undefined) row.block = t.block;
  return row;
}

export function registerExplorerTools(server: McpServer): void {
  defineTool(
    server,
    "flowscan_block",
    {
      title: "Block details (/block/{height})",
      description:
        "The /block/{height} page: height, time, hash, proposer, tx count, success rate, failed count, the Transaction Breakdown by action type and the transactions table (hash, user, type, status, one-line summary). Filter by type/status/user; includeAction adds raw actions. Get recent heights from flowscan_live_feed.",
      inputSchema: {
        height: z.number().int().min(1).describe("Block height."),
        type: z.string().optional().describe("Only txs with this action type (e.g. 'order', 'cancel')."),
        status: z.enum(["success", "error"]).optional(),
        user: z.string().optional().describe("Only txs from this address."),
        includeAction: z.boolean().optional().describe("Add each tx's raw action (large)."),
        ...shapeInput,
      },
    },
    async (args) => {
      const b = await blockDetails(args.height);
      const txs = Array.isArray(b.txs) ? (b.txs as Rec[]) : [];
      const counts = new Map<string, number>();
      for (const t of txs) {
        const ty = String((t.action as Rec)?.type ?? "");
        counts.set(ty, (counts.get(ty) ?? 0) + 1);
      }
      const failed = txs.filter((t) => t.error).length;
      const breakdown = [...counts.entries()].sort((x, y) => y[1] - x[1]).map(([type, count]) => ({ type, count, pct: txs.length ? Math.round((count / txs.length) * 1000) / 10 : 0 }));
      const filtered = txs.filter(
        (t) =>
          (!args.type || String((t.action as Rec)?.type ?? "").toLowerCase() === String(args.type).toLowerCase()) &&
          (!args.status || (args.status === "error") === Boolean(t.error)) &&
          (!args.user || String(t.user).toLowerCase() === String(args.user).toLowerCase()),
      );
      const { items, paging } = page(filtered, args, 50);
      const names = await loadAssetNames(items.flatMap((t) => actionAssetIds(t.action)));
      const blockTime = Number(b.blockTime);
      let clipped = 0;
      const rows = items.map((t) => {
        const r = txRow(t, names, blockTime);
        if (args.includeAction) {
          const c = clipLongStrings(t.action);
          clipped += c.clipped;
          r.action = c.value;
        }
        return r;
      });
      const { rows: picked, report } = pickRows(rows, args.fields);
      const data: Rec = {
        height: b.height,
        blockTime: b.blockTime,
        blockTimeIso: iso(b.blockTime),
        hash: b.hash,
        proposer: b.proposer,
        ...(await proposerInfo(b.proposer)),
        numTxs: b.numTxs,
        successRatePct: txs.length ? Math.round(((txs.length - failed) / txs.length) * 1000) / 10 : 0,
        failed,
        breakdown,
        txs: picked,
      };
      if (txs.length !== b.numTxs) data.txsListed = txs.length;
      return result(
        upstreamEnvelope(ENDPOINTS.explorer, `${SITE}/block/${b.height}`, data, {
          request: { height: args.height, type: "blockDetails" },
          txPaging: { ...paging, ...(filtered.length !== txs.length ? { matchedFilters: filtered.length } : {}) },
          note: "Tx rows carry time only when it differs from blockTime. Open one tx with flowscan_transaction.",
          ...(clipped ? { clippedStrings: clipped } : {}),
          ...report,
        }),
      );
    },
  );

  defineTool(
    server,
    "flowscan_transaction",
    {
      title: "Transaction details (/tx/{hash})",
      description:
        "The /tx/{hash} page: hash, block, time, user (signer), status/error, action type + Flowscan label, a one-line summary with key fields (asset, side, size, price, notional, amount, destination) and the full action payload. Hashes come from flowscan_block, flowscan_live_feed or account fills/ledger.",
      inputSchema: {
        hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "Expected 0x + 64 hex chars").describe("Transaction hash."),
        fields: shapeInput.fields,
      },
    },
    async (args) => {
      const t = await txDetails(args.hash);
      const names = await loadAssetNames(actionAssetIds(t.action));
      const { summary, type, label, ...details } = summarizeAction(t.action, names);
      const c = clipLongStrings(t.action, 4_000);
      const data: Rec = {
        hash: t.hash,
        block: t.block,
        time: t.time,
        timeIso: iso(t.time),
        user: t.user,
        status: t.error ? "error" : "success",
        error: t.error ?? null,
        type,
        label,
        summary,
        details,
        action: c.value,
      };
      return result(
        upstreamEnvelope(ENDPOINTS.explorer, `${SITE}/tx/${t.hash}`, pick(data, args.fields), {
          request: { hash: args.hash, type: "txDetails" },
          links: { block: `${SITE}/block/${t.block}`, user: `${SITE}/address/${t.user}` },
          ...(c.clipped ? { clippedStrings: c.clipped, clipNote: "Long strings in `action` (e.g. EVM raw tx data) were clipped to 4000 chars." } : {}),
        }),
      );
    },
  );

  defineTool(
    server,
    "flowscan_live_feed",
    {
      title: "Live blocks and transactions (homepage feed)",
      description:
        "The homepage Live Block Activity / Recent Blocks / Recent Transactions: listens to the Hyperliquid explorer WebSocket for `seconds` (subscribing exactly like the page), then returns the latest blocks (height, time, hash, proposer, tx count; heightRange) and transactions (user, action summary, status; countsByType, timeSpan), newest first, plus blocks/sec, txs/sec and block-interval stats. Answers 'what are the latest blocks'.",
      inputSchema: {
        seconds: z.number().int().min(1).max(15).optional().describe("How long to listen (default 5)."),
        include: z.enum(["blocks", "txs", "both"]).optional().describe("Default both."),
        limit: z.number().int().min(1).max(120).optional().describe("Max rows per list (default 20; txs max 50)."),
      },
    },
    async (args) => {
      const seconds = args.seconds ?? 5;
      const include = args.include ?? "both";
      const limit = args.limit ?? 20;
      const subs: Rec[] = [];
      if (include !== "txs") subs.push({ type: "explorerBlock" });
      if (include !== "blocks") subs.push({ type: "explorerTxs" });
      const blocks = new Map<number, Rec>();
      const txs = new Map<string, Rec>();
      const isBlock = (x: Rec) => typeof x?.height === "number" && typeof x.blockTime === "number" && typeof x.hash === "string" && typeof x.numTxs === "number";
      const isTx = (x: Rec) => typeof x?.time === "number" && typeof x.user === "string" && typeof x.block === "number" && typeof x.hash === "string" && "error" in x && x.action && typeof x.action === "object";
      // Same parsing as the homepage ExplorerWS client: bare arrays of blocks/txs, or {channel, data}.
      const ingest = (arr: unknown[]) => {
        for (const x of arr as Rec[]) {
          if (isBlock(x)) blocks.set(x.height as number, x);
          else if (isTx(x)) txs.set(x.hash as string, x);
        }
      };
      const t0 = Date.now();
      const ws = await wsCollect({
        url: ENDPOINTS.explorerWs,
        subscriptions: subs,
        durationMs: seconds * 1000,
        onMessage: (m) => {
          if (Array.isArray(m)) ingest(m);
          else if (m && typeof m === "object" && ((m as Rec).channel === "explorerBlock" || (m as Rec).channel === "explorerTxs") && Array.isArray((m as Rec).data)) ingest((m as Rec).data as unknown[]);
        },
      });
      const listenedMs = Date.now() - t0;
      // Homepage keeps 120 blocks (by blockTime desc) and 50 txs (by time desc).
      const blockList = [...blocks.values()].sort((a, b) => Number(b.blockTime) - Number(a.blockTime) || Number(b.height) - Number(a.height)).slice(0, 120);
      const txList = [...txs.values()].sort((a, b) => Number(b.time) - Number(a.time)).slice(0, 50);
      const names = await loadAssetNames(txList.slice(0, limit).flatMap((t) => actionAssetIds(t.action)));

      const times = blockList.map((b) => Number(b.blockTime)).sort((a, b) => a - b);
      const intervals = times.slice(1).map((t, i) => t - times[i]).filter((d) => d > 0);
      const median = (xs: number[]) => {
        if (!xs.length) return null;
        const s = [...xs].sort((a, b) => a - b);
        const m = Math.floor(s.length / 2);
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
      };
      const spanMs = times.length > 1 ? times[times.length - 1] - times[0] : 0;
      // Homepage "avg block time": mean positive gap over the last 10 blocks.
      const last = times.slice(-11);
      const lastGaps = last.slice(1).map((t, i) => t - last[i]).filter((d) => d > 0);
      const oldest = blockList[blockList.length - 1];
      const txsAfterOldest = blockList.filter((b) => b !== oldest).reduce((s, b) => s + Number(b.numTxs ?? 0), 0);
      const stats: Rec = {
        listenedMs,
        wsMessages: ws.messages,
        blocks: blockList.length,
        ...(blockList.length
          ? {
              timeRange: { fromIso: iso(times[0]), toIso: iso(times[times.length - 1]) },
              blocksPerSec: spanMs > 0 ? Math.round(((blockList.length - 1) / (spanMs / 1000)) * 100) / 100 : null,
              txsPerSec: spanMs > 0 ? Math.round(txsAfterOldest / (spanMs / 1000)) : null,
              medianBlockIntervalMs: median(intervals),
              avgBlockTimeMs: lastGaps.length ? Math.round(lastGaps.reduce((a, b) => a + b, 0) / lastGaps.length) : null,
              txsInListedBlocks: blockList.reduce((s, b) => s + Number(b.numTxs ?? 0), 0),
            }
          : {}),
      };
      const data: Rec = { stats };
      const countByType = (xs: Rec[]) => {
        const m: Record<string, number> = {};
        for (const t of xs) {
          const ty = String((t.action as Rec)?.type ?? "");
          m[ty] = (m[ty] ?? 0) + 1;
        }
        return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
      };
      if (include !== "txs") {
        data.latestBlock = blockList[0] ? blockList[0].height : null;
        const rows = blockList.slice(0, limit);
        data.blocks = {
          count: blockList.length,
          heightRange: blockList.length ? { from: blockList[blockList.length - 1].height, to: blockList[0].height } : null,
          rowsReturned: rows.length,
          rows: rows.map((b) => ({ height: b.height, blockTime: b.blockTime, blockTimeIso: iso(b.blockTime), hash: b.hash, proposer: b.proposer, numTxs: b.numTxs })),
        };
      }
      if (include !== "blocks") {
        const shown = txList.slice(0, Math.min(limit, 50));
        const tt = txList.map((t) => Number(t.time)).filter((x) => Number.isFinite(x));
        const from = tt.length ? Math.min(...tt) : null;
        const to = tt.length ? Math.max(...tt) : null;
        data.txs = {
          count: txList.length,
          countsByType: countByType(txList),
          timeSpanMs: from !== null && to !== null ? to - from : null,
          timeSpanIso: { from: iso(from), to: iso(to) },
          rowsReturned: shown.length,
          ...(shown.length < txList.length ? { rowsCountsByType: countByType(shown) } : {}),
          rows: shown.map((t) => txRow(t, names)),
        };
      }
      return result(
        upstreamEnvelope(ENDPOINTS.explorerWs, `${SITE}/`, data, {
          request: subs.map((s) => ({ method: "subscribe", subscription: s })),
          note: [
            include !== "txs" ? "blocks/sec and block intervals use blockTime of the distinct blocks received (the first message is a backlog of recent blocks); txsPerSec sums their numTxs." : "",
            include !== "blocks" ? "txs is the explorer's tx stream as shown on the homepage (a sample, not every tx); count, countsByType and timeSpan cover the whole sample, rowsCountsByType the rows returned. Open one with flowscan_transaction." : "",
          ].filter(Boolean).join(" "),
        }),
      );
    },
  );
}
