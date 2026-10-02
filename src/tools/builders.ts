import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { get, LONG_TTL_MS } from "../client.js";
import { defineTool } from "../register.js";
import { compactAddressLists, DATE_YMD, envelope, matches, page, pick, result, shapeInput } from "../shape.js";
import { ADDRESS_RE, builderSummary, loadBuilderDirectory, resolveBuilder, searchBuilders, type BuilderEntry } from "./builderDirectory.js";

type Rec = Record<string, unknown>;

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return ymd(d);
};
const shiftDate = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
};
/**
 * Validate and normalise a revenue date range WITHOUT any network call.
 * Throws for start > end and for ranges starting after the last complete UTC day;
 * clamps an endDate at/after today to yesterday (with a note).
 */
function resolveRange(args: { days?: number; startDate?: string; endDate?: string }, defaultDays = 30): { startDate: string; endDate: string; notes: string[] } {
  const yesterday = daysAgo(1);
  const notes: string[] = [];
  if (args.startDate && args.endDate && args.startDate > args.endDate) throw new Error(`startDate ${args.startDate} is after endDate ${args.endDate}.`);
  let endDate = args.endDate ?? yesterday;
  if (endDate > yesterday) {
    notes.push(`endDate ${endDate} was clamped to ${yesterday}, the latest complete UTC day.`);
    endDate = yesterday;
  }
  const startDate = args.startDate ?? shiftDate(endDate, -((args.days ?? defaultDays) - 1));
  if (startDate > yesterday) throw new Error(`startDate ${startDate} is in the future; the latest complete UTC day is ${yesterday}.`);
  if (startDate > endDate) throw new Error(`startDate ${startDate} is after endDate ${endDate}.`);
  return { startDate, endDate, notes };
}

/** Inclusive list of YYYY-MM-DD dates. */
const dateRange = (start: string, end: string): string[] => {
  const out: string[] = [];
  for (let cur = start; cur <= end && out.length <= 400; cur = shiftDate(cur, 1)) out.push(cur);
  return out;
};

const INTEL_SECTIONS = [
  "metadata",
  "key_metrics",
  "balance_fetch_metrics",
  "user_status_metrics",
  "revenue_metrics",
  "cohort_analysis_metrics",
  "user_lifecycle_metrics",
  "multi_builder_metrics",
  "retention_cohort_metrics",
  "revenue_retention_metrics",
  "weekly_retention_cohorts",
  "daily_activity_metrics",
  "top_users_by_status",
  "individual_user_metrics",
  "activity_heatmap_metrics",
  "daily_revenue_api",
] as const;

