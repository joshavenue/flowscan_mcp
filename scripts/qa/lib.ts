/**
 * Shared QA helpers: spawn the MCP server from source (npx tsx src/index.ts)
 * with a fetch spy preloaded, call tools, and fetch raw Flowscan routes for
 * ground truth.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BASE = "https://www.flowscan.xyz";
export const TRUNC_MARKER = "[TRUNCATED:";

export type FetchLog = { host: string; inflight: number; max: number; url: string; status?: number; ms?: number; kind: "start" | "end" | "fail" };

export interface CallResult {
  tool: string;
  args: Record<string, unknown>;
  ms: number;
  chars: number;
  isError: boolean;
  text: string;
  json: any;
  truncated: boolean;
  fetches: FetchLog[];
}

export class Harness {
  client!: Client;
  transport!: StdioClientTransport;
  fetchLog: FetchLog[] = [];
  stderrTail = "";

  async start(env: Record<string, string> = {}): Promise<void> {
    const spy = path.join(ROOT, "scripts", "qa", "fetch-spy.mjs");
    this.transport = new StdioClientTransport({
      command: "npx",
      args: ["tsx", "src/index.ts"],
      cwd: ROOT,
      env: { ...(process.env as Record<string, string>), NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${spy}`.trim(), ...env },
      stderr: "pipe",
    });
    const se = this.transport.stderr;
    se?.on("data", (b: Buffer) => {
      const s = b.toString();
      this.stderrTail = (this.stderrTail + s).slice(-20_000);
      for (const line of s.split("\n")) {
        const m = line.match(/^\[qa-fetch\] (start|end|fail) host=(\S+)(?: inflight=(\d+) max=(\d+))?.*?(?:status=(\d+))?(?: ms=(\d+))?.*?url=(\S*)?/);
        if (m) this.fetchLog.push({ kind: m[1] as FetchLog["kind"], host: m[2], inflight: Number(m[3] ?? 0), max: Number(m[4] ?? 0), status: m[5] ? Number(m[5]) : undefined, ms: m[6] ? Number(m[6]) : undefined, url: m[7] ?? "" });
      }
    });
    this.client = new Client({ name: "flowscan-qa", version: "0.0.1" });
    await this.client.connect(this.transport);
  }

  async stop(): Promise<void> {
    await this.client.close().catch(() => {});
  }

  async listTools() {
    return (await this.client.listTools()).tools;
  }

  async call(tool: string, args: Record<string, unknown> = {}): Promise<CallResult> {
    const before = this.fetchLog.length;
    const t0 = Date.now();
    let text = "";
    let isError = false;
    try {
      const r: any = await this.client.callTool({ name: tool, arguments: args }, undefined, { timeout: 240_000 });
      text = (r.content ?? []).map((c: any) => c.text ?? "").join("\n");
      isError = Boolean(r.isError);
    } catch (e) {
      text = `CLIENT ERROR: ${(e as Error).message}`;
      isError = true;
    }
    const ms = Date.now() - t0;
    let json: any = null;
    const truncated = text.includes(TRUNC_MARKER);
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON (truncated or validation error text) */
    }
    return { tool, args, ms, chars: text.length, isError, text, json, truncated, fetches: this.fetchLog.slice(before) };
  }
}

export async function raw(route: string, init?: { method?: string; body?: unknown }): Promise<any> {
  const res = await fetch(`${BASE}${route}`, {
    method: init?.method ?? "GET",
    headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}) },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

export const ymd = (d: Date) => d.toISOString().slice(0, 10);
export const daysAgo = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return ymd(d);
};
export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
