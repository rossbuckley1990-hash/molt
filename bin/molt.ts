#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Molt } from "../src/runtime/molt.ts";
import type { BrowserRecipe } from "../src/types.ts";
import type { JsonRpc } from "../vendor/rightclick-x/src/interface/mcp-server.ts";
import { runLiveDemo } from "../demo/run-demo.ts";

function parseFlags(argv: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 2) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function defaultStateDir(flags: Record<string, string | boolean>): string {
  if (typeof flags.state === "string") return path.resolve(flags.state);
  if (process.env.MOLT_STATE_DIR) return path.resolve(process.env.MOLT_STATE_DIR);
  return path.resolve(process.cwd(), ".molt");
}

async function serveMoltStdio(molt: Molt): Promise<void> {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpc | JsonRpc[];
      try {
        msg = JSON.parse(line);
      } catch {
        process.stdout.write(
          JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n",
        );
        continue;
      }
      if (Array.isArray(msg)) {
        const replies = (await Promise.all(msg.map((m) => molt.handleMcp(m)))).filter(Boolean);
        if (replies.length) process.stdout.write(JSON.stringify(replies) + "\n");
      } else {
        const reply = await molt.handleMcp(msg);
        if (reply) process.stdout.write(JSON.stringify(reply) + "\n");
      }
    }
  });
}

function printHelp(): void {
  console.log(`molt v0.1.0 — Browser-to-API Crystallizer (built on RightClick X)

Usage:
  molt demo                                  Run live Headless Chrome + API v1→v2 drift benchmark
  molt mcp [--state <dir>]                   Start MCP stdio server (13 invariant context_* tools)
  molt attach [--port 9222] [--url <match>]  Attach to an open Chrome tab over CDP & crystallize
              [--duration 10000] [--state <dir>]
  molt capture <url> [--recipe <file.json>]  Launch Chrome once, capture wire graph, evaporate Chrome
              [--headed] [--out-openapi <spec.json>] [--state <dir>]
  molt distill <session.har>                 Distill a HAR 1.2 recording into context_* capabilities
              [--out-openapi <spec.json>] [--state <dir>]
  molt inspect <value>                       Classify a value in the RightClick X semantic lattice
  molt actions <value> [--state <dir>]       List direct capabilities & multi-hop reachable types
  molt graph [stats|search|paths] [--state]  Query the crystallized capability graph
  molt compose --have <json> --want <type>   Plan (and with --run execute) a multi-hop workflow
  molt run <capabilityId> [--args <json>]    Execute a crystallized capability or goal:<slug>
`);
}

