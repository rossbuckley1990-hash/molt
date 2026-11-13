import crypto from "node:crypto";
import http from "node:http";

export interface DemoCustomerRecord {
  id: string;
  email: string;
  name: string;
  tier: string;
  orders: Array<{
    id: string;
    invoice_id: string;
    amount_cents: number;
    currency: string;
    status: "paid" | "refunded";
  }>;
}

export interface DemoDashboardServer {
  origin: string;
  port: number;
  apiVersion: () => 1 | 2;
  /** Invalidate all active session cookies & CSRF tokens (next API request gets 401). */
  expireAllSessions: () => void;
  /** Simulate an undocumented frontend + backend deploy moving /api/v1/* -> /api/v2/commerce/*. */
  deployV2ContractDrift: () => void;
  refundLedger: () => Array<{
    receipt_id: string;
    order_id: string;
    invoice_id: string;
    customer_email: string;
    reason: string;
  }>;
  requestCounts: () => { apiCalls: number; noiseCalls: number; authRejections: number };
  close: () => Promise<void>;
}

const SEED_CUSTOMERS: DemoCustomerRecord[] = [
  {
    id: "cus_991a",
    email: "ross@acme.io",
    name: "Ross Buckley",
    tier: "enterprise",
    orders: [
      { id: "88412", invoice_id: "inv_772b", amount_cents: 14900, currency: "USD", status: "paid" },
    ],
  },
  {
    id: "cus_442c",
    email: "elena@globex.dev",
    name: "Elena Vance",
    tier: "growth",
    orders: [
      { id: "91054", invoice_id: "inv_883d", amount_cents: 29900, currency: "USD", status: "paid" },
    ],
  },
  {
    id: "cus_718f",
    email: "marcus@initech.io",
    name: "Marcus Chen",
    tier: "enterprise",
    orders: [
      { id: "95301", invoice_id: "inv_912e", amount_cents: 8900, currency: "USD", status: "paid" },
    ],
  },
];

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

/**
 * Start a realistic undocumented internal Admin SPA + JSON API server on 127.0.0.1.
 *
 * Deliberately serves NO OpenAPI/Swagger spec (404/403 on all discovery probes),
 * enforces HttpOnly session cookies + X-CSRF-Token on writes, emits noisy analytics/asset
 * requests from the browser UI, and supports live session expiry + v1 -> v2 API drift.
 */
