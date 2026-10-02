import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { get, post } from "../client.js";
import { defineTool } from "../register.js";
import { envelope, envelopeRows, isoOf, matches, page, pick, result, shapeInput } from "../shape.js";
import { resolveValidator, stakingOverview, type ValidatorResolution } from "./validators.js";

type Rec = Record<string, unknown>;

export function registerNetworkTools(server: McpServer): void {
  defineTool(
    server,
    "flowscan_stablecoin_margin",
    {
      title: "Stablecoin spot balances & perp margin",
      description:
        "Homepage 'Stablecoin Perp Margin': total stablecoin value on HyperCore split into spot balances and perp margin (with unique holders/traders), and per token (USDC, USDT, USDE, USDH) spot/perp balances, holders, average/median, total value and market share %. USD.",
      inputSchema: { fields: shapeInput.fields },
    },
    async (args) => {
      const data = await get("/api/stablecoin/current");
      return result(envelope("/api/stablecoin/current", pick(data, args.fields)));
    },
  );

  defineTool(
    server,
    "flowscan_peers",
    {
      title: "Hyperliquid gossip-network peers",
      description:
        "The /peers gossip-network crawl (~600 nodes). Default: meta (crawl time, counts, reachability, states), footprint (top countries/ASNs) and sentries (validator sentries with operator, state, peers served). section='nodes' (IP id, role, operator, state, tier, hops, parent, feeders, geo, ASN; filterable), 'edges' (feed links) or 'all' are paged.",
      inputSchema: {
        section: z.enum(["summary", "nodes", "edges", "all"]).optional().describe("Default summary. nodes (default 50) / edges / all (nodes 30, edges 100) are paged."),
        country: z.string().optional().describe("Exact ISO code ('US') or country name ('Japan')."),
        state: z.enum(["syncing", "full", "unreachable", "no_resp", "other"]).optional().describe("Filter nodes by crawl state."),
        role: z.enum(["hub", "sentry", "fringe", "private", "scraper"]).optional().describe("Filter nodes by role."),
        operator: z.string().optional().describe("Filter nodes/sentries by operator name substring."),
        nodeId: z.string().optional().describe("Return a single node by id (IP) plus its edges."),
        ...shapeInput,
      },
    },
    async (args) => {
      const data = (await get("/api/peers")) as Rec;
      const section = args.section ?? "summary";
      const nodes = (data.nodes as Rec[]) ?? [];
      const edges = (data.edges as Rec[]) ?? [];
      if (args.nodeId) {
        const node = nodes.find((n) => n.id === args.nodeId) ?? null;
        const related = edges.filter((e) => e.from === args.nodeId || e.to === args.nodeId);
        return result(envelope("/api/peers", { node, edges: related, crawledAt: (data.meta as Rec)?.crawledAt }));
      }
      const country = args.country ? String(args.country).trim() : "";
      const nodeMatches = (n: Rec) => {
        const geo = (n.geo as Rec) ?? {};
        const countryOk = !country || (country.length === 2 ? String(geo.cc ?? "").toUpperCase() === country.toUpperCase() : String(geo.country ?? "").toLowerCase() === country.toLowerCase());
        return countryOk && (!args.state || n.state === args.state) && (!args.role || n.role === args.role) && matches(n.operator, args.operator);
      };
      if (section === "all") {
        const n = page(nodes.filter(nodeMatches), args, 30);
        const e = page(edges, { offset: args.offset, limit: args.limit }, 100);
        const out = { ...data, nodes: n.items, edges: e.items };
        return result(envelope("/api/peers", pick(out, args.fields), { nodesPaging: n.paging, edgesPaging: e.paging }));
      }
      if (section === "nodes") {
        const { items, paging } = page(nodes.filter(nodeMatches), args, 50);
        return result(envelope("/api/peers", pick({ meta: data.meta, nodes: items }, args.fields), { paging }));
      }
      if (section === "edges") {
        const { items, paging } = page(edges, args, 500);
        return result(envelope("/api/peers", pick({ meta: data.meta, edges: items }, args.fields), { paging }));
      }
      const sentries = ((data.sentries as Rec[]) ?? []).filter((s) => matches(s.operator, args.operator));
      return result(envelope("/api/peers", pick({ meta: data.meta, footprint: data.footprint, sentries }, args.fields)));
    },
  );

  defineTool(
    server,
    "flowscan_staking_overview",
    {
      title: "Staking overview & validator list",
      description:
        "The /validators (Staking) page: total HYPE staked, delegator count, validator count, and every validator (~35) with name, address, commission (bps), total delegated HYPE, staker count and jailed flag (descriptions only with includeDescription). Filter by name/address, drop jailed validators, sort ascending or descending: e.g. sortBy=commission_bps, order=asc, excludeJailed=true finds the cheapest active validator.",
      inputSchema: {
        search: z.string().optional().describe("Filter validators by name or address substring."),
        sortBy: z.enum(["total_delegated", "staker_count", "commission_bps", "name"]).optional().describe("Sort key (default total_delegated)."),
        order: z.enum(["asc", "desc"]).optional().describe("Sort direction (default desc, or asc for name)."),
        excludeJailed: z.boolean().optional().describe("Drop jailed validators (default false)."),
        includeDescription: z.boolean().optional().describe("Include each validator's free-text description (default false)."),
        ...shapeInput,
      },
    },
    async (args) => {
      const data = await stakingOverview();
      let validators = ((data.validators as Rec[]) ?? []).filter(
        (v) => (matches(v.name, args.search) || matches(v.address, args.search) || matches(v.description, args.search)) && (!args.excludeJailed || v.is_jailed !== true),
      );
      const key = args.sortBy ?? "total_delegated";
      const dir = (args.order ?? (key === "name" ? "asc" : "desc")) === "asc" ? 1 : -1;
      validators = [...validators].sort((a, b) => {
        const c = key === "name" ? String(a.name).localeCompare(String(b.name)) : Number(a[key] ?? 0) - Number(b[key] ?? 0);
        return c * dir || String(a.name).localeCompare(String(b.name));
      });
      // effective_stake is "0.0" for every validator upstream; drop it to avoid misleading answers.
      const rows = validators.map(({ effective_stake: _e, description, ...rest }) => (args.includeDescription ? { ...rest, description } : rest));
      const { items, paging } = page(rows, args, 50);
      const { validators: _v, ...summary } = data;
      return result(envelope("/api/staking/info", pick({ ...summary, validators: items }, args.fields), { paging, sortedBy: `${key} ${dir === 1 ? "asc" : "desc"}` }));
    },
  );

  defineTool(
    server,
    "flowscan_validator_stakers",
    {
      title: "Validator detail with its stakers",
      description:
        "Staking page validator drill-down: one validator's summary (name, commission, total delegated, staker count, jailed) plus its delegators (stakers) as {address, amount HYPE}, largest first. `validator` is an address or a validator name (e.g. 'Hyper Foundation 2'). Large validators have thousands of stakers; use limit/offset or search.",
      inputSchema: {
        validator: z.string().min(1).describe("Validator address or name."),
        search: z.string().optional().describe("Filter stakers by address substring."),
        ...shapeInput,
      },
    },
    async (args) => {
      const v = await resolveValidator(args.validator);
      if (v.status !== "resolved") return validatorProblem(args.validator, v);
      const data = (await post("/api/staking/info", { type: "stakingValidatorStakers", validator: v.address })) as Rec;
      // Verified response shape: {address, name, description, commission_bps, total_delegated, staker_count, is_jailed, effective_stake, timestamp_ms, stakers: [{address, amount}]}
      const stakers = (Array.isArray(data.stakers) ? (data.stakers as Rec[]) : [])
        .filter((s) => matches(s.address, args.search))
        .sort((a, b) => Number(b.amount ?? 0) - Number(a.amount ?? 0));
      const { items, paging } = page(stakers, args, 100);
      const { stakers: _l, effective_stake: _e, ...summary } = data;
      return result(envelope("/api/staking/info", pick({ ...summary, stakers: items }, args.fields), { paging }));
    },
  );

  defineTool(
    server,
    "flowscan_staking_events",
    {
      title: "Validator staking events",
      description:
        "Staking page validator activity: most recent delegation/undelegation events for one validator, newest first (user, amount in HYPE, isUndelegate, tx hash, time ms + ISO). `validator` is an address or a validator name. The upstream `currency` field reads 'USDC' but staking amounts are HYPE.",
      inputSchema: {
        validator: z.string().min(1).describe("Validator address or name."),
        limit: z.number().int().min(1).max(500).optional().describe("Number of events (default 50, max 500)."),
        fields: shapeInput.fields,
      },
    },
    async (args) => {
      const v = await resolveValidator(args.validator);
      if (v.status !== "resolved") return validatorProblem(args.validator, v);
      const data = await post("/api/staking/info", { type: "stakingEvents", validator: v.address, limit: args.limit ?? 50 });
      const rows = Array.isArray(data) ? (data as Rec[]).map((e) => ({ ...e, timeIso: isoOf(e.time) })) : data;
      return result(Array.isArray(rows) ? envelopeRows("/api/staking/info", rows, args.fields, { validator: v.address }) : envelope("/api/staking/info", pick(rows, args.fields), { validator: v.address }));
    },
  );
}

function validatorProblem(query: string, v: Exclude<ValidatorResolution, { status: "resolved" }>) {
  if (v.status === "ambiguous") return result(envelope("/api/staking/info", { ambiguous: true, query, candidates: v.candidates, hint: "Pass the validator's address." }));
  throw new Error(`No validator named '${query}'. Known validators: ${v.known.join(", ")}`);
}
