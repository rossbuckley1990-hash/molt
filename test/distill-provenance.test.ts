import assert from "node:assert/strict";
import test from "node:test";
import { distillWireExchanges, Molt, OriginVault, parseHar, type WireExchange } from "../src/index.ts";

test("chronological port provenance lifts hardcoded IDs ('88412') into typed ports and prunes Stage 1 + Stage 2 noise", () => {
  const exchanges: WireExchange[] = [
    // Request #1: Order search by email (with noisy UI pagination params limit & page)
    {
      id: "req-1",
      startedAt: 1000,
      method: "GET",
      url: "https://ops.acme.io/api/v2/orders?email=ross%40acme.io&limit=25&page=1",
      requestHeaders: {
        cookie: "acme_sid=secret_session_8811",
        "x-csrf-token": "secret_csrf_2299",
      },
      status: 200,
      responseHeaders: { "content-type": "application/json" },
      responseBody: JSON.stringify({
        data: {
          orders: [
            {
              id: "88412",
              invoice_id: "inv_7721",
              status: "paid",
            },
          ],
        },
      }),
    },
    // Request #2: Static bundle (Stage 1 noise)
    {
      id: "req-2",
      startedAt: 1010,
      method: "GET",
      url: "https://ops.acme.io/assets/app.bundle.js",
      requestHeaders: {},
      status: 200,
      responseHeaders: { "content-type": "application/javascript" },
      responseBody: "console.log('bundle');",
      resourceType: "Script",
    },
    // Request #3: Analytics beacon (Stage 1 noise)
    {
      id: "req-3",
      startedAt: 1020,
      method: "POST",
      url: "https://ops.acme.io/telemetry/events",
      requestHeaders: { "content-type": "application/json" },
      requestBody: JSON.stringify({ event: "click_refund" }),
      status: 204,
      responseHeaders: {},
    },
    // Request #4: Undocumented UI state ping under /api/v2/* returning JSON { ok: true }
    // Passes Stage 1, but produces ZERO semantic ports and participates in ZERO provenance edges -> Stage 2 pruned!
    {
      id: "req-4",
      startedAt: 1030,
      method: "POST",
      url: "https://ops.acme.io/api/v2/ui-layout-ping",
      requestHeaders: { "content-type": "application/json" },
      requestBody: JSON.stringify({ collapsed: false, zoom: 1 }),
      status: 200,
      responseHeaders: { "content-type": "application/json" },
      responseBody: JSON.stringify({ ok: true }),
    },
    // Request #5: Refund endpoint using "88412" in path and "inv_7721" in JSON body
    {
      id: "req-5",
      startedAt: 1050,
      method: "POST",
      url: "https://ops.acme.io/api/v2/orders/88412/refund",
      requestHeaders: {
        cookie: "acme_sid=secret_session_8811",
        "x-csrf-token": "secret_csrf_2299",
        "content-type": "application/json",
      },
      requestBody: JSON.stringify({
        invoice_id: "inv_7721",
        reason: "duplicate_charge",
      }),
      status: 200,
      responseHeaders: { "content-type": "application/json" },
      responseBody: JSON.stringify({
        receipt_id: "rcpt_88412_ok",
        order_id: "88412",
        status: "refunded",
      }),
    },
  ];

  const vault = new OriginVault();
  const reports = distillWireExchanges(exchanges, vault, { targetOrigin: "https://ops.acme.io" });
  assert.equal(reports.length, 1);
  const report = reports[0]!;

  // 2 real API operations kept; 3 noise frames pruned (2 Stage 1 + 1 Stage 2)
  assert.equal(report.exchangesTotal, 5);
  assert.equal(report.exchangesDistilled, 2);
  assert.equal(report.restCapabilities, 2);
  assert.equal(report.pruned.length, 3);
  assert.ok(report.pruned.some((p) => p.reason === "static-asset"));
  assert.ok(report.pruned.some((p) => p.reason === "heartbeat-or-beacon"));
  assert.ok(report.pruned.some((p) => p.reason === "zero-semantic-ports" && p.url.endsWith("/api/v2/ui-layout-ping")));

  // Verify OpenAPI paths: "v2" stays literal, while "88412" is lifted to "{order_id}"
  const paths = (report.openapi as { paths: Record<string, Record<string, unknown>> }).paths;
  assert.ok(Object.hasOwn(paths, "/api/v2/orders"), "expected /api/v2/orders path");
  assert.ok(
    Object.hasOwn(paths, "/api/v2/orders/{order_id}/refund"),
    `expected parameterized /api/v2/orders/{order_id}/refund, got ${JSON.stringify(Object.keys(paths))}`,
  );
  assert.ok(!JSON.stringify(Object.keys(paths)).includes("88412"), "88412 must never be hardcoded in OpenAPI paths");

  // Verify chronological provenance edges
  const orderEdge = report.provenance.find((e) => e.toLocation === "path" && e.toParamName === "order_id");
  assert.ok(orderEdge, "expected provenance edge into path.order_id");
  assert.equal(orderEdge.fromPointer, "/data/orders/0/id");
  assert.equal(orderEdge.fromSemType, "id.order");
  assert.equal(orderEdge.toSemType, "id.order");

  const invoiceEdge = report.provenance.find((e) => e.toLocation === "body" && e.toParamName === "invoice_id");
  assert.ok(invoiceEdge, "expected provenance edge into body.invoice_id");
  assert.equal(invoiceEdge.fromPointer, "/data/orders/0/invoice_id");
  assert.equal(invoiceEdge.toSemType, "id.invoice");

  // Verify OpenAPI 3 links synthesized from Request #1 -> Request #5
  const getOrdersOp = paths["/api/v2/orders"]!.get as {
    parameters: Array<{ name: string; required: boolean; schema: Record<string, unknown> }>;
    responses: { "200": { links?: Record<string, { operationId: string; parameters: Record<string, string> }> } };
  };
  const emailParam = getOrdersOp.parameters.find((p) => p.name === "email");
  const limitParam = getOrdersOp.parameters.find((p) => p.name === "limit");
  const pageParam = getOrdersOp.parameters.find((p) => p.name === "page");
  assert.equal(emailParam?.required, true);
  assert.equal(emailParam?.schema["x-rightclick-type"], "email");
  assert.equal(limitParam?.required, false, "UI pagination 'limit' should remain optional");
  assert.equal(pageParam?.required, false, "UI pagination 'page' should remain optional");

  const links = getOrdersOp.responses["200"].links ?? {};
  const linkValues = Object.values(links);
  assert.equal(linkValues.length, 1);
  assert.equal(linkValues[0]!.parameters["path.order_id"], "$response.body#/data/orders/0/id");
});

