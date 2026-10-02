import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { get, post } from "../client.js";
import { defineTool } from "../register.js";
import { ETH_ADDRESS, envelope, matches, page, pick, result, shapeInput } from "../shape.js";

type Rec = Record<string, unknown>;

export function registerNetworkTools(server: McpServer): void {
  defineTool(
    server,
    "flowscan_stablecoin_margin",
    {
      title: "Stablecoin spot balances & perp margin",
      description:
        "Homepage 'Stablecoin Perp Margin' panel: total stablecoin value on HyperCore split into spot balances and perp margin (summary: total_value, spot_value, perp_margin, unique spot holders, unique perp traders) and per token (USDC, USDT, USDE, USDH): spot balance/holders/average/median, perp margin/traders/average/median, total value and market share %. Values in USD. Source: flowscan.xyz /api/stablecoin/current.",
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
        "The /peers page: a crawl of the Hyperliquid gossip (p2p) network (~600 nodes). Sections: 'meta' (crawl time, node/edge counts, reachable fraction, counts per state), 'footprint' (top countries and ASNs by node count), 'sentries' (validator sentry nodes with operator, state, peers served), 'nodes' (every peer: IP id, role, operator, state, tier, hops to validator, parent/sentry, feeders, geo, ASN), 'edges' (from -> to feed links). Default returns meta+footprint+sentries; request nodes/edges explicitly and filter them. Source: flowscan.xyz /api/peers.",
      inputSchema: {
        section: z.enum(["summary", "nodes", "edges", "all"]).optional().describe("summary = meta+footprint+sentries (default). nodes/edges return those lists (paged). all = everything (large)."),
        country: z.string().optional().describe("Filter nodes by ISO country code (e.g. 'US', 'JP') or country name substring."),
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
      if (section === "all") return result(envelope("/api/peers", pick(data, args.fields)));
      if (section === "nodes") {
        const filtered = nodes.filter((n) => {
          const geo = (n.geo as Rec) ?? {};
          return (
            (!args.country || matches(geo.cc, args.country) || matches(geo.country, args.country)) &&
            (!args.state || n.state === args.state) &&
            (!args.role || n.role === args.role) &&
            matches(n.operator, args.operator)
          );
        });
        const { items, paging } = page(filtered, args, 50);
        return result(envelope("/api/peers", { meta: data.meta, nodes: items }, { paging }));
      }
      if (section === "edges") {
        const { items, paging } = page(edges, args, 500);
        return result(envelope("/api/peers", { meta: data.meta, edges: items }, { paging }));
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
        "The /validators (Staking) page: total HYPE staked, delegator count, validator count, and every validator (~35) with name, address, description, commission (bps), total delegated HYPE, effective stake, staker count and jailed flag. Optional name/address filter and sorting. Source: flowscan.xyz /api/staking/info {type:'stakingOverview'}.",
      inputSchema: {
        search: z.string().optional().describe("Filter validators by name or address substring."),
        sortBy: z.enum(["total_delegated", "staker_count", "commission_bps", "name"]).optional().describe("Sort validators (default total_delegated desc)."),
        ...shapeInput,
      },
    },
    async (args) => {
      const data = (await post("/api/staking/info", { type: "stakingOverview" })) as Rec;
      let validators = ((data.validators as Rec[]) ?? []).filter((v) => matches(v.name, args.search) || matches(v.address, args.search) || matches(v.description, args.search));
      const key = args.sortBy ?? "total_delegated";
      validators = [...validators].sort((a, b) => {
        if (key === "name") return String(a.name).localeCompare(String(b.name));
        return Number(b[key] ?? 0) - Number(a[key] ?? 0);
      });
      const { items, paging } = page(validators, args, 50);
      const { validators: _v, ...summary } = data;
      return result(envelope("/api/staking/info", pick({ ...summary, validators: items }, args.fields), { paging }));
    },
  );

  defineTool(
    server,
    "flowscan_validator_stakers",
    {
      title: "Validator detail with its stakers",
      description:
        "Staking page validator drill-down: one validator's summary (name, commission, total delegated, staker count, jailed) plus its delegators (stakers) as {address, amount HYPE}, largest first. Large validators have thousands of stakers; use limit/offset or search. Source: flowscan.xyz /api/staking/info {type:'stakingValidatorStakers'}.",
      inputSchema: {
        validator: ETH_ADDRESS.describe("Validator address (0x...). Get it from flowscan_staking_overview."),
        search: z.string().optional().describe("Filter stakers by address substring."),
        ...shapeInput,
      },
    },
    async (args) => {
      const data = (await post("/api/staking/info", { type: "stakingValidatorStakers", validator: args.validator.toLowerCase() })) as Rec;
      // Verified response shape: {address, name, description, commission_bps, total_delegated, staker_count, is_jailed, effective_stake, timestamp_ms, stakers: [{address, amount}]}
      const stakers = (Array.isArray(data.stakers) ? (data.stakers as Rec[]) : [])
        .filter((s) => matches(s.address, args.search))
        .sort((a, b) => Number(b.amount ?? 0) - Number(a.amount ?? 0));
      const { items, paging } = page(stakers, args, 100);
      const { stakers: _l, ...summary } = data;
      return result(envelope("/api/staking/info", pick({ ...summary, stakers: items }, args.fields), { paging }));
    },
  );

  defineTool(
    server,
    "flowscan_staking_events",
    {
      title: "Validator staking events",
      description:
        "Staking page validator activity: most recent delegation/undelegation events for one validator, newest first (user, amount in HYPE, isUndelegate, tx hash, time ms). The upstream `currency` field reads 'USDC' but staking amounts are HYPE. Source: flowscan.xyz /api/staking/info {type:'stakingEvents'}.",
      inputSchema: {
        validator: ETH_ADDRESS.describe("Validator address (0x...)."),
        limit: z.number().int().min(1).max(500).optional().describe("Number of events (default 50, max 500)."),
        fields: shapeInput.fields,
      },
    },
    async (args) => {
      const data = await post("/api/staking/info", { type: "stakingEvents", validator: args.validator.toLowerCase(), limit: args.limit ?? 50 });
      return result(envelope("/api/staking/info", pick(data, args.fields)));
    },
  );
}
