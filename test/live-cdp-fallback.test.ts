import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startDemoDashboardServer } from "../demo/saas-dashboard.ts";
import { findChromeExecutable, Molt, type BrowserRecipe } from "../src/index.ts";

test("live Chrome CDP crystallization, MCP 13-tool protocol, stateDir persistence, and self-evaporating 401 + v1->v2 drift fallback", async (t) => {
  const chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip("Google Chrome / Chromium not installed on host");
    return;
  }

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "molt-live-cdp-"));
  const passphrase = "molt-test-vault-passphrase-99887766";
  const server = await startDemoDashboardServer();

  try {
    let browserWakeCount = 0;
    const recipe: BrowserRecipe = {
      origin: server.origin,
      entryUrl: `${server.origin}/admin/refunds`,
      headless: true,
      steps: [
        { action: "fill", selector: "#customer-email", value: "ross@acme.io" },
        { action: "fill", selector: "#refund-reason", value: "duplicate_charge" },
        { action: "click", selector: "#execute-refund-btn" },
        { action: "waitForIdle", idleMs: 220 },
      ],
    };

    // 1. Open Molt #1 with persistent stateDir and crystallize from live headless Chrome
    const molt1 = await Molt.open({
      stateDir,
      vaultPassphrase: passphrase,
      fallbackCooldownMs: 0,
    });

    const crystal = await molt1.crystallizeFromBrowser(recipe, { title: "Acme Billing Console" });
    assert.equal(crystal.reports.length, 1);
    assert.equal(crystal.reports[0]!.restCapabilities, 3);
    assert.equal(crystal.reports[0]!.provenance.length, 3);

    // 2. Verify MCP JSON-RPC protocol: initialize + tools/list + context_inspect + context_actions + context_compose
    const initRes = (await molt1.handleMcp({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    })) as { result: { serverInfo: { name: string } } };
    assert.equal(initRes.result.serverInfo.name, "molt");

    const toolsRes = (await molt1.handleMcp({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    })) as { result: { tools: Array<{ name: string }> } };
    assert.equal(toolsRes.result.tools.length, 13);

    const inspectRes = (await molt1.handleMcp({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "context_inspect", arguments: { value: "elena@globex.dev" } },
    })) as { result: { content: Array<{ text: string }> } };
    const inspectedJson = JSON.parse(inspectRes.result.content[0]!.text) as { type: string };
    assert.equal(inspectedJson.type, "email");

    // Compose and publish saved goal via MCP context_compose
    const composeMcpRes = (await molt1.handleMcp({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "context_compose",
        arguments: {
          have: {
            email: { type: "email", value: "elena@globex.dev" },
            reason: { type: "text", value: "duplicate_charge", fixed: true },
          },
          want: "id.receipt",
          origins: [server.origin],
          verify: [{ op: "contains", value: "rcpt_" }],
          publish: "refund-customer-order",
          confirmFixedInvariants: ["rcpt_"],
          run: true,
        },
      },
    })) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    assert.ok(!composeMcpRes.result.isError);
    const composedJson = JSON.parse(composeMcpRes.result.content[0]!.text) as {
      executed: { status: string; output: string };
    };
    assert.equal(composedJson.executed.status, "completed");
    assert.match(composedJson.executed.output, /^rcpt_v1_91054_/);

    // 3. Reload from disk in a brand-new Molt instance with ZERO initial browser capture!
    const { captureWithEphemeralChrome } = await import("../src/capture/cdp.ts");
    const molt2 = await Molt.open({
      stateDir,
      vaultPassphrase: passphrase,
      fallbackCooldownMs: 0,
      wakeBrowser: async (r) => {
        browserWakeCount++;
        const c = await captureWithEphemeralChrome(r);
        return { exchanges: c.exchanges, cookies: c.cookies, title: c.pageTitle || undefined };
      },
    });

    // Execute saved goal from persisted stateDir at wire speed -> browserWakeCount stays 0!
    const warmRun = await molt2.run("goal:refund-customer-order", { email: "marcus@initech.io" });
    assert.equal(warmRun.status, "completed");
    assert.match(String(warmRun.output), /^rcpt_v1_95301_/);
    assert.equal(browserWakeCount, 0, "warm wire execution must not launch a browser");

    // 4. Trigger 401 session expiry -> wakes headless Chrome once, rotates Cookie+CSRF, completes!
    server.expireAllSessions();
    const after401 = await molt2.run("goal:refund-customer-order", { email: "elena@globex.dev" });
    assert.equal(after401.status, "completed");
    assert.match(String(after401.output), /^rcpt_v1_91054_/);
    assert.equal(browserWakeCount, 1);
    assert.equal(molt2.fallbackHistory.at(-1)?.trigger, "auth-denied");

    // 5. Trigger /api/v1/* -> /api/v2/commerce/* structural contract drift -> catches 404, wakes Chrome once, replans!
    server.deployV2ContractDrift();
    const afterDrift = await molt2.run("goal:refund-customer-order", { email: "marcus@initech.io" });
    assert.equal(afterDrift.status, "completed");
    assert.match(String(afterDrift.output), /^rcpt_v2_95301_/);
    assert.equal(browserWakeCount, 2);
    assert.equal(molt2.fallbackHistory.at(-1)?.trigger, "contract-drift");

    // 6. Subsequent v2 execution runs headless-free at wire speed (browserWakeCount stays 2!)
    const postDriftWire = await molt2.handleMcp({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "context_run",
        arguments: { id: "goal:refund-customer-order", args: { email: "elena@globex.dev" } },
      },
    }) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    assert.ok(!postDriftWire.result.isError);
    const postDriftJson = JSON.parse(postDriftWire.result.content[0]!.text) as { status: string; output: string };
    assert.equal(postDriftJson.status, "completed");
    assert.match(postDriftJson.output, /^rcpt_v2_91054_/);
    assert.equal(browserWakeCount, 2, "post-drift steady-state must execute with zero browsers open");

    // 7. Verify cryptographic receipt chain across both persisted instances
    const receipts = await molt2.rc.verifyReceipts();
    assert.equal(receipts.intact, true);
    assert.ok(receipts.count >= 15);
  } finally {
    await server.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