export function registerBuilderTools(server: McpServer): void {
  defineTool(
    server,
    "flowscan_builders_leaderboard",
    {
      title: "Builders leaderboard (revenue, volume, users by window)",
      description:
        "The /builders 'Builder Arena': ~1800 builders ranked by one metric over a FIXED window (1d/7d/30d/90d/all_time): revenue, volume (USD), new_users, total_users or avg_revenue_per_user_all_time (last two all-time only). Compact rows (rank, id, name, category, value, that metric's windows, all-time revenue, users); full=true for all metrics. For arbitrary ranges like 'last 45 days' use flowscan_builder_revenue; flowscan_hip3_builders ranks by HIP-3 volume only.",
      inputSchema: {
        metric: z.enum(["revenue", "volume", "new_users", "total_users", "avg_revenue_per_user_all_time"]).optional().describe("Sort metric (default revenue)."),
        window: z.enum(["1d", "7d", "30d", "90d", "all_time"]).optional().describe("Default 7d (all-time-only metrics ignore it)."),
        category: z.string().optional().describe("Category substring (wallet, copytrading, ...)."),
        search: z.string().optional().describe("Filter by builder id/name substring."),
        minUsers: z.number().int().min(0).optional().describe("Min all-time users (default 0); useful for avg_revenue_per_user_all_time."),
        full: z.boolean().optional().describe("Return every metric and window per builder (default false)."),
        ...shapeInput,
      },
    },
    async (args) => {
      const d = (await get("/api/buildersv2/landing/metrics-table", {}, { ttlMs: LONG_TTL_MS })) as Rec;
      const metric: string = args.metric ?? "revenue";
      const allTimeOnly = metric === "total_users" || metric === "avg_revenue_per_user_all_time";
      const window: string = allTimeOnly ? "all_time" : (args.window ?? "7d");
      const val = (b: Rec): number => {
        const m = (b.metrics as Rec)?.[metric];
        if (typeof m === "number") return m;
        const mm = m as Rec | undefined;
        return Number(mm?.[window] ?? 0) || 0;
      };
      const users = (b: Rec) => Number(((b.metrics as Rec)?.total_users as Rec | undefined)?.all_time ?? 0) || 0;
      const minUsers = args.minUsers ?? 0;
      let rows = ((d.builders as Rec[]) ?? []).filter((b) => matches(b.category, args.category) && (matches(b.id, args.search) || matches(b.name, args.search)) && users(b) >= minUsers);
      rows = [...rows].sort((a, b) => val(b) - val(a));
      const ranked = rows.map((b, i) => {
        if (args.full) return { rank: i + 1, ...b };
        const m = (b.metrics as Rec) ?? {};
        return {
          rank: i + 1,
          id: b.id,
          name: b.name,
          category: b.category,
          value: val(b),
          ...(allTimeOnly ? {} : { [metric]: m[metric] }),
          revenueAllTime: (m.revenue as Rec | undefined)?.all_time ?? null,
          totalUsers: users(b),
        };
      });
      const { items, paging } = page(ranked, args, 25);
      const sortedBy = metric === "avg_revenue_per_user_all_time" ? metric : `${metric}.${window}`;
      return result(envelope("/api/buildersv2/landing/metrics-table", pick({ updated_at: d.updated_at, sortedBy, minUsers, builders: items }, args.fields), { paging, units: "USD for revenue/volume" }));
    },
  );

  defineTool(
    server,
    "flowscan_builders_summary",
    {
      title: "Builders all-time summary by category",
      description:
        "The /builders page headline totals: all-time builder revenue (USD), volume (USD), users and avg revenue per user, overall and per builder category (with builder counts), plus the per-builder all-time list (paged with limit/offset, default 50).",
      inputSchema: { fields: shapeInput.fields, ...{ limit: shapeInput.limit, offset: shapeInput.offset } },
    },
    async (args) => {
      const d = (await get("/api/buildersv2/landing/all-time-summary", {}, { ttlMs: LONG_TTL_MS })) as Rec;
      const out: Rec = {};
      for (const [k, v] of Object.entries(d)) {
        if (Array.isArray(v)) {
          const { items, paging } = page(v as Rec[], args, 50);
          out[k] = items;
          out[`${k}Paging`] = paging;
        } else out[k] = v;
      }
      return result(envelope("/api/buildersv2/landing/all-time-summary", pick(out, args.fields)));
    },
  );

  defineTool(
    server,
    "flowscan_builders_daily_revenue",
    {
      title: "Daily revenue per builder (date range, all builders)",
      description:
        "The /builders daily revenue chart: for each UTC day in the range, builder revenue (USD) keyed by builder id (slug like 'phantom' for well-known builders, 0x address for the rest), plus range totals per builder and the grand total. Defaults to the last 30 days ending yesterday, like the site. By default keeps the top 20 builders by range revenue. For one builder's total over a range use flowscan_builder_revenue instead.",
      inputSchema: {
        startDate: DATE_YMD.optional().describe("YYYY-MM-DD UTC, inclusive (default 30 days before endDate)."),
        endDate: DATE_YMD.optional().describe("YYYY-MM-DD UTC, inclusive (default and maximum: yesterday)."),
        builder: z.string().optional().describe("Id or 0x-address substring ('phantom', '0x2a2b'); matchedKeys are listed."),
        top: z.number().int().min(1).max(200).optional().describe("Top N builders by range revenue (default 20)."),
        fields: shapeInput.fields,
      },
    },
    async (args) => {
      const { startDate, endDate, notes: rangeNotes } = resolveRange(args, 30);
      const [d, dir] = await Promise.all([
        get("/api/builders/all-daily-revenue", { startDate, endDate }) as Promise<Rec>,
        args.builder ? loadBuilderDirectory().catch(() => [] as BuilderEntry[]) : Promise.resolve([] as BuilderEntry[]),
      ]);
      const data = (d.data as Rec) ?? d;
      const daily = (data.dailyRevenue as Record<string, Rec>) ?? {};
      const totals: Record<string, number> = {};
      for (const day of Object.values(daily)) for (const [b, v] of Object.entries(day ?? {})) totals[b] = (totals[b] ?? 0) + (Number(v) || 0);
      let keep: Set<string>;
      let matchedKeys: Rec[] | undefined;
      if (args.builder) {
        const q = args.builder.toLowerCase();
        const byKey = new Map<string, BuilderEntry>();
        for (const e of dir) {
          byKey.set(e.id.toLowerCase(), e);
          if (e.address) byKey.set(e.address, e);
        }
        const hits = Object.keys(totals).filter((k) => {
          const kl = k.toLowerCase();
          const e = byKey.get(kl);
          return kl.includes(q) || Boolean(e?.address && e.address.includes(q)) || Boolean(e && e.id.toLowerCase().includes(q));
        });
        keep = new Set(hits);
        matchedKeys = hits
          .sort((a, b) => totals[b] - totals[a])
          .map((k) => {
            const e = byKey.get(k.toLowerCase());
            return { key: k, name: e?.name ?? null, address: e?.address ?? (ADDRESS_RE.test(k) ? k.toLowerCase() : null), rangeRevenue: totals[k] };
          });
      } else keep = new Set(Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, args.top ?? 20).map(([b]) => b));
      const filteredDaily: Record<string, Rec> = {};
      for (const [date, day] of Object.entries(daily)) filteredDaily[date] = Object.fromEntries(Object.entries(day ?? {}).filter(([b]) => keep.has(b)));
      const t = (data.totals as Rec) ?? {};
      const out = {
        dateRange: data.dateRange ?? { start: startDate, end: endDate },
        ...(rangeNotes.length ? { note: rangeNotes.join(" ") } : {}),
        builderCount: (data.builders as unknown[])?.length ?? Object.keys(totals).length,
        ...(matchedKeys ? { matchedKeys } : {}),
        rangeTotals: Object.fromEntries(Object.entries(totals).filter(([b]) => keep.has(b)).sort((a, b) => b[1] - a[1])),
        allBuilders: { grandTotal: t.grand ?? null, byDate: t.byDate ?? null },
        stats: d.stats ?? null,
        dailyRevenue: filteredDaily,
      };
      return result(envelope("/api/builders/all-daily-revenue", pick(out, args.fields), { units: "USD" }));
    },
  );

  defineTool(
    server,
    "flowscan_builder_lookup",
    {
      title: "Find a builder's id/address by name",
      description:
        "Resolve a builder name to its id/address. Names can be ambiguous (e.g. two 'fomo' builders); call this first, then pass the exact id/address to flowscan_builder_revenue or flowscan_builder_dashboard (as `address` or 'id:<id>'). If multiple strong matches exist, show them to the user. Matches id, name and address (case-insensitive); exact matches first, then substrings, by all-time revenue. Each match: id, name, category, address, revenue and volume USD for 1d/7d/30d/90d/all_time, total_users.",
      inputSchema: {
        query: z.string().min(1).describe("Name, id or address (substring ok), e.g. 'fomo'."),
        limit: z.number().int().min(1).max(100).optional().describe("Max matches returned (default 20)."),
      },
    },
    async (args) => {
      const dir = await loadBuilderDirectory();
      const { exact, partial } = searchBuilders(dir, args.query);
      const all = [...exact.map((b) => ({ ...builderSummary(b), exactMatch: true })), ...partial.map((b) => ({ ...builderSummary(b), exactMatch: false }))];
      const lim = args.limit ?? 20;
      const out = {
        query: args.query,
        exactMatches: exact.length,
        totalMatches: all.length,
        ambiguous: exact.length > 1 || (exact.length === 0 && partial.length > 1),
        matches: all.slice(0, lim),
        hint:
          all.length === 0
            ? "No builder matched. Try a shorter substring or check flowscan_builders_leaderboard."
            : "To use a match, pass its `address` (preferred, always unique) or `id:<id>` (e.g. 'id:fomo') to flowscan_builder_revenue / flowscan_builder_dashboard. A bare name or id that is also another builder's name stays ambiguous.",
      };
      return result(envelope("/api/buildersv2/landing/metrics-table", out));
    },
  );

  defineTool(
    server,
    "flowscan_builder_revenue",
    {
      title: "One builder's revenue over any date range (e.g. last 45 days)",
      description:
        "Total and daily revenue (USD) of ONE builder over any range ('past 45 days'): `days` (complete UTC days ending yesterday, default 30) or startDate/endDate (end clamped to yesterday; future start = error). `builder`: 0x address (preferred), 'id:<id>' or a name; ambiguous names return candidates (ask the user). Sums /api/builders/all-daily-revenue, cross-checked with the dashboard series when the address is known (both totals + covered dates, volume/fills/traders). Daily rows newest first.",
      inputSchema: {
        builder: z.string().min(1).describe("0x address (preferred), 'id:<id>' or a name."),
        days: z.number().int().min(1).max(366).optional().describe("Days ending yesterday UTC (default 30)."),
        startDate: DATE_YMD.optional().describe("YYYY-MM-DD (inclusive)."),
        endDate: DATE_YMD.optional().describe("YYYY-MM-DD (inclusive, default yesterday)."),
        limit: z.number().int().min(1).max(400).optional().describe("Max daily rows returned (default 60, newest first)."),
        offset: shapeInput.offset,
        fields: shapeInput.fields,
      },
    },
    async (args) => {
      // Validate dates before any network call.
      const { startDate, endDate, notes: rangeNotes } = resolveRange(args, 30);
      const dates = dateRange(startDate, endDate);
      if (dates.length > 366) throw new Error(`Range too long (${dates.length} days); max 366.`);

      const dir = await loadBuilderDirectory();
      const res = resolveBuilder(dir, args.builder);
      if (res.status === "ambiguous") {
        return result(
          envelope("/api/buildersv2/landing/metrics-table", {
            ambiguous: true,
            query: args.builder,
            candidates: res.candidates.slice(0, 20).map(builderSummary),
            hint: "Several builders match. Ask the user which one, then call again with that builder's `address` (preferred) or `id:<id>` (e.g. 'id:fomo').",
          }),
        );
      }
      if (res.status === "notFound") {
        return result(envelope("/api/buildersv2/landing/metrics-table", { found: false, query: args.builder, hint: "No builder matched. Use flowscan_builder_lookup with a shorter substring." }));
      }
      const b = res.builder;

      const keys = new Set([b.id.toLowerCase(), ...(b.address ? [b.address] : []), ...(b.aliasIds ?? [])]);
      const ninetyStart = daysAgo(90);
      const [dr, dash] = await Promise.all([
        get("/api/builders/all-daily-revenue", { startDate, endDate }) as Promise<Rec>,
        b.address
          ? (get("/api/dashboard/builder-daily-series", { builder: b.address, window: startDate >= ninetyStart ? "90d" : "all" }) as Promise<Rec>).catch((e: Error) => ({ __error: e.message }) as Rec)
          : Promise.resolve(null),
      ]);

      // dashboard: {dates: [], series: {revenue: [], volume: [], fills: [], traders: [], ...}}
      type DashDay = { revenue: number; volume: number; fills: number; traders: number; newTraders: number };
      const dashByDate = new Map<string, DashDay>();
      let dashError: string | null = null;
      if (dash && (dash as Rec).__error) dashError = String((dash as Rec).__error);
      else if (dash) {
        const ds = ((dash as Rec).dates as string[]) ?? [];
        const se = ((dash as Rec).series as Record<string, unknown[]>) ?? {};
        ds.forEach((date, i) => {
          if (date < startDate || date > endDate) return;
          dashByDate.set(date, {
            revenue: Number(se.revenue?.[i] ?? 0) || 0,
            volume: Number(se.volume?.[i] ?? 0) || 0,
            fills: Number(se.fills?.[i] ?? 0) || 0,
            traders: Number(se.traders?.[i] ?? 0) || 0,
            newTraders: Number(se.newTraders?.[i] ?? 0) || 0,
          });
        });
      }
      const dashDates = [...dashByDate.keys()].sort();
      const dashSum = (k: keyof DashDay) => [...dashByDate.values()].reduce((a, x) => a + x[k], 0);
      const dashTotal = dashSum("revenue");
      const hasDash = Boolean(b.address && !dashError && dashByDate.size > 0);

      // all-daily-revenue: {data: {dailyRevenue: {date: {key: revenue}}}}. A builder can appear
      // under its slug id AND its address (e.g. 'quote'); collect each key separately.
      const daily = (((dr.data as Rec) ?? dr).dailyRevenue as Record<string, Rec>) ?? {};
      const perKey = new Map<string, Map<string, number>>();
      const routeDateSet = new Set<string>();
      for (const [date, row] of Object.entries(daily)) {
        if (date < startDate || date > endDate) continue;
        routeDateSet.add(date);
        for (const [k, rev] of Object.entries(row ?? {})) {
          if (!keys.has(k.toLowerCase())) continue;
          if (!perKey.has(k)) perKey.set(k, new Map());
          perKey.get(k)!.set(date, Number(rev) || 0);
        }
      }
      const matchedKeys = [...perKey.keys()];
      const notes: string[] = [...rangeNotes];
      const keyTotal = (k: string) => [...perKey.get(k)!.values()].reduce((x, y) => x + y, 0);
      let useKeys = matchedKeys;
      let dedupe = false;
      let perKeyTotals: Rec | undefined;
      if (matchedKeys.length > 1) {
        perKeyTotals = Object.fromEntries(matchedKeys.map((k) => [k, keyTotal(k)]));
        const [k1, k2] = matchedKeys;
        const m1 = perKey.get(k1)!;
        const m2 = perKey.get(k2)!;
        const overlap = [...m1.keys()].filter((d) => m2.has(d));
        const identical = overlap.length > 0 && overlap.every((d) => Math.abs(m1.get(d)! - m2.get(d)!) < 1e-6);
        if (identical) {
          dedupe = true;
          notes.push(`Revenue appears under both keys ${matchedKeys.join(" and ")} with identical daily values; counted once.`);
        } else if (hasDash) {
          // choose the key (or the sum of keys) that matches the dashboard route best
          const options: Array<{ keys: string[]; total: number }> = [...matchedKeys.map((k) => ({ keys: [k], total: keyTotal(k) })), { keys: matchedKeys, total: matchedKeys.reduce((a, k) => a + keyTotal(k), 0) }];
          options.sort((x, y) => Math.abs(x.total - dashTotal) - Math.abs(y.total - dashTotal));
          useKeys = options[0].keys;
          notes.push(`Revenue appears under several keys (${matchedKeys.join(", ")}) with different values; using ${useKeys.join(" + ")}, which best matches the dashboard route. See perKeyTotals.`);
        } else {
          notes.push(`Revenue appears under several keys (${matchedKeys.join(", ")}) with different values and no dashboard cross-check; they were summed. See perKeyTotals.`);
        }
      }
      const routeByDate = new Map<string, number>();
      for (const date of routeDateSet) {
        const vals = useKeys.map((k) => perKey.get(k)!.get(date)).filter((v): v is number => v !== undefined);
        routeByDate.set(date, dedupe ? (vals.length ? Math.max(...vals) : 0) : vals.reduce((x, y) => x + y, 0));
      }
      const routeDates = [...routeByDate.keys()].sort();
      const routeTotal = [...routeByDate.values()].reduce((a, x) => a + x, 0);
      const covered = (ds: string[]) => (ds.length ? { from: ds[0], to: ds[ds.length - 1], days: ds.length } : null);

      const revenue: Rec = {
        fromDailyRevenueRoute: { totalUsd: routeTotal, coveredRange: covered(routeDates), matchedKeys, ...(perKeyTotals ? { perKeyTotals, usedKeys: useKeys } : {}) },
        fromBuilderDashboard: b.address
          ? dashError
            ? { error: dashError }
            : { totalUsd: dashTotal, coveredRange: covered(dashDates) }
          : null,
      };
      if (!b.address) notes.push("No 0x address known for this builder id, so the dashboard cross-check was skipped.");
      if (hasDash) {
        const base = Math.max(Math.abs(routeTotal), Math.abs(dashTotal));
        if (base > 0 && Math.abs(routeTotal - dashTotal) / base > 0.01) {
          notes.push(`The two sources differ by ${(((routeTotal - dashTotal) / base) * 100).toFixed(2)}%; check coveredRange of each (the dashboard only has data from mid-2026 on, and recent days may still be backfilling).`);
        }
      }
      if (matchedKeys.length === 0) notes.push("This builder has no entries in /api/builders/all-daily-revenue for the range (zero revenue or not tracked there).");

      const rows = dates
        .map((date) => {
          const dd = dashByDate.get(date);
          const rv = routeByDate.get(date);
          const row: Rec = { date, revenue: rv ?? dd?.revenue ?? 0 };
          if (dd) {
            if (rv !== undefined && Math.abs(rv - dd.revenue) > 0.01) row.revenueDashboard = dd.revenue;
            row.volume = dd.volume;
            row.fills = dd.fills;
            row.traders = dd.traders;
          }
          return row;
        })
        .reverse();
      const { items, paging } = page(rows, { limit: args.limit, offset: args.offset }, 60);

      const out: Rec = {
        builder: { id: b.id, name: b.name, category: b.category, address: b.address, resolvedVia: res.via },
        range: { startDate, endDate, days: dates.length },
        totalRevenueUsd: matchedKeys.length > 0 || !dashByDate.size ? routeTotal : dashTotal,
        revenue,
        ...(dashByDate.size
          ? {
              dashboardTotals: {
                volumeUsd: dashSum("volume"),
                fills: dashSum("fills"),
                newTraders: dashSum("newTraders"),
                avgDailyTraders: dashSum("traders") / dashByDate.size,
                note: "Daily trader counts are not additive, so only their average is given; use flowscan_builder_dashboard for unique traders in fixed windows.",
              },
            }
          : {}),
        ...(notes.length ? { note: notes.join(" ") } : {}),
        daily: items,
      };
      return result(envelope("/api/builders/all-daily-revenue", pick(out, args.fields), { paging, units: "USD" }));
    },
  );

  defineTool(
    server,
    "flowscan_builders_user_series",
    {
      title: "Daily traders & new traders per builder",
      description:
        "The /builders user-growth chart: daily count of active traders and new traders across all builders and per builder since 2025-07-27. Prefer this for daily active/new trader time series; for windowed totals use flowscan_builders_leaderboard (its new_users.7d is a separate dataset and can differ).",
      inputSchema: {
        builder: z.string().optional().describe("Builder id or address substring; omit for the aggregate series only."),
        days: z.number().int().min(1).max(1000).optional().describe("Most recent N days (default 30)."),
        metric: z.enum(["traders", "newTraders", "both"]).optional().describe("Default both."),
        fields: shapeInput.fields,
      },
    },
    async (args) => {
      const d = (await get("/api/builders-user-series/user-series", {}, { ttlMs: LONG_TTL_MS })) as Rec;
      const n = args.days ?? 30;
      const dates = ((d.dates as string[]) ?? []).slice(-n);
      const metric = args.metric ?? "both";
      const tailArr = (a: unknown) => (Array.isArray(a) ? a.slice(-n) : a);
      const out: Rec = { generatedAt: d.generatedAt, dates };
      if (metric !== "newTraders") out.traders = tailArr(d.traders);
      if (metric !== "traders") out.newTraders = tailArr(d.newTraders);
      if (args.builder) {
        out.byBuilder = ((d.byBuilder as Rec[]) ?? [])
          .filter((b) => matches(b.id, args.builder) || matches(b.address, args.builder))
          .map((b) => ({ id: b.id, address: b.address, ...(metric !== "newTraders" ? { traders: tailArr(b.traders) } : {}), ...(metric !== "traders" ? { newTraders: tailArr(b.newTraders) } : {}) }));
      } else out.builderCount = (d.byBuilder as unknown[])?.length ?? 0;
      return result(envelope("/api/builders-user-series/user-series", pick(out, args.fields)));
    },
  );

  defineTool(
    server,
    "flowscan_builder_dashboard",
    {
      title: "Builder detail dashboard (stats, daily series, volume by asset)",
      description:
        "The /builders/{id} dashboard for one builder over a FIXED window (7d/30d/90d/all, ending yesterday UTC): stats (volume, revenue, fills, unique/new traders, volume per trader, share of Hyperliquid and builder volume, revenue run-rate), daily series (last 90 days unless `days`) and volume/revenue by asset. USD. `builder`: 0x address, 'id:<id>' or a name. For arbitrary ranges use flowscan_builder_revenue.",
      inputSchema: {
        builder: z.string().min(1).describe("0x address (preferred), 'id:<id>' or a name (ambiguous -> candidates)."),
        window: z.enum(["7d", "30d", "90d", "all"]).optional().describe("Default 30d."),
        section: z.enum(["stats", "daily", "assets", "all"]).optional().describe("Default all."),
        assetsLimit: z.number().int().min(1).max(1000).optional().describe("Max assets in volumeByAsset (default 40, by volume)."),
        days: z.number().int().min(1).max(1000).optional().describe("Keep only the most recent N days of the daily series (default 90)."),
        fields: shapeInput.fields,
      },
    },
    async (args) => {
      let address = String(args.builder).trim().toLowerCase();
      let resolved: Rec | undefined;
      if (!ADDRESS_RE.test(address)) {
        const res = resolveBuilder(await loadBuilderDirectory(), args.builder);
        if (res.status === "ambiguous") {
          return result(envelope("/api/buildersv2/landing/metrics-table", { ambiguous: true, query: args.builder, candidates: res.candidates.slice(0, 20).map(builderSummary), hint: "Ask the user which builder, then pass its `address`." }));
        }
        if (res.status === "notFound") throw new Error(`No builder matches '${args.builder}'. Use flowscan_builder_lookup.`);
        if (!res.builder.address) throw new Error(`Builder '${res.builder.id}' has no known 0x address, which the dashboard routes require.`);
        address = res.builder.address;
        resolved = { id: res.builder.id, name: res.builder.name, address };
      }
      const q = { builder: address, window: args.window ?? "30d" };
      const section = args.section ?? "all";
      const [stats, daily, assets] = await Promise.all([
        section === "all" || section === "stats" ? get("/api/dashboard/builder-stats", q) : null,
        section === "all" || section === "daily" ? get("/api/dashboard/builder-daily-series", q) : null,
        section === "all" || section === "assets" ? (get("/api/dashboard/builder-volume-by-asset", q) as Promise<Rec>) : null,
      ]);
      const out: Rec = {};
      if (stats) out.stats = stats;
      if (daily) {
        const dd = daily as Rec;
        const n = args.days ?? 90;
        const dates = (dd.dates as string[]) ?? [];
        const series = Object.fromEntries(Object.entries((dd.series as Rec) ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.slice(-n) : v]));
        out.daily = { ...dd, totalDays: dates.length, dates: dates.slice(-n), series };
      }
      if (assets) {
        const list = [...(((assets as Rec).assets as Rec[]) ?? [])].sort((a, b) => Number(b.volume ?? 0) - Number(a.volume ?? 0));
        const lim = args.assetsLimit ?? 40;
        out.volumeByAsset = { ...(assets as Rec), assetCount: list.length, assets: list.slice(0, lim) };
      }
      return result(envelope("/api/dashboard/builder-stats", pick(out, args.fields), { window: q.window, ...(resolved ? { resolvedBuilder: resolved } : {}) }));
    },
  );

  defineTool(
    server,
    "flowscan_builder_intelligence_list",
    {
      title: "Builder Intelligence: builders & categories",
      description:
        "The /builder-intelligence index: ~120 analysed builders (id, name, category, total/active users, all-time revenue/volume USD, 7d new users) and categories. Ids feed flowscan_builder_intelligence_detail, category ids flowscan_builder_intelligence_summary. Prefer this for user-status/retention questions. Its '7d new users' comes from a different dataset than the leaderboard's and user_series'; say which you quote.",
      inputSchema: {
        search: z.string().optional().describe("Builder id/name substring."),
        category: z.string().optional().describe("Filter by category id/name substring."),
        sortBy: z.enum(["total_revenue", "total_users", "active_users", "7d_new_users", "total_volume"]).optional().describe("Default total_revenue desc."),
        includeCategories: z.boolean().optional().describe("Also return the categories list (default true)."),
        ...shapeInput,
      },
    },
    async (args) => {
      const [b, c] = await Promise.all([get("/api/intelligence/builders", {}, { ttlMs: LONG_TTL_MS }) as Promise<Rec>, (args.includeCategories ?? true) ? (get("/api/intelligence/categories", {}, { ttlMs: LONG_TTL_MS }) as Promise<Rec>) : null]);
      const key = args.sortBy ?? "total_revenue";
      let rows = ((b.builders as Rec[]) ?? []).filter((x) => (matches(x.id, args.search) || matches(x.name, args.search)) && matches(x.category, args.category));
      rows = [...rows].sort((x, y) => Number(y[key] ?? 0) - Number(x[key] ?? 0));
      const { items, paging } = page(rows, args, 50);
      const out: Rec = { builders: items };
      if (c) out.categories = c.categories;
      return result(envelope("/api/intelligence/builders", pick(out, args.fields), { paging }));
    },
  );

  defineTool(
    server,
    "flowscan_builder_intelligence_detail",
    {
      title: "Builder Intelligence: deep-dive for one builder",
      description:
        "A /builder-intelligence builder report: user status (active/dormant/cooling-off/switched/moved-on), revenue, cohorts, lifecycle, retention, daily activity, top users, heatmap, daily revenue. Payload is ~11 MB, so pick `sections` (default metadata, key_metrics, user_status_metrics, revenue_metrics). Long lists are paged with limit/offset (50 top-level, 20 nested) and address lists become {count, sample}.",
      inputSchema: {
        builderId: z.string().describe("Builder id from flowscan_builder_intelligence_list (e.g. 'phantom', 'pvp')."),
        sections: z.array(z.enum(INTEL_SECTIONS)).optional().describe("Report sections to return (default metadata, key_metrics, user_status_metrics, revenue_metrics)."),
        startDate: DATE_YMD.optional().describe("YYYY-MM-DD UTC, inclusive."),
        endDate: DATE_YMD.optional().describe("YYYY-MM-DD UTC, inclusive."),
        ...shapeInput,
      },
    },
    async (args) => {
      // The route is case-insensitive; normalising keeps one cache entry per builder (payloads are ~10 MB+).
      const id = String(args.builderId).trim().replace(/^id:/i, "").toLowerCase();
      const route = `/api/intelligence/builders/${encodeURIComponent(id)}`;
      const d = (await get(route, { startDate: args.startDate, endDate: args.endDate }, { ttlMs: LONG_TTL_MS })) as Rec;
      const sections = args.sections ?? ["metadata", "key_metrics", "user_status_metrics", "revenue_metrics"];
      const out: Rec = {};
      for (const s of sections) {
        let v = d[s];
        if (Array.isArray(v)) {
          const { items, paging } = page(v as Rec[], args, 50);
          v = items;
          out[`${s}Paging`] = paging;
        } else if (v && typeof v === "object") {
          // page long lists inside sections (e.g. weekly cohorts) with the same limit/offset
          const obj = { ...(v as Rec) };
          const nestedLimit = args.limit ?? 20;
          for (const [k, val] of Object.entries(obj)) {
            if (Array.isArray(val) && val.length > nestedLimit && !val.every((x) => typeof x !== "object")) {
              const { items, paging } = page(val as Rec[], args, 20);
              obj[k] = items;
              obj[`${k}Paging`] = paging;
            }
          }
          v = obj;
        }
        out[s] = compactAddressLists(v);
      }
      return result(envelope(route, pick(out, args.fields), { availableSections: INTEL_SECTIONS }));
    },
  );

  defineTool(
    server,
    "flowscan_builder_intelligence_summary",
    {
      title: "Builder Intelligence: category or overall summary",
      description:
        "The /builder-intelligence aggregate view for a category (e.g. wallet, copytrading, desktop_trading, mobile_trading) or 'overall': metadata (builders included and their weights), totals (users, active users, 7d new users, all-time revenue, fees 24h/7d/30d/90d, average daily revenue, week-1/4 retention) and user-weighted averages (key metrics, user status, revenue by status, lifecycle, retention, equity/fee cohorts). Cohort member address lists are reduced to {count, sample}.",
      inputSchema: {
        category: z.string().optional().describe("Category id from flowscan_builder_intelligence_list, or 'overall' (default)."),
        startDate: DATE_YMD.optional().describe("YYYY-MM-DD UTC, inclusive."),
        endDate: DATE_YMD.optional().describe("YYYY-MM-DD UTC, inclusive."),
        includeExcludedBuilders: z.boolean().optional().describe("Keep metadata.builders_excluded (can be >1000 entries; default false)."),
        fields: shapeInput.fields,
      },
    },
    async (args) => {
      const cat = (args.category ?? "overall").toLowerCase();
      const route = `/api/intelligence/summary/${encodeURIComponent(cat)}`;
      const d = (await get(route, { startDate: args.startDate, endDate: args.endDate }, { ttlMs: LONG_TTL_MS })) as Rec;
      const out = { ...d } as Rec;
      if (!args.includeExcludedBuilders && out.metadata && typeof out.metadata === "object") {
        const m = { ...(out.metadata as Rec) };
        if (Array.isArray(m.builders_excluded)) m.builders_excluded = { count: m.builders_excluded.length, note: "omitted; set includeExcludedBuilders" };
        out.metadata = m;
      }
      // cohort entries embed every member address (~1 MB); keep counts + a sample
      return result(envelope(route, pick(compactAddressLists(out), args.fields)));
    },
  );
}