export async function startDemoDashboardServer(): Promise<DemoDashboardServer> {
  let version: 1 | 2 = 1;
  const validSessions = new Map<string, string>(); // sid -> csrfToken
  const customers = new Map<string, DemoCustomerRecord>(
    SEED_CUSTOMERS.map((c) => [c.email, structuredClone(c)]),
  );
  const refunds: Array<{
    receipt_id: string;
    order_id: string;
    invoice_id: string;
    customer_email: string;
    reason: string;
  }> = [];

  let apiCalls = 0;
  let noiseCalls = 0;
  let authRejections = 0;

  const issueSession = () => {
    const sid = `sid_${crypto.randomBytes(12).toString("hex")}`;
    const csrf = `csrf_${crypto.randomBytes(12).toString("hex")}`;
    validSessions.set(sid, csrf);
    return { sid, csrf };
  };

  const renderSpaHtml = (csrf: string) => {
    // Realistic enterprise admin DOM (~32KB of dashboard table + chrome so DOM token cost is realistic)
    const fillerRows = Array.from({ length: 85 }, (_, idx) =>
      `<tr class="ops-row ops-row-${idx % 4}" data-row-index="${idx}">
        <td class="cell-mono">aud_${10000 + idx}</td>
        <td>system.reconcile.checkpoint.${idx}</td>
        <td><span class="badge badge-ok">verified</span></td>
        <td>us-east-${(idx % 3) + 1}</td>
        <td>2026-11-13T12:${String(idx % 60).padStart(2, "0")}:00Z</td>
      </tr>`,
    ).join("\n");

    const v1Script = `
      async function runRefundWorkflow() {
        const email = document.getElementById("customer-email").value.trim();
        const reason = document.getElementById("refund-reason").value.trim() || "duplicate_charge";
        fetch("/telemetry/events/track", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: "lookup_clicked", ts: Date.now() }) });
        fetch("/api/client-log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ level: "info", page: "/admin/refunds", viewport: "1440x900" }) });

        const cRes = await fetch("/api/v1/customers/lookup?email=" + encodeURIComponent(email) + "&limit=25&page=1", {
          headers: { "Accept": "application/json" }
        });
        const cJson = await cRes.json();
        const customerId = cJson.data.customer.id;

        const oRes = await fetch("/api/v1/customers/" + encodeURIComponent(customerId) + "/orders?limit=20", {
          headers: { "Accept": "application/json" }
        });
        const oJson = await oRes.json();
        const order = oJson.data.orders[0];

        const rRes = await fetch("/api/v1/orders/" + encodeURIComponent(order.id) + "/refund", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-CSRF-Token": window.__CSRF__
          },
          body: JSON.stringify({ invoice_id: order.invoice_id, reason })
        });
        const rJson = await rRes.json();
        document.getElementById("result-banner").textContent = JSON.stringify(rJson);
      }
    `;

    const v2Script = `
      async function runRefundWorkflow() {
        const email = document.getElementById("customer-email").value.trim();
        const reason = document.getElementById("refund-reason").value.trim() || "duplicate_charge";
        fetch("/telemetry/events/track", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: "v2_lookup_clicked", ts: Date.now() }) });

        const cRes = await fetch("/api/v2/commerce/customers/search?email=" + encodeURIComponent(email) + "&page_size=25", {
          headers: { "Accept": "application/json" }
        });
        const cJson = await cRes.json();
        const customerId = cJson.payload.account.id;

        const oRes = await fetch("/api/v2/commerce/customers/" + encodeURIComponent(customerId) + "/ledger?limit=20", {
          headers: { "Accept": "application/json" }
        });
        const oJson = await oRes.json();
        const order = oJson.payload.entries[0];

        const rRes = await fetch("/api/v2/commerce/orders/" + encodeURIComponent(order.id) + "/issue-refund", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-CSRF-Token": window.__CSRF__
          },
          body: JSON.stringify({ invoice_id: order.invoice_id, reason })
        });
        const rJson = await rRes.json();
        document.getElementById("result-banner").textContent = JSON.stringify(rJson);
      }
    `;

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Acme Internal Billing Console (v${version})</title>
  <link rel="stylesheet" href="/assets/dashboard.css" />
  <script src="/assets/vendor-telemetry.js" defer></script>
</head>
<body>
  <header class="topbar"><h1>Acme Billing Ops Console v${version}.0</h1></header>
  <main class="panel">
    <label for="customer-email">Customer Email</label>
    <input id="customer-email" name="customer_email" type="email" value="ross@acme.io" />
    <label for="refund-reason">Refund Reason</label>
    <input id="refund-reason" name="refund_reason" type="text" value="duplicate_charge" />
    <button id="execute-refund-btn" type="button" onclick="runRefundWorkflow()">Lookup &amp; Refund Latest Order</button>
    <pre id="result-banner" data-testid="result"></pre>
    <table class="audit-stream"><tbody>${fillerRows}</tbody></table>
  </main>
  <script>
    window.__CSRF__ = ${JSON.stringify(csrf)};
    fetch("/heartbeat", { headers: { "Accept": "application/json" } });
    fetch("/telemetry/events/track", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: "console_hydrated", ts: Date.now() }) });
    fetch("/api/client-log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ level: "debug", event: "mount", duration_ms: 14 }) });
    ${version === 1 ? v1Script : v2Script}
  </script>
</body>
</html>`;
  };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const method = (req.method ?? "GET").toUpperCase();

    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const rawBody = Buffer.concat(chunks).toString("utf8");

    const sendJson = (status: number, body: unknown, extraHeaders: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...extraHeaders });
      res.end(JSON.stringify(body));
    };

    // SPA Entry (authenticates browser session via HttpOnly cookie + meta CSRF)
    if (method === "GET" && (u.pathname === "/" || u.pathname === "/admin" || u.pathname === "/admin/refunds")) {
      const { sid, csrf } = issueSession();
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": `acme_admin_sid=${sid}; Path=/; HttpOnly; SameSite=Lax`,
        "x-csrf-token": csrf,
      });
      res.end(renderSpaHtml(csrf));
      return;
    }

    // Static assets & noise endpoints
    if (u.pathname === "/assets/dashboard.css") {
      noiseCalls++;
      res.writeHead(200, { "content-type": "text/css" });
      res.end("body { font-family: system-ui; margin: 2rem; }");
      return;
    }
    if (u.pathname === "/assets/vendor-telemetry.js") {
      noiseCalls++;
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end("window.__TELEMETRY_LOADED__ = true;");
      return;
    }
    if (u.pathname === "/favicon.ico") {
      noiseCalls++;
      res.writeHead(204);
      res.end();
      return;
    }
    if (u.pathname === "/telemetry/events/track") {
      noiseCalls++;
      res.writeHead(204);
      res.end();
      return;
    }
    if (u.pathname === "/heartbeat") {
      noiseCalls++;
      sendJson(200, { healthy: true });
      return;
    }
    if (u.pathname === "/api/client-log") {
      noiseCalls++;
      sendJson(200, { ok: true });
      return;
    }

    // Refuse OpenAPI / Swagger / GraphQL discovery probes (undocumented internal dashboard!)
    if (/openapi|swagger|api-docs|\.well-known/i.test(u.pathname)) {
      sendJson(404, { error: "no public API specification exists" });
      return;
    }

    // Authenticate all /api/* endpoints via HttpOnly session cookie (+ X-CSRF-Token on POST)
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies.acme_admin_sid;
    const expectedCsrf = sid ? validSessions.get(sid) : undefined;
    if (!sid || !expectedCsrf) {
      authRejections++;
      sendJson(401, { error: "session_expired_or_missing" });
      return;
    }
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      const providedCsrf = String(req.headers["x-csrf-token"] ?? "");
      if (providedCsrf !== expectedCsrf) {
        authRejections++;
        sendJson(403, { error: "invalid_or_missing_csrf_token" });
        return;
      }
    }

    apiCalls++;

    // ======================== API v1 Routes ========================
    if (version === 1) {
      if (method === "GET" && u.pathname === "/api/v1/customers/lookup") {
        const email = u.searchParams.get("email") ?? "";
        const customer = customers.get(email);
        if (!customer) return sendJson(404, { error: `customer not found: ${email}` });
        return sendJson(200, {
          data: {
            customer: { id: customer.id, email: customer.email, name: customer.name, tier: customer.tier },
          },
        });
      }

      const ordersMatch = /^\/api\/v1\/customers\/([^/]+)\/orders$/.exec(u.pathname);
      if (method === "GET" && ordersMatch) {
        const cid = decodeURIComponent(ordersMatch[1]!);
        const customer = [...customers.values()].find((c) => c.id === cid);
        if (!customer) return sendJson(404, { error: `unknown customer ${cid}` });
        return sendJson(200, { data: { orders: customer.orders } });
      }

      const refundMatch = /^\/api\/v1\/orders\/([^/]+)\/refund$/.exec(u.pathname);
      if (method === "POST" && refundMatch) {
        const orderId = decodeURIComponent(refundMatch[1]!);
        const payload = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
        const owner = [...customers.values()].find((c) => c.orders.some((o) => o.id === orderId));
        const order = owner?.orders.find((o) => o.id === orderId);
        if (!owner || !order) return sendJson(404, { error: `unknown order ${orderId}` });
        const invoiceId = String(payload.invoice_id ?? order.invoice_id);
        const reason = String(payload.reason ?? "requested_by_customer");
        order.status = "refunded";
        const receipt = {
          receipt_id: `rcpt_v1_${orderId}_${refunds.length + 1}`,
          order_id: orderId,
          invoice_id: invoiceId,
          customer_email: owner.email,
          refunded_cents: order.amount_cents,
          currency: order.currency,
          reason,
          status: "refunded",
        };
        refunds.push(receipt);
        return sendJson(200, receipt);
      }
    }

    // ======================== API v2 (Drifted) Routes ========================
    if (version === 2) {
      if (method === "GET" && u.pathname === "/api/v2/commerce/customers/search") {
        const email = u.searchParams.get("email") ?? "";
        const customer = customers.get(email);
        if (!customer) return sendJson(404, { error: `customer not found: ${email}` });
        return sendJson(200, {
          payload: {
            account: { id: customer.id, email: customer.email, fullName: customer.name, plan: customer.tier },
          },
        });
      }

      const ledgerMatch = /^\/api\/v2\/commerce\/customers\/([^/]+)\/ledger$/.exec(u.pathname);
      if (method === "GET" && ledgerMatch) {
        const cid = decodeURIComponent(ledgerMatch[1]!);
        const customer = [...customers.values()].find((c) => c.id === cid);
        if (!customer) return sendJson(404, { error: `unknown customer ${cid}` });
        return sendJson(200, { payload: { entries: customer.orders } });
      }

      const v2RefundMatch = /^\/api\/v2\/commerce\/orders\/([^/]+)\/issue-refund$/.exec(u.pathname);
      if (method === "POST" && v2RefundMatch) {
        const orderId = decodeURIComponent(v2RefundMatch[1]!);
        const payload = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
        const owner = [...customers.values()].find((c) => c.orders.some((o) => o.id === orderId));
        const order = owner?.orders.find((o) => o.id === orderId);
        if (!owner || !order) return sendJson(404, { error: `unknown order ${orderId}` });
        const invoiceId = String(payload.invoice_id ?? order.invoice_id);
        const reason = String(payload.reason ?? "requested_by_customer");
        order.status = "refunded";
        const receipt = {
          receipt_id: `rcpt_v2_${orderId}_${refunds.length + 1}`,
          order_id: orderId,
          invoice_id: invoiceId,
          customer_email: owner.email,
          refunded_cents: order.amount_cents,
          currency: order.currency,
          reason,
          status: "refunded",
        };
        refunds.push(receipt);
        return sendJson(200, receipt);
      }
    }

    sendJson(404, { error: `route ${method} ${u.pathname} not found on API v${version}` });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    port,
    apiVersion: () => version,
    expireAllSessions: () => {
      validSessions.clear();
    },
    deployV2ContractDrift: () => {
      version = 2;
    },
    refundLedger: () => [...refunds],
    requestCounts: () => ({ apiCalls, noiseCalls, authRejections }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
