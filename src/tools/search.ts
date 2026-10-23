import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { get } from "../client.js";
import { DEX_ALIASES } from "../dex.js";
import { labelAddresses, searchLabels } from "../labels.js";
import { defineTool } from "../register.js";
import { envelope, matches, pick, result, shapeInput } from "../shape.js";
import { hyperliquidDirectEnabled } from "../upstream.js";
import { builderSummary, loadBuilderDirectory, searchBuilders } from "./builderDirectory.js";
import { marketCandidates } from "./perp.js";
import { stakingOverview } from "./validators.js";

type Rec = Record<string, unknown>;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const SITE = "https://www.flowscan.xyz";

/** Run a lookup but never let one failing source sink the whole search. */
async function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch {
    return fallback;
  }
}

export function registerSearchTools(server: McpServer): void {
  defineTool(
    server,
    "flowscan_wallet_labels",
    {
      title: "Flowscan's names and trader tags for addresses",
      description:
        "Flowscan's names for known addresses (funds, market makers, deployers, bridges, HLP vaults, team wallets) and trader tags (style scalper..position/market maker/new wallet; level very profitable..very unprofitable; net PnL since Aug 2025; delta neutral). Pass `addresses` (max 100) to label them, or `search` to find addresses by name ('Wintermute', 'HLP'). Unknown = name null.",
      inputSchema: {
        addresses: z.array(z.string().regex(ADDRESS, "Expected 0x + 40 hex characters")).min(1).max(100).optional().describe("Addresses to label (0x + 40 hex)."),
        search: z.string().min(2).optional().describe("Name or address substring to search for."),
        limit: z.number().int().min(1).max(200).optional().describe("search: max matches (default 20)."),
        fields: shapeInput.fields,
      },
      openWorld: true,
    },
    async (args) => {
      if (!args.addresses === !args.search) throw new Error("Pass exactly one of `addresses` (to label them) or `search` (to find addresses by name).");
      if (args.addresses) {
        const labels = await labelAddresses(args.addresses);
        const rows = args.addresses.map((a: string) => labels.get(a.toLowerCase()) ?? { address: a.toLowerCase(), name: null, nameSource: null, tag: null });
        return result(envelope("/api/perp-snapshot/wallets/lookup", pick({ labelled: rows.filter((r: Rec) => r.name || r.tag).length, count: rows.length, wallets: rows }, args.fields)));
      }
      const { matches: found, total, bundleError } = await searchLabels(String(args.search), args.limit ?? 20);
      return result(
        envelope("/api/perp-snapshot/wallets/names", pick({ query: args.search, total, matches: found }, args.fields), {
          ...(bundleError ? { note: `Only Flowscan's API name list was searched; its built-in known-address list could not be read (${bundleError}).` } : {}),
          ...(total === 0 ? { emptyNote: `No Flowscan label matches '${args.search}'.` } : {}),
        }),
      );
    },
  );

  defineTool(
    server,
    "flowscan_search",
    {
      title: "Search Flowscan: what is this address, hash, number, market or name?",
      description:
        "Flowscan's search box: say what any query is and which tool to call next. Address (label/tag, builder? validator?), tx hash, block number, HIP-4 asset id ('#14730'), perp/HIP-3 market ('TSLA'), tokenized stock ('NVDAX'), HIP-3 DEX ('Kinetiq'), builder, validator, named wallet or HIP-4 market. Use it when unsure what an identifier is.",
      inputSchema: {
        query: z.string().min(1).max(200).describe("Anything: 0x address, tx hash, block number, symbol, name."),
        limit: z.number().int().min(1).max(20).optional().describe("Max matches per group (default 5)."),
      },
      openWorld: true,
    },
    async (args) => {
      const q = String(args.query).trim();
      const lim = args.limit ?? 5;
      const direct = hyperliquidDirectEnabled();
      const groups: Rec = {};
      const next: string[] = [];

      if (ADDRESS.test(q)) {
        const a = q.toLowerCase();
        const [labels, dir, staking] = await Promise.all([safe(labelAddresses([a]), new Map()), safe(loadBuilderDirectory(), []), safe(stakingOverview(), {} as Rec)]);
        const l = labels.get(a);
        const builder = dir.find((b) => b.address === a || b.id.toLowerCase() === a);
        const validator = ((staking.validators as Rec[]) ?? []).find((v) => String(v.address).toLowerCase() === a);
        groups.address = {
          address: a,
          label: l && (l.name || l.tag) ? { name: l.name, tag: l.tag?.label ?? null, ...(l.description ? { description: l.description } : {}), ...(l.type ? { type: l.type } : {}) } : null,
          isBuilder: builder ? builderSummary(builder) : false,
          isValidator: validator ? { name: validator.name, totalDelegated: validator.total_delegated, isJailed: validator.is_jailed } : false,
          page: `${SITE}/address/${a}`,
        };
        next.push("flowscan_address_summary {address} for the account, then flowscan_address_fills / _orders / _ledger / _completed_trades / _staking as needed");
        if (builder) next.push(`flowscan_builder_dashboard {builder: "${a}"} for the builder`);
        if (validator) next.push(`flowscan_validator_stakers {validator: "${a}"} for its delegators`);
        return result(envelope("/api/perp-snapshot/wallets/lookup", { query: q, type: "address", ...groups, next }));
      }
      if (TX_HASH.test(q)) {
        return result(
          envelope("/", {
            query: q,
            type: "transaction hash",
            page: `${SITE}/tx/${q}`,
            next: [direct ? `flowscan_transaction {hash: "${q}"}` : "Transaction details are not served in strict mode: Flowscan loads them in the browser from Hyperliquid. Open the page link, or ask the operator to set FLOWSCAN_HYPERLIQUID_DIRECT=1 (then flowscan_transaction)."],
          }),
        );
      }
      if (/^#\d+$/.test(q)) {
        const id = Number(q.slice(1));
        return result(envelope("/api/hip-4/labels", { query: q, type: "HIP-4 outcome asset id", outcomeId: Math.floor(id / 10), side: id % 10 === 0 ? "YES" : "NO", next: [`flowscan_hip4_labels {assets: ["${q}"]} for its label`, `flowscan_hip4_outcome {outcomeId: ${Math.floor(id / 10)}} for candles`] }));
      }
      if (/^\d+$/.test(q)) {
        const n = Number(q);
        const out: Rec = { query: q, type: "number" };
        const hints: string[] = [];
        if (n >= 1_000_000) {
          out.asBlock = { page: `${SITE}/block/${n}` };
          hints.push(direct ? `flowscan_block {height: ${n}}` : "Block details are not served in strict mode (Flowscan loads them in the browser from Hyperliquid); open the page link or enable FLOWSCAN_HYPERLIQUID_DIRECT=1 for flowscan_block.");
        } else {
          hints.push(`If it is a HIP-4 outcome id: flowscan_hip4_outcome {outcomeId: ${n}}.`);
          hints.push(`If it is a block height: ${direct ? `flowscan_block {height: ${n}}` : "not served in strict mode (see the block page)"} — ${SITE}/block/${n}.`);
        }
        return result(envelope("/", { ...out, next: hints }));
      }

      // Free text: look it up everywhere at once.
      const [markets, dir, staking, stocks, hip4, wallets] = await Promise.all([
        safe(marketCandidates(q), { exact: [], suggestions: [] }),
        safe(loadBuilderDirectory(), []),
        safe(stakingOverview(), {} as Rec),
        safe(get("/api/spot-stocks/current") as Promise<Rec>, {} as Rec),
        safe(get("/api/hip-4", { limit: 100 }, { ttlMs: 60_000 }) as Promise<Rec>, {} as Rec),
        safe(searchLabels(q, lim), { matches: [], total: 0 }),
      ]);
      const mk = [...new Set([...markets.exact, ...markets.suggestions])].slice(0, lim);
      if (mk.length) {
        groups.perpMarkets = mk;
        next.push(`flowscan_perp_markets {market: "${mk[0]}"} for OI/positioning; flowscan_market_history for funding/OI history`);
      }
      const dex = DEX_ALIASES.filter((d) => [d.name, d.brand, d.prefix, ...d.formerPrefixes].some((x) => x.toLowerCase() === q.toLowerCase()));
      if (dex.length) {
        groups.hip3Dex = dex.map((d) => ({ name: d.name, brand: d.brand, prefix: d.prefix }));
        next.push(`flowscan_hip3_dex {dex: "${dex[0].prefix}"}`);
      }
      const tokens = Object.entries((stocks.by_token as Rec) ?? {}).filter(([k, v]) => matches(k, q) || matches((v as Rec)?.underlying, q) || matches((v as Rec)?.name, q));
      if (tokens.length) {
        groups.spotStocks = tokens.slice(0, lim).map(([k, v]) => ({ token: k, underlying: (v as Rec)?.underlying ?? null }));
        next.push(`flowscan_spot_stocks {token: "${tokens[0][0]}"}`);
      }
      const { exact, partial } = searchBuilders(dir, q);
      const builders = [...exact, ...partial].slice(0, lim);
      if (builders.length) {
        groups.builders = builders.map(builderSummary);
        next.push(exact.length > 1 ? "Several builders share this name: show the candidates and ask which one (flowscan_builder_lookup)." : `flowscan_builder_revenue / flowscan_builder_dashboard with the builder's address`);
      }
      const vals = ((staking.validators as Rec[]) ?? []).filter((v) => matches(v.name, q)).slice(0, lim);
      if (vals.length) {
        groups.validators = vals.map((v) => ({ name: v.name, address: v.address, totalDelegated: v.total_delegated, isJailed: v.is_jailed }));
        next.push(`flowscan_validator_stakers {validator: "${vals[0].address}"}`);
      }
      if (wallets.matches.length) {
        groups.labelledWallets = wallets.matches;
        next.push("flowscan_address_summary with a wallet's address");
      }
      const outcomes = ((hip4.activeOutcomes as Rec[]) ?? []).filter((o) => matches(o.name, q) || matches((o.question as Rec | null)?.displayName, q) || matches(o.category, q) || matches(o.underlying, q));
      if (outcomes.length) {
        groups.hip4Markets = outcomes.slice(0, lim).map((o) => ({ outcomeId: o.outcomeId, name: o.name, yesMark: o.yesMark, category: o.category ?? null }));
        next.push(`flowscan_hip4_markets {search: "${q}"}`);
      }
      const found = Object.keys(groups).length > 0;
      return result(
        envelope("/", pick({ query: q, type: "text", matched: Object.keys(groups), ...groups, next: found ? next : ["Nothing on Flowscan matches this. Call flowscan_coverage {topic} to see what the server covers."] }, undefined)),
      );
    },
  );
}
