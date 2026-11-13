import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Molt, type WireExchange } from "../src/index.ts";

const execFileAsync = promisify(execFile);

test("write-safety guard never auto-replays a pipeline after a non-read write step has committed", async () => {
  let chargesCreated = 0;
  let step2Fail = false;

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST" && u.pathname === "/api/v1/charges") {
      chargesCreated++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ charge_id: `ch_${chargesCreated}` }));
      return;
    }
    const m = /^\/api\/v1\/charges\/([^/]+)\/finalize$/.exec(u.pathname);
    if (req.method === "POST" && m) {
      if (step2Fail) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "endpoint moved" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ receipt_id: `rcpt_${m[1]}` }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    let wakeCalls = 0;
    const molt = await Molt.open({
      fallbackCooldownMs: 0,
      wakeBrowser: async () => {
        wakeCalls++;
        return { exchanges: [] };
      },
    });

    molt.registerRecipe({ origin, entryUrl: `${origin}/` });

    const seedExchanges: WireExchange[] = [
      {
        id: "w1",
        startedAt: 100,
        method: "POST",
        url: `${origin}/api/v1/charges`,
        requestHeaders: { "content-type": "application/json" },
        requestBody: JSON.stringify({ email: "ross@acme.io" }),
        status: 200,
        responseHeaders: { "content-type": "application/json" },
        responseBody: JSON.stringify({ charge_id: "ch_seed" }),
      },
      {
        id: "w2",
        startedAt: 200,
        method: "POST",
        url: `${origin}/api/v1/charges/ch_seed/finalize`,
        requestHeaders: { "content-type": "application/json" },
        requestBody: JSON.stringify({ note: "ok" }),
        status: 200,
        responseHeaders: { "content-type": "application/json" },
        responseBody: JSON.stringify({ receipt_id: "rcpt_ch_seed" }),
      },
    ];
    await molt.crystallizeExchanges(seedExchanges, { targetOrigin: origin });

    // Break step 2 AFTER step 1 (a POST write!) commits
    step2Fail = true;
    const result = await molt.compose({
      have: {
        email: { type: "email", value: "ross@acme.io" },
        note: { type: "text", value: "ok", fixed: true },
      },
      want: "id.receipt",
      origins: [origin],
      run: true,
    });

    assert.equal(result.executed?.status, "failed");
    assert.equal(chargesCreated, 1, "POST /charges must NEVER be double-executed by automatic fallback");
    assert.equal(wakeCalls, 0, "browser fallback must not trigger when a prior write step already committed");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("CLI subcommands (inspect, distill) and stdio MCP JSON-RPC server operate end-to-end", async () => {
  const rootDir = path.resolve(import.meta.dirname, "..");
  const cliPath = path.join(rootDir, "bin/molt.ts");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "molt-cli-test-"));

  try {
    // 1. `molt inspect`
    const inspectOut = await execFileAsync(process.execPath, [cliPath, "inspect", "ross@acme.io"], { cwd: rootDir });
    const inspected = JSON.parse(inspectOut.stdout) as { type: string };
    assert.equal(inspected.type, "email");

    // 2. `molt distill <har> --state <dir> --out-openapi <file>`
    const harPath = path.join(tmpDir, "session.har");
    const specPath = path.join(tmpDir, "openapi.json");
    const statePath = path.join(tmpDir, "state");
    fs.writeFileSync(
      harPath,
      JSON.stringify({
        log: {
          version: "1.2",
          entries: [
            {
              startedDateTime: "2026-11-13T18:00:00.000Z",
              request: {
                method: "GET",
                url: "https://api.acme.io/v1/users?email=ross%40acme.io",
                headers: [{ name: "Authorization", value: "Bearer cli_secret_token_99" }],
              },
              response: {
                status: 200,
                headers: [{ name: "Content-Type", value: "application/json" }],
                content: { text: JSON.stringify({ user_id: "usr_42", email: "ross@acme.io" }) },
              },
            },
          ],
        },
      }),
    );

    const distillOut = await execFileAsync(
      process.execPath,
      [cliPath, "distill", harPath, "--state", statePath, "--out-openapi", specPath],
      { cwd: rootDir },
    );
    const distilledSummary = JSON.parse(distillOut.stdout) as Array<{ restCapabilities: number }>;
    assert.equal(distilledSummary[0]!.restCapabilities, 1);
    assert.ok(fs.existsSync(specPath));
    assert.ok(!fs.readFileSync(specPath, "utf8").includes("cli_secret_token_99"));

    // 3. `molt mcp --state <dir>` stdio JSON-RPC round-trip
    const child = spawn(process.execPath, [cliPath, "mcp", "--state", statePath], {
      cwd: rootDir,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const responses: Array<Record<string, unknown>> = [];
    const receivedTwo = new Promise<void>((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("MCP stdio timeout")), 10_000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          responses.push(JSON.parse(line) as Record<string, unknown>);
          if (responses.length >= 2) {
            clearTimeout(timer);
            resolve();
          }
        }
      });
    });

    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n",
    );
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "context_actions", arguments: { value: "ross@acme.io" } },
      }) + "\n",
    );

    await receivedTwo;
    child.kill("SIGTERM");

    assert.equal((responses[0]!.result as { serverInfo: { name: string } }).serverInfo.name, "molt");
    const actionsText = (responses[1]!.result as { content: Array<{ text: string }> }).content[0]!.text;
    assert.ok(actionsText.includes("get-v1-users"), "expected persisted capability in MCP context_actions");
    assert.ok(!actionsText.includes("cli_secret_token_99"), "vaulted token must never appear in MCP output");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