async function main(): Promise<void> {
  const [subcommand, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseFlags(rest);

  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    printHelp();
    return;
  }

  if (subcommand === "demo") {
    await runLiveDemo();
    return;
  }

  if (subcommand === "mcp") {
    const molt = await Molt.open({ stateDir: defaultStateDir(flags) });
    await serveMoltStdio(molt);
    return;
  }

  if (subcommand === "distill") {
    const harFile = positional[0];
    if (!harFile) throw new Error("Usage: molt distill <file.har> [--out-openapi spec.json]");
    const molt = await Molt.open({ stateDir: defaultStateDir(flags) });
    const reports = await molt.crystallizeHar(path.resolve(harFile), {
      isFilePath: true,
      ...(typeof flags.origin === "string" ? { targetOrigin: flags.origin } : {}),
    });
    if (typeof flags["out-openapi"] === "string" && reports[0]?.openapi) {
      fs.writeFileSync(path.resolve(flags["out-openapi"]), JSON.stringify(reports[0].openapi, null, 2) + "\n");
    }
    console.log(
      JSON.stringify(
        reports.map((r) => ({
          origin: r.origin,
          exchangesTotal: r.exchangesTotal,
          exchangesDistilled: r.exchangesDistilled,
          prunedCount: r.pruned.length,
          provenanceEdges: r.provenance.length,
          restCapabilities: r.restCapabilities,
          graphqlCapabilities: r.graphqlCapabilities,
          vault: r.vault,
          capabilityIds: r.reflections.flatMap((ref) => ref.capabilities.map((c) => c.id)),
        })),
        null,
        2,
      ),
    );
    return;
  }

  if (subcommand === "attach") {
    const port = typeof flags.port === "string" ? Number(flags.port) : 9222;
    const durationMs = typeof flags.duration === "string" ? Number(flags.duration) : 10_000;
    const urlIncludes = typeof flags.url === "string" ? flags.url : undefined;
    const molt = await Molt.open({ stateDir: defaultStateDir(flags) });
    const res = await molt.crystallizeFromLiveTab({ port, durationMs, urlIncludes });
    console.log(
      JSON.stringify(
        {
          targetTitle: res.targetTitle,
          targetUrl: res.targetUrl,
          reports: res.reports.map((r) => ({
            origin: r.origin,
            exchangesTotal: r.exchangesTotal,
            exchangesDistilled: r.exchangesDistilled,
            prunedCount: r.pruned.length,
            provenanceEdges: r.provenance.length,
            vault: r.vault,
            capabilities: r.reflections.flatMap((ref) => ref.capabilities.map((c) => c.id)),
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (subcommand === "capture") {
    const url = positional[0];
    if (!url) throw new Error("Usage: molt capture <url> [--recipe steps.json] [--headed]");
    const origin = new URL(url).origin;
    let recipe: BrowserRecipe = {
      origin,
      entryUrl: url,
      headless: flags.headed !== true,
      settleMs: typeof flags.settle === "string" ? Number(flags.settle) : 500,
    };
    if (typeof flags.recipe === "string") {
      const loaded = JSON.parse(fs.readFileSync(path.resolve(flags.recipe), "utf8")) as Partial<BrowserRecipe>;
      recipe = { ...recipe, ...loaded, origin: loaded.origin ?? origin, entryUrl: loaded.entryUrl ?? url };
    }
    const molt = await Molt.open({ stateDir: defaultStateDir(flags) });
    const captured = await molt.crystallizeFromBrowser(recipe);
    if (typeof flags["out-openapi"] === "string" && captured.reports[0]?.openapi) {
      fs.writeFileSync(
        path.resolve(flags["out-openapi"]),
        JSON.stringify(captured.reports[0].openapi, null, 2) + "\n",
      );
    }
    console.log(
      JSON.stringify(
        {
          captureDurationMs: captured.captureDurationMs,
          exchangesCaptured: captured.exchangesCaptured,
          reports: captured.reports.map((r) => ({
            origin: r.origin,
            restCapabilities: r.restCapabilities,
            graphqlCapabilities: r.graphqlCapabilities,
            prunedCount: r.pruned.length,
            provenanceEdges: r.provenance.length,
            vault: r.vault,
            capabilities: r.reflections.flatMap((ref) => ref.capabilities.map((c) => c.id)),
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (subcommand === "inspect") {
    const val = positional[0] ?? "";
    const molt = await Molt.open();
    console.log(JSON.stringify(await molt.dispatch("context_inspect", { value: val }), null, 2));
    return;
  }

  if (subcommand === "actions") {
    const val = positional[0] ?? "";
    const molt = await Molt.open({ stateDir: defaultStateDir(flags) });
    console.log(JSON.stringify(await molt.dispatch("context_actions", { value: val }), null, 2));
    return;
  }

  if (subcommand === "graph") {
    const op = positional[0] ?? "stats";
    const molt = await Molt.open({ stateDir: defaultStateDir(flags) });
    console.log(
      JSON.stringify(
        await molt.dispatch("context_graph", {
          op,
          ...(typeof flags.query === "string" ? { query: flags.query } : {}),
          ...(typeof flags.id === "string" ? { id: flags.id } : {}),
          ...(typeof flags.from === "string" ? { from: flags.from } : {}),
          ...(typeof flags.to === "string" ? { to: flags.to } : {}),
        }),
        null,
        2,
      ),
    );
    return;
  }

  if (subcommand === "compose") {
    const have = typeof flags.have === "string" ? JSON.parse(flags.have) : {};
    const want = typeof flags.want === "string" ? flags.want : "json";
    const molt = await Molt.open({ stateDir: defaultStateDir(flags) });
    const out = await molt.dispatch("context_compose", {
      have,
      want,
      ...(typeof flags.intent === "string" ? { intent: flags.intent } : {}),
      ...(flags.run === true ? { run: true } : {}),
      ...(typeof flags.publish === "string" ? { publish: flags.publish } : {}),
    });
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (subcommand === "run") {
    const id = positional[0];
    if (!id) throw new Error("Usage: molt run <capabilityId> [--args '{...}']");
    const args = typeof flags.args === "string" ? JSON.parse(flags.args) : {};
    const molt = await Molt.open({ stateDir: defaultStateDir(flags) });
    const out = await molt.dispatch("context_run", {
      id,
      args,
      ...(flags.confirm === true ? { confirm: true } : {}),
    });
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  throw new Error(`Unknown subcommand "${subcommand}". Run "molt --help" for usage.`);
}

main().catch((err) => {
  process.stderr.write(`molt error: ${String((err as Error)?.message ?? err)}\n`);
  process.exit(1);
});
