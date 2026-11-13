import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Molt, type WireExchange } from "../src/index.ts";

test("introspection-disabled live GraphQL wire frames crystallize into multi-hop context_compose capabilities", async () => {
  const expectedBearer = "Bearer gql_secret_vault_token_9988";
  const expectedCsrf = "gql_csrf_token_4455";

  const usersByEmail: Record<string, { id: string; email: string; latestOrder: { id: string; totalCents: number } }> = {
    "ross@acme.io": {
      id: "usr_101",
      email: "ross@acme.io",
      latestOrder: { id: "ord_7001", totalCents: 19900 },
    },
    "elena@globex.dev": {
      id: "usr_202",
      email: "elena@globex.dev",
      latestOrder: { id: "ord_8842", totalCents: 8400 },
    },
  };

  let introspectionBlockedCount = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/graphql") {
      res.writeHead(404);
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      query?: string;
      variables?: Record<string, unknown>;
    };

    const q = body.query ?? "";
    // Explicitly block GraphQL introspection in production!
    if (q.includes("__schema") || q.includes("__type")) {
      introspectionBlockedCount++;
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ errors: [{ message: "GraphQL introspection is disabled" }] }));
      return;
    }

    // Enforce origin-vaulted Bearer + CSRF headers
    if (req.headers.authorization !== expectedBearer || req.headers["x-csrf-token"] !== expectedCsrf) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ errors: [{ message: "Unauthorized" }] }));
      return;
    }

    const vars = body.variables ?? {};
    if (/\buser\s*\(/.test(q)) {
      const email = String(vars.email ?? vars.userEmail ?? "").toLowerCase();
      const hit = usersByEmail[email];
      if (!hit) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ errors: [{ message: `No user for ${email}` }] }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { user: hit } }));
      return;
    }

    if (/\bcreateRefund\s*\(/.test(q)) {
      const orderId = String(vars.orderId ?? vars.targetOrderId ?? "");
      const reason = String(vars.reason ?? "requested");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: {
            createRefund: {
              receipt_id: `rcpt_gql_${orderId}`,
              order_id: orderId,
              reason,
            },
          },
        }),
      );
      return;
    }

    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ errors: [{ message: "Unsupported operation" }] }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  const endpoint = `${origin}/graphql`;

  try {
    // Sanity check: confirm server genuinely blocks __schema introspection
    const probe = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ __schema { queryType { name } } }" }),
    });
    assert.equal(probe.status, 403);
    assert.equal(introspectionBlockedCount, 1);

    // Captured wire exchanges from a browser session (note variable names differ from GraphQL field arg names!)
    const capturedExchanges: WireExchange[] = [
      {
        id: "gql-1",
        startedAt: 100,
        method: "POST",
        url: endpoint,
        requestHeaders: {
          "content-type": "application/json",
          authorization: expectedBearer,
          "x-csrf-token": expectedCsrf,
        },
        requestBody: JSON.stringify({
          operationName: "LookupUser",
          query: `query LookupUser($userEmail: String!) {
            user(email: $userEmail) {
              id
              email
              latestOrder {
                id
                totalCents
              }
            }
          }`,
          variables: { userEmail: "ross@acme.io" },
        }),
        status: 200,
        responseHeaders: { "content-type": "application/json" },
        responseBody: JSON.stringify({
          data: {
            user: usersByEmail["ross@acme.io"],
          },
        }),
      },
      {
        id: "gql-2",
        startedAt: 200,
        method: "POST",
        url: endpoint,
        requestHeaders: {
          "content-type": "application/json",
          authorization: expectedBearer,
          "x-csrf-token": expectedCsrf,
        },
        requestBody: JSON.stringify({
          operationName: "RefundOrder",
          query: `mutation RefundOrder($targetOrderId: ID!, $note: String!) {
            createRefund(orderId: $targetOrderId, reason: $note) {
              receipt_id
              order_id
              reason
            }
          }`,
          variables: { targetOrderId: "ord_7001", note: "duplicate_charge" },
        }),
        status: 200,
        responseHeaders: { "content-type": "application/json" },
        responseBody: JSON.stringify({
          data: {
            createRefund: {
              receipt_id: "rcpt_gql_ord_7001",
              order_id: "ord_7001",
              reason: "duplicate_charge",
            },
          },
        }),
      },
    ];

    const molt = await Molt.open();
    const reports = await molt.crystallizeExchanges(capturedExchanges, { targetOrigin: origin });
    assert.equal(reports.length, 1);
    assert.equal(reports[0]!.graphqlCapabilities, 2);
    // Molt never needed to hit server introspection!
    assert.equal(introspectionBlockedCount, 1);

    // Secrets never leak into synthesized GraphQL introspection
    const gqlSchemaText = JSON.stringify(reports[0]!.graphqlIntrospection);
    assert.ok(!gqlSchemaText.includes("gql_secret_vault_token_9988"));
    assert.ok(!gqlSchemaText.includes("gql_csrf_token_4455"));

    // Execute 2-hop GraphQL workflow for a different user (elena@globex.dev -> ord_8842 -> rcpt_gql_ord_8842)
    const composed = await molt.compose({
      have: {
        email: { type: "email", value: "elena@globex.dev" },
        reason: { type: "text", value: "duplicate_charge", fixed: true },
      },
      want: "id.receipt",
      origins: [origin],
      verify: [{ op: "equals", value: "rcpt_gql_ord_8842" }],
      run: true,
    });

    assert.equal(composed.plans[0]!.steps.length, 2);
    assert.equal(composed.executed?.status, "completed");
    assert.equal(composed.executed?.verification.status, "checked");
    assert.equal(composed.executed?.output, "rcpt_gql_ord_8842");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