test("HAR 1.2 archive ingestion distills primary-origin API and prunes third-party analytics", async () => {
  const harDoc = {
    log: {
      version: "1.2",
      entries: [
        {
          startedDateTime: "2026-11-13T18:00:00.000Z",
          request: {
            method: "GET",
            url: "https://console.acme.io/api/customers?email=elena%40globex.dev",
            headers: [{ name: "Cookie", value: "sid=har_secret_99" }],
          },
          response: {
            status: 200,
            headers: [{ name: "Content-Type", value: "application/json" }],
            content: {
              mimeType: "application/json",
              text: JSON.stringify({ customer_id: "cus_777", email: "elena@globex.dev" }),
            },
          },
        },
        {
          startedDateTime: "2026-11-13T18:00:00.200Z",
          request: {
            method: "POST",
            url: "https://api.segment.io/v1/t",
            headers: [{ name: "Content-Type", value: "application/json" }],
            postData: { text: JSON.stringify({ event: "Page Viewed" }) },
          },
          response: {
            status: 200,
            headers: [{ name: "Content-Type", value: "application/json" }],
            content: { text: JSON.stringify({ success: true }) },
          },
        },
        {
          startedDateTime: "2026-11-13T18:00:00.500Z",
          request: {
            method: "GET",
            url: "https://console.acme.io/api/customers/cus_777/invoices",
            headers: [{ name: "Cookie", value: "sid=har_secret_99" }],
          },
          response: {
            status: 200,
            headers: [{ name: "Content-Type", value: "application/json" }],
            content: {
              mimeType: "application/json",
              text: JSON.stringify({ invoices: [{ invoice_id: "inv_5001", amount_cents: 4900 }] }),
            },
          },
        },
      ],
    },
  };

  const parsed = parseHar(harDoc);
  assert.equal(parsed.exchanges.length, 3);

  const molt = await Molt.open();
  const reports = await molt.crystallizeHar(harDoc, { targetOrigin: "https://console.acme.io" });
  assert.equal(reports.length, 1);
  assert.equal(reports[0]!.restCapabilities, 2);
  assert.ok(reports[0]!.pruned.some((p) => p.url.includes("segment.io")));

  // Inspect & plan multi-hop path email -> id.invoice over the crystallized HAR graph
  const inspected = molt.rc.inspect("elena@globex.dev");
  assert.equal(inspected.type, "email");

  const planned = await molt.compose({
    have: { email: "elena@globex.dev" },
    want: "id.invoice",
    run: false,
  });
  assert.equal(planned.plans[0]!.steps.length, 2);
});
