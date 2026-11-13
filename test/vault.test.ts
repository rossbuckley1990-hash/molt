import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Molt, OriginVault, type WireExchange } from "../src/index.ts";

test("OriginVault enforces strict RFC 6454 origin pinning and encrypts secrets at rest", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "molt-vault-test-"));
  try {
    const vaultPath = path.join(tmpDir, "origin.vault");
    const vault = new OriginVault();

    const secretCookie = "sid_SUPER_SECRET_SESSION_9918273645";
    const secretCsrf = "csrf_ULTRA_SECRET_TOKEN_abcdef123456";
    const secretBearer = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secretpayload";

    vault.ingestExchange({
      id: "ex-1",
      startedAt: 1000,
      method: "POST",
      url: "https://admin.acme.io/api/v1/orders",
      requestHeaders: {
        cookie: `acme_sid=${secretCookie}`,
        "x-csrf-token": secretCsrf,
        authorization: secretBearer,
      },
      status: 200,
      responseHeaders: { "content-type": "application/json" },
      responseBody: JSON.stringify({ ok: true }),
    });

    // Exact origin receives vaulted headers
    const allowed = vault.headersForUrl("https://admin.acme.io/api/v1/refunds");
    assert.equal(allowed.cookie, `acme_sid=${secretCookie}`);
    assert.equal(allowed["x-csrf-token"], secretCsrf);
    assert.equal(allowed.authorization, secretBearer);

    // Subdomain, different scheme, and different port receive NOTHING
    assert.deepEqual(vault.headersForUrl("https://evil.acme.io/api/v1/refunds"), {});
    assert.deepEqual(vault.headersForUrl("http://admin.acme.io/api/v1/refunds"), {});
    assert.deepEqual(vault.headersForUrl("https://admin.acme.io:8443/api/v1/refunds"), {});
    assert.deepEqual(vault.headersForUrl("https://attacker.example.com/"), {});

    // Summary exposes names and non-reversible fingerprint, NEVER secret values
    const summaryJson = JSON.stringify(vault.summaries());
    assert.ok(!summaryJson.includes(secretCookie));
    assert.ok(!summaryJson.includes(secretCsrf));
    assert.ok(!summaryJson.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"));

    // Save encrypted to disk and verify raw bytes on disk contain zero plaintext secrets
    vault.saveEncrypted(vaultPath, "test-passphrase-with-high-entropy-1234");
    const rawDiskText = fs.readFileSync(vaultPath, "utf8");
    assert.ok(!rawDiskText.includes(secretCookie), "disk vault leaked plaintext cookie");
    assert.ok(!rawDiskText.includes(secretCsrf), "disk vault leaked plaintext CSRF");
    assert.ok(!rawDiskText.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"), "disk vault leaked bearer token");

    const mode = fs.statSync(vaultPath).mode & 0o777;
    assert.equal(mode, 0o600, "vault file must be 0600 owner-only");

    // Round-trip decryption succeeds with right passphrase and fails closed with wrong passphrase
    const reloaded = new OriginVault();
    reloaded.loadEncrypted(vaultPath, "test-passphrase-with-high-entropy-1234");
    assert.equal(reloaded.headersForUrl("https://admin.acme.io/x").cookie, `acme_sid=${secretCookie}`);

    const wrongPass = new OriginVault();
    assert.throws(() => wrongPass.loadEncrypted(vaultPath, "wrong-passphrase-0000000000000000"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("zero credential leakage across OpenAPI specs, capabilities, context_explain, and MCP responses", async () => {
  const rawCookie = "sess_LEAK_CANARY_8877665544332211";
  const rawCsrf = "csrf_LEAK_CANARY_aabbccddeeff0011";
  const rawApiKey = "sk_live_LEAK_CANARY_998877665544";

  const exchanges: WireExchange[] = [
    {
      id: "1",
      startedAt: 100,
      method: "GET",
      url: `https://billing.internal.io/api/v1/customers?email=ross%40acme.io&api_key=${rawApiKey}`,
      requestHeaders: {
        cookie: `session=${rawCookie}`,
        "x-csrf-token": rawCsrf,
        "x-api-key": rawApiKey,
      },
      status: 200,
      responseHeaders: { "content-type": "application/json" },
      responseBody: JSON.stringify({
        customer: { id: "cus_101", email: "ross@acme.io", session_token: rawCookie },
      }),
    },
  ];

  const molt = await Molt.open();
  const reports = await molt.crystallizeExchanges(exchanges);
  assert.equal(reports.length, 1);

  const checkNoCanary = (label: string, payload: unknown) => {
    const text = JSON.stringify(payload);
    assert.ok(!text.includes(rawCookie), `${label} leaked raw cookie`);
    assert.ok(!text.includes(rawCsrf), `${label} leaked raw CSRF token`);
    assert.ok(!text.includes(rawApiKey), `${label} leaked raw API key`);
  };

  checkNoCanary("DistillationReport", reports);
  checkNoCanary("OpenAPI spec", reports[0]!.openapi);

  const mcpTools = await molt.handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  checkNoCanary("MCP tools/list", mcpTools);

  const capId = reports[0]!.reflections[0]!.capabilities[0]!.id;
  const explained = await molt.handleMcp({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "context_explain", arguments: { id: capId, detail: "full" } },
  });
  checkNoCanary("MCP context_explain", explained);

  const providers = await molt.handleMcp({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "context_providers", arguments: {} },
  });
  checkNoCanary("MCP context_providers", providers);
});
