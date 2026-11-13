# molt — Browser Automation That Compiles Itself Into a Native API

`molt` points [RightClick X](https://github.com/rossbuckley1990-hash/rightclick-x)'s semantic port compiler and 13 invariant `context_*` primitives at **undeclared, live web applications**.

Instead of clicking through brittle DOM selectors on every task—burning 30–45 seconds and ~30,000+ DOM/screenshot tokens per run—`molt` attaches to Chrome over CDP once (or ingests a `.har`), distills live `fetch` / `XHR` / `GraphQL` wire traffic via **chronological value provenance**, locks session cookies and anti-CSRF tokens inside an **RFC 6454 origin-bound encrypted vault**, and **evaporates the browser**.

Runs `#2` through `#10,000` execute headless-free at wire speed (`~3–6ms` locally) through `context_compose` and `context_run`. Only if an upstream origin returns `401`/`403` or drifts structurally (`404`/`410`/`422` or moved JSON paths) does `molt` wake headless Chrome for ~1.4 seconds, refresh the vault + re-learn the mutated contract, and drop straight back to wire speed.

---

## Live Benchmark (`npm run demo`)

Measured against a live undocumented SPA (`demo/saas-dashboard.ts`) using HttpOnly session cookies, rotating `X-CSRF-Token` headers, 9 interleaved telemetry/static noise frames, a 3-hop `email → id.customer → id.order + id.invoice → id.receipt` workflow, forced `401` session expiry, and live `/api/v1/* → /api/v2/commerce/*` structural contract drift:

| Execution Mode | Latency (Local) | Prompt Surface / Run | Browser Open? |
| :--- | :--- | :--- | :--- |
| **DOM Browser Loop** (Playwright / DevTools MCP per task) | `2,266 ms` (~38s w/ LLM turns) | `~27,250` DOM tokens + tool bloat | Every run |
| **`molt` Run #1** (Live CDP Capture + Distillation) | `~1,500 ms` (one-time) | **13 invariant `context_*` tools** ($O(1)$) | Once, then closed |
| **`molt` Runs #2..N** (`context_compose` / `goal:*`) | **`3.5 – 5.8 ms` (~390x faster)** | **`~110` tokens (-99.6%)** | **Zero** |
| **`molt` Self-Heal** (`401` Expiry or `v1 → v2` Drift) | `~1,390 – 1,500 ms` | Automatic vault refresh / re-learn | ~1.4s, then closed |

Run it yourself (requires Node `>= 22.18` and Chrome/Chromium):

```bash
npm run demo
```

---

## Why Naive HAR-to-OpenAPI Recorders Failed—and How `molt` Solves It

Naive network recorders fail in production for three reasons: hardcoded IDs (`/orders/88412/refund`), telemetry/asset flood, and raw `Cookie` headers leaked into specs and prompts. `molt` solves all three through RightClick X's semantic lattice:

1. **Chronological Value Provenance (`src/distill/provenance.ts`)**
   As wire frames stream by, `molt` classifies every JSON leaf and parameter into RightClick X `SemType`s (`email`, `id.customer`, `id.order`, `id.invoice`, `id.receipt`, `url`, `datetime`, …) and tracks exact value flow chronologically across responses and subsequent requests:
   - Recognizes that `"88412"` in `POST /api/v2/orders/88412/refund` arrived earlier at `.data.orders[0].id` in `GET /api/v2/orders`, lifting `"88412"` to `{order_id}: id.order` while keeping `"v2"` literal.
   - Synthesizes OpenAPI 3.1 `x-rightclick-type` annotations, deep array/object output ports, and explicit OpenAPI `links` (`$response.body#/data/orders/0/id`) so `context_graph` and `context_compose` chain multi-hop workflows deterministically.
   - Marks noisy UI pagination parameters (`limit`, `page`, `offset`, `cursor`) optional while keeping domain identity inputs required.

2. **Two-Stage Semantic Noise Pruning (`src/distill/noise.ts`)**
   - **Stage 1 (Transport & Asset Filter)**: Strips `.js`/`.css`/font/image bundles, HTML document navigations (after harvesting `Set-Cookie` / CSRF metadata), CORS `OPTIONS` preflights, and known analytics/RUM hosts.
   - **Stage 2 (Zero-Semantic-Port Graph Pruner)**: Prunes undocumented `/api/*` fire-and-forget pings (e.g. `POST /api/v2/ui-layout-ping → { ok: true }`) that carry zero provenance edges and expose zero specific semantic ports, while preserving genuine `204` domain mutations such as `DELETE /orders/{order_id}`.

3. **Introspection-Free Live GraphQL Compiler (`src/distill/graphql-compiler.ts`)**
   Production GraphQL servers routinely disable `__schema` introspection (`403 Forbidden`). `molt` compiles observed `POST /graphql` `{ query, variables } → { data }` wire frames directly into `[rightclick:<SemType>]`-annotated GraphQL capabilities—including remapping query variable names (`$targetOrderId`) to field argument names (`orderId`).

4. **Origin-Bound Encrypted Vault & Epistemic Safety (`src/vault/vault.ts`, `src/runtime/molt.ts`)**
   - `Cookie`, `Set-Cookie`, `Authorization`, `X-API-Key`, and anti-CSRF headers (`X-CSRF-Token`, `X-XSRF-Token`) are stripped before OpenAPI/GraphQL synthesis and locked inside `OriginVault` (AES-256-GCM encrypted on disk with `0600` permissions).
   - Strict RFC 6454 origin pinning (`scheme + host + port`): credentials captured on `https://admin.acme.io` are never sent to `https://evil.acme.io`, `http://admin.acme.io`, or another port.
   - Live `2xx` responses transparently rotate `Set-Cookie` and CSRF tokens in-memory without waking a browser.
   - **Write-Safety Guard**: Automatic fallback never replays a multi-step pipeline if an earlier non-`read` mutation step already committed a side effect.

---

## CLI & MCP Server Usage

```bash
# 1. Run the live Headless Chrome + API drift benchmark
node bin/molt.ts demo

# 2. Attach passively to an existing authenticated Chrome tab (--remote-debugging-port=9222)
node bin/molt.ts attach --port 9222 --url billing.internal --duration 10000 --state ./.molt

# 3. Capture a URL or declarative recipe once in Chrome, crystallize, and close Chrome
node bin/molt.ts capture https://admin.internal.io/orders --headed --state ./.molt

# 4. Distill an exported browser HAR 1.2 archive
node bin/molt.ts distill ./session.har --state ./.molt --out-openapi ./openapi.distilled.json

# 5. Inspect values, discover affordances, compose, and run at wire speed
node bin/molt.ts inspect "ross@acme.io"
node bin/molt.ts actions "ross@acme.io" --state ./.molt
node bin/molt.ts compose --state ./.molt --have '{"email":"ross@acme.io"}' --want id.receipt --run
```

### MCP Configuration (13 Invariant `context_*` Tools)

Add `molt` to `.mcp.json` / `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "molt": {
      "command": "node",
      "args": ["/absolute/path/to/molt/bin/molt.ts", "mcp", "--state", "/absolute/path/to/.molt"]
    }
  }
}
```

Regardless of whether `molt` has crystallized 3 endpoints or 3,000 across REST and GraphQL, the model only ever sees RightClick X's **13 constant `context_*` tools** (`context_inspect`, `context_actions`, `context_graph`, `context_explain`, `context_compose`, `context_run`, `context_run_status`, `context_verify_receipts`, `context_learn`, `context_forget`, `context_providers`, `context_status`, `context_watch`).

---

## Programmatic SDK

```ts
import { Molt } from "./src/index.ts";

const molt = await Molt.open({ stateDir: "./.molt" });

// Run #1: Learn wire graph from Chrome over CDP, then immediately close Chrome
await molt.crystallizeFromBrowser({
  origin: "https://billing.internal.io",
  entryUrl: "https://billing.internal.io/admin/refunds",
  steps: [
    { action: "fill", selector: "#customer-email", value: "ross@acme.io" },
    { action: "click", selector: "#lookup-and-refund" },
    { action: "waitForIdle", idleMs: 250 },
  ],
});

// Runs #2..N: Headless-free wire execution (~5ms), self-healing on 401 or contract drift
const result = await molt.compose({
  have: {
    email: { type: "email", value: "elena@globex.dev" },
    reason: { type: "text", value: "duplicate_charge", fixed: true },
  },
  want: "id.receipt",
  publish: "refund-customer-order",
  run: true,
});
```

---

## Verification

```bash
npm run check   # TypeScript strict check + full test suite (provenance, vault, GraphQL, CDP fallback, CLI/MCP)
```
