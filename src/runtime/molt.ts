import fs from "node:fs";
import path from "node:path";
import {
  Authority,
  RightClick,
  TOOLS,
  dispatch as rcxDispatch,
  type Capability,
  type ComposeResult,
  type FetchLike,
  type Reflection,
  type RunRecord,
  type RuntimeOptions,
} from "../../vendor/rightclick-x/src/index.ts";
import { ANNOTATED_TOOLS } from "../../vendor/rightclick-x/src/interface/tools.ts";
import type { JsonRpc } from "../../vendor/rightclick-x/src/interface/mcp-server.ts";
import { redact, redactText, scrub } from "../../vendor/rightclick-x/src/core/secrets.ts";
import { FileStore, ProcessMemoryStore } from "../../vendor/rightclick-x/src/entry/node-host.ts";
import { attachToExistingChromeTab, captureWithEphemeralChrome, type EphemeralCaptureResult } from "../capture/cdp.ts";
import { loadHarFile, parseHar } from "../capture/har.ts";
import { distillWireExchanges } from "../distill/compiler.ts";
import { OriginVault } from "../vault/vault.ts";
import type {
  BrowserRecipe,
  BrowserStep,
  DistillationReport,
  FallbackEvent,
  OriginCookie,
  WireExchange,
} from "../types.ts";

const SUPPORTED_MCP_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export type BrowserWakeProvider = (recipe: BrowserRecipe) => Promise<{
  exchanges: WireExchange[];
  cookies?: OriginCookie[];
  title?: string;
}>;

export interface MoltOptions {
  /** Directory to persist encrypted OriginVault, RightClick X state, and recipes. Memory-only when omitted. */
  stateDir?: string;
  /** Optional custom underlying HTTP fetch (defaults to globalThis.fetch). */
  fetch?: FetchLike;
  /** Optional custom browser wake function (defaults to live headless Chrome over CDP). */
  wakeBrowser?: BrowserWakeProvider;
  /** Minimum ms between browser fallback wakes per origin (default 3000ms). */
  fallbackCooldownMs?: number;
  /** Passphrase for encrypted vault (defaults to MOLT_VAULT_KEY or local 0600 keyfile). */
  vaultPassphrase?: string;
  /** Additional RightClick X runtime options (authority, network policy, etc.). */
  runtime?: Omit<RuntimeOptions, "fetch" | "auth" | "store">;
}

function originOfCapability(cap: Capability | undefined): string | null {
  if (!cap) return null;
  const inv = cap.invoke;
  try {
    if (inv.kind === "http") {
      return new URL(inv.url.replace(/\{[^}]+\}/g, "x")).origin;
    }
    if (inv.kind === "graphql" || inv.kind === "mcp" || inv.kind === "peer") {
      return new URL(inv.endpoint).origin;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Molt: Browser-to-API Crystallizer built on RightClick X.
 *
 * Freezes the LLM cognitive surface at RightClick X's 13 invariant `context_*` primitives
 * while compiling live browser wire traffic into typed semantic ports, locking session
 * cookies/CSRF inside an encrypted origin-bound vault, and waking headless Chrome only
 * when an origin returns 401/403 or undergoes structural API drift.
 */
export class Molt {
  readonly rc: RightClick;
  readonly vault: OriginVault;
  readonly auth: Authority;
  readonly fallbackHistory: FallbackEvent[] = [];

  private readonly stateDir?: string;
  private readonly vaultPassphrase?: string;
  private readonly baseFetch: FetchLike;
  private readonly wakeBrowser: BrowserWakeProvider;
  private readonly fallbackCooldownMs: number;
  private readonly recipes = new Map<string, BrowserRecipe>();
  private readonly virtualContracts = new Map<string, Record<string, unknown>>();
  private readonly lastWakeAt = new Map<string, number>();
  private readonly activeWakeByOrigin = new Map<string, Promise<FallbackEvent | null>>();

  private constructor(opts: {
    rc: RightClick;
    vault: OriginVault;
    auth: Authority;
    stateDir?: string;
    vaultPassphrase?: string;
    baseFetch: FetchLike;
    wakeBrowser: BrowserWakeProvider;
    fallbackCooldownMs: number;
    recipes: Map<string, BrowserRecipe>;
    virtualContracts: Map<string, Record<string, unknown>>;
  }) {
    this.rc = opts.rc;
    this.vault = opts.vault;
    this.auth = opts.auth;
    this.stateDir = opts.stateDir;
    this.vaultPassphrase = opts.vaultPassphrase;
    this.baseFetch = opts.baseFetch;
    this.wakeBrowser = opts.wakeBrowser;
    this.fallbackCooldownMs = opts.fallbackCooldownMs;
    this.recipes = opts.recipes;
    this.virtualContracts = opts.virtualContracts;
  }

  static async open(opts: MoltOptions = {}): Promise<Molt> {
    const vault = new OriginVault();
    const auth = new Authority();
    const recipes = new Map<string, BrowserRecipe>();
    const virtualContracts = new Map<string, Record<string, unknown>>();

    if (opts.stateDir) {
      fs.mkdirSync(opts.stateDir, { recursive: true });
      const vaultFile = path.join(opts.stateDir, "origin.vault");
      if (fs.existsSync(vaultFile)) {
        vault.loadEncrypted(vaultFile, opts.vaultPassphrase);
      }
      const recipesFile = path.join(opts.stateDir, "recipes.json");
      if (fs.existsSync(recipesFile)) {
        const parsed = JSON.parse(fs.readFileSync(recipesFile, "utf8")) as BrowserRecipe[];
        for (const r of parsed) {
          if (r?.origin) recipes.set(r.origin, r);
        }
      }
      const contractsFile = path.join(opts.stateDir, "contracts.json");
      if (fs.existsSync(contractsFile)) {
        const parsed = JSON.parse(fs.readFileSync(contractsFile, "utf8")) as Record<string, Record<string, unknown>>;
        for (const [k, v] of Object.entries(parsed)) {
          virtualContracts.set(k, v);
        }
      }
    }

    vault.syncToAuthority(auth);

    const baseFetch: FetchLike = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    const wakeBrowser: BrowserWakeProvider =
      opts.wakeBrowser ??
      (async (recipe) => {
        const captured: EphemeralCaptureResult = await captureWithEphemeralChrome(recipe);
        return {
          exchanges: captured.exchanges,
          cookies: captured.cookies,
          title: captured.pageTitle || undefined,
        };
      });

    let moltInstance: Molt | undefined;

    const moltFetch: FetchLike = async (input, init, context) => {
      const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      // 1. Intercept virtual contract URLs (`https://<origin>/__molt__/openapi.json`) locally in 0ms
      const virtualDoc = virtualContracts.get(urlStr);
      if (virtualDoc) {
        return new Response(JSON.stringify(virtualDoc), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      const res = await baseFetch(input, init, context);

      // 2. Keep rotating Set-Cookie / anti-CSRF headers fresh on 2xx responses with zero browser overhead
      if (res.ok && moltInstance) {
        const hasSetCookie = res.headers.has("set-cookie");
        const hasCsrfHeader = [...res.headers.keys()].some((k) => /csrf|xsrf/i.test(k));
        if (hasSetCookie || hasCsrfHeader) {
          let bodyJson: unknown;
          const ct = res.headers.get("content-type") ?? "";
          if (ct.includes("json")) {
            try {
              bodyJson = await res.clone().json();
            } catch {
              // Ignore non-JSON
            }
          }
          if (moltInstance.vault.ingestLiveResponse(urlStr, res, bodyJson)) {
            moltInstance.vault.syncToAuthority(moltInstance.auth);
            moltInstance.persistAuxiliary();
          }
        }
      }

      return res;
    };

    const store = opts.stateDir
      ? new FileStore(path.join(opts.stateDir, "rcx-state.json"))
      : new ProcessMemoryStore();

    const rc = await RightClick.create({
      name: "molt",
      ...opts.runtime,
      fetch: moltFetch,
      auth,
      store,
    });

    moltInstance = new Molt({
      rc,
      vault,
      auth,
      stateDir: opts.stateDir,
      vaultPassphrase: opts.vaultPassphrase,
      baseFetch,
      wakeBrowser,
      fallbackCooldownMs: opts.fallbackCooldownMs ?? 3000,
      recipes,
      virtualContracts,
    });

    return moltInstance;
  }

  /** Register a self-evaporating BrowserRecipe for an origin (used only on 401/403 or structural drift). */
  registerRecipe(recipe: BrowserRecipe): void {
    const origin = new URL(recipe.origin).origin;
    this.recipes.set(origin, { ...recipe, origin });
    this.persistAuxiliary();
  }

  getRecipe(originOrUrl: string): BrowserRecipe | undefined {
    try {
      return this.recipes.get(new URL(originOrUrl).origin);
    } catch {
      return undefined;
    }
  }

  /**
   * Crystallize raw WireExchanges into RightClick X capabilities + OriginVault credentials.
   */
  async crystallizeExchanges(
    exchanges: WireExchange[],
    opts: {
      targetOrigin?: string;
      title?: string;
      cookies?: Map<string, OriginCookie[]> | OriginCookie[];
      recipe?: BrowserRecipe;
      replaceOriginProviders?: boolean;
    } = {},
  ): Promise<DistillationReport[]> {
    if (opts.cookies) {
      if (Array.isArray(opts.cookies) && opts.targetOrigin) {
        this.vault.ingestCookies(opts.targetOrigin, opts.cookies);
      } else if (opts.cookies instanceof Map) {
        for (const [origin, list] of opts.cookies.entries()) {
          this.vault.ingestCookies(origin, list);
        }
      }
    }

    if (opts.recipe) {
      const origin = new URL(opts.recipe.origin).origin;
      this.recipes.set(origin, { ...opts.recipe, origin });
    }

    const reports = distillWireExchanges(exchanges, this.vault, {
      targetOrigin: opts.targetOrigin ? new URL(opts.targetOrigin).origin : undefined,
      title: opts.title,
      virtualContractUrlForOrigin: (origin, protocol, suffix) =>
        protocol === "openapi"
          ? `${origin}/__molt__/openapi.json`
          : `${origin}/__molt__/graphql${suffix ? suffix.replace(/\W+/g, "_") : ""}.json`,
    });

    this.vault.syncToAuthority(this.auth);

    for (const report of reports) {
      if (report.openapi) {
        this.virtualContracts.set(`${report.origin}/__molt__/openapi.json`, report.openapi);
      }
      if (opts.replaceOriginProviders) {
        const newProviderIds = new Set(report.reflections.map((r) => r.provider.id));
        for (const existing of [...this.rc.graph.providers.values()]) {
          if (existing.meta?.moltOrigin === report.origin && !newProviderIds.has(existing.id)) {
            await this.rc.forget(existing.id);
          }
        }
      }
      for (const reflection of report.reflections) {
        await this.rc.learn({ spec: reflection });
      }
    }

    this.persistAuxiliary();
    if (this.stateDir) {
      await this.rc.flush();
    }
    return reports;
  }

  /** Flush any pending RightClick X FileStore snapshots and encrypted OriginVault state to disk. */
  async flush(): Promise<void> {
    this.persistAuxiliary();
    await this.rc.flush();
  }

  /** Crystallize a HAR 1.2 recording (file path or parsed JSON) into RightClick X capabilities. */
  async crystallizeHar(
    harFileOrJson: string | Record<string, unknown>,
    opts: { isFilePath?: boolean; targetOrigin?: string; title?: string; recipe?: BrowserRecipe } = {},
  ): Promise<DistillationReport[]> {
    const parsed =
      typeof harFileOrJson === "string" && (opts.isFilePath ?? (!harFileOrJson.trim().startsWith("{") && fs.existsSync(harFileOrJson)))
        ? loadHarFile(harFileOrJson)
        : parseHar(harFileOrJson);

    return this.crystallizeExchanges(parsed.exchanges, {
      targetOrigin: opts.targetOrigin,
      title: opts.title,
      cookies: parsed.cookiesByOrigin,
      recipe: opts.recipe,
    });
  }

  /**
   * Run #1: Execute a BrowserRecipe once in isolated Chrome over CDP, crystallize the wire graph,
   * evaporate Chrome immediately, and retain the recipe for future self-healing.
   */
  async crystallizeFromBrowser(
    recipe: BrowserRecipe,
    opts: { title?: string } = {},
  ): Promise<{
    reports: DistillationReport[];
    captureDurationMs: number;
    exchangesCaptured: number;
  }> {
    const t0 = performance.now();
    const captured = await this.wakeBrowser(recipe);
    const captureDurationMs = Math.round((performance.now() - t0) * 10) / 10;
    const reports = await this.crystallizeExchanges(captured.exchanges, {
      targetOrigin: recipe.origin,
      title: opts.title ?? captured.title,
      cookies: captured.cookies,
      recipe,
      replaceOriginProviders: true,
    });
    return {
      reports,
      captureDurationMs,
      exchangesCaptured: captured.exchanges.length,
    };
  }

  /**
   * Attach passively to an existing authenticated Chrome tab over CDP (`--remote-debugging-port`),
   * capture live wire frames + cookies, crystallize capabilities, and detach cleanly.
   */
  async crystallizeFromLiveTab(opts: {
    port?: number;
    urlIncludes?: string;
    durationMs?: number;
    steps?: BrowserStep[];
  } = {}): Promise<{
    targetTitle: string;
    targetUrl: string;
    reports: DistillationReport[];
  }> {
    const attached = await attachToExistingChromeTab(opts);
    const reports = await this.crystallizeExchanges(attached.exchanges, {
      targetOrigin: attached.origin,
      title: attached.targetTitle || undefined,
      cookies: attached.cookies,
      recipe: {
        origin: attached.origin,
        entryUrl: attached.targetUrl,
        ...(opts.steps ? { steps: opts.steps } : {}),
      },
    });
    return {
      targetTitle: attached.targetTitle,
      targetUrl: attached.targetUrl,
      reports,
    };
  }

  /**
   * Execute a single capability or saved `goal:<slug>`, waking the browser fallback automatically
   * if a crystallized origin structurally drifted (404/410/422/missing output path).
   */
  async run(
    id: string,
    args: Record<string, unknown> = {},
    opts: Parameters<RightClick["run"]>[2] = {},
  ): Promise<RunRecord> {
    const first = await this.rc.run(id, args, opts);
    if (first.status !== "failed") {
      if (this.stateDir) await this.rc.flush();
      return first;
    }

    const failedId = first.failedCapability ?? first.refusal?.capability ?? id;
    const cap = this.rc.graph.get(failedId) ?? this.rc.graph.get(id);
    const origin = this.findMoltOriginForFailure(cap, first);
    if (!origin || !this.canWakeOrigin(origin) || !this.isDriftOrAuthFailure(first)) {
      if (this.stateDir) await this.rc.flush();
      return first;
    }

    const isAuthGateRefusal = Boolean(first.refusal || first.responseStatus === 401 || first.responseStatus === 403);
    const isSavedGoal = id.startsWith("goal:");
    // An HTTP 401/403 auth refusal rejected the request before domain execution; otherwise only
    // retry when all prior steps were read-only (never double-submit a committed write).
    const safeToRetry =
      isSavedGoal
        ? this.allExecutedStepsBeforeFailureWereReadOnly(first)
        : cap?.risk === "read" || isAuthGateRefusal;

    const event = await this.wakeAndRecrystallize(
      origin,
      isAuthGateRefusal ? "auth-denied" : "contract-drift",
      failedId,
      first.responseStatus ?? (first.refusal ? 401 : undefined),
    );

    if (!event || !safeToRetry) {
      if (this.stateDir) await this.rc.flush();
      return first;
    }

    if (isSavedGoal || this.rc.graph.get(id)) {
      const retried = await this.rc.run(id, args, opts);
      if (this.stateDir) await this.rc.flush();
      return retried;
    }
    if (this.stateDir) await this.rc.flush();
    return first;
  }

  /**
   * Compose and optionally run a multi-step semantic pipeline across crystallized capabilities,
   * automatically waking headless Chrome if an upstream contract drifted structurally.
   */
  async compose(opts: Parameters<RightClick["compose"]>[0]): Promise<ComposeResult> {
    const first = await this.rc.compose(opts);
    if (!opts.run || !first.executed || first.executed.status !== "failed") {
      if (this.stateDir && (opts.publish || opts.run)) await this.rc.flush();
      return first;
    }

    const ex = first.executed;
    const failedId = ex.attempts[ex.attempts.length - 1]?.failed ?? "";
    const cap = failedId ? this.rc.graph.get(failedId) : undefined;
    const lastRunId = ex.runs[ex.runs.length - 1];
    const lastRunRecord = lastRunId ? (this.rc.runStatus({ runId: lastRunId }) as RunRecord | undefined) : undefined;

    const origin =
      (lastRunRecord ? this.findMoltOriginForFailure(cap, lastRunRecord) : null) ??
      originOfCapability(cap) ??
      (opts.origins?.length === 1 ? opts.origins[0]! : this.recipes.size === 1 ? [...this.recipes.keys()][0]! : null);

    const isDrift =
      Boolean(ex.refusal || ex.dataUnavailable || ex.graphqlFailure) ||
      Boolean(lastRunRecord && this.isDriftOrAuthFailure(lastRunRecord)) ||
      (ex.error ? /\bHTTP (400|401|403|404|405|410|422)\b|no value at|does not contain/i.test(ex.error) : false);

    // Check that every completed run before the failed step was read-only
    const priorRunsSafe = ex.runs.every((rid) => {
      const r = this.rc.runStatus({ runId: rid }) as RunRecord | undefined;
      if (!r || r.status === "failed") return true;
      const c = this.rc.graph.get(r.capability);
      return !c || c.risk === "read";
    });

    if (!origin || !this.canWakeOrigin(origin) || !isDrift || !priorRunsSafe) {
      return first;
    }

    const statusBefore = lastRunRecord?.responseStatus;
    const event = await this.wakeAndRecrystallize(
      origin,
      ex.refusal || statusBefore === 401 || statusBefore === 403 ? "auth-denied" : "contract-drift",
      failedId || "compose",
      statusBefore,
    );
    if (!event) {
      if (this.stateDir) await this.rc.flush();
      return first;
    }

    const retried = await this.rc.compose(opts);
    if (this.stateDir) await this.rc.flush();
    return retried;
  }

  /**
   * Dispatch any of the 13 invariant `context_*` tools with Molt's self-evaporating fallback active.
   */
  async dispatch(name: string, a: Record<string, any> = {}): Promise<unknown> {
    if (name === "context_run" || name === "context_compose") {
      const proxyRc = Object.create(this.rc) as RightClick;
      proxyRc.run = (id, args, opts) => this.run(id, args, opts);
      proxyRc.compose = (opts) => this.compose(opts);
      return rcxDispatch(proxyRc, name, a);
    }
    const out = await rcxDispatch(this.rc, name, a);
    if (this.stateDir && (name === "context_learn" || name === "context_forget")) {
      await this.rc.flush();
    }
    return out;
  }

  /**
   * Handle an MCP JSON-RPC request over the exact 13 `context_*` tools.
   * Preserves RightClick X's constant O(1) cognitive surface and strict secret scrubbing.
   */
  async handleMcp(msg: JsonRpc): Promise<JsonRpc | null> {
    const reply = (result: unknown): JsonRpc => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
    const fail = (code: number, message: string): JsonRpc => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
    if (msg.id === undefined || msg.id === null) return null;

    switch (msg.method) {
      case "initialize": {
        const asked = msg.params?.protocolVersion;
        return reply({
          protocolVersion: SUPPORTED_MCP_VERSIONS.includes(asked) ? asked : SUPPORTED_MCP_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "molt", title: "Molt (RightClick X Browser-to-API Crystallizer)", version: "0.1.0" },
          instructions:
            "Molt exposes RightClick X's 13 invariant context_* primitives over crystallized browser APIs. " +
            "Use context_graph or context_actions to inspect typed capabilities, context_explain before consequential runs, " +
            "and context_compose / context_run for headless-free wire execution. Session cookies and CSRF headers stay locked in Molt's origin-bound vault." +
            this.rc.startupSummary(),
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: ANNOTATED_TOOLS });
      case "tools/call": {
        const name = msg.params?.name;
        if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `unknown tool: ${name}`);
        const args = msg.params?.arguments ?? {};
        try {
          const out = await this.dispatch(name, args);
          const secrets = this.vault.secretValuesForScrubbing();
          const serialized = secrets.length ? scrub(JSON.stringify(out), secrets) : JSON.stringify(out);
          const safeOut = secrets.length ? JSON.parse(serialized) : out;
          const structured = safeOut && typeof safeOut === "object" && !Array.isArray(safeOut) ? safeOut : { result: safeOut };
          return reply({
            content: [{ type: "text", text: serialized }],
            structuredContent: redact(structured),
            isError: false,
          });
        } catch (e) {
          const rawErr = String((e as Error)?.message ?? e);
          const safeErr = redactText(scrub(rawErr, this.vault.secretValuesForScrubbing()));
          return reply({ content: [{ type: "text", text: safeErr }], isError: true });
        }
      }
      default:
        return fail(-32601, `method not found: ${msg.method}`);
    }
  }

  canWakeOrigin(origin: string): boolean {
    if (!this.recipes.has(origin)) return false;
    const last = this.lastWakeAt.get(origin);
    if (last !== undefined && Date.now() - last < this.fallbackCooldownMs) return false;
    return true;
  }

  /** Manually or automatically wake the browser recipe for an origin and re-learn its wire contract. */
  async wakeAndRecrystallize(
    origin: string,
    trigger: FallbackEvent["trigger"],
    capabilityId: string,
    statusBefore?: number,
  ): Promise<FallbackEvent | null> {
    const inflight = this.activeWakeByOrigin.get(origin);
    if (inflight) return inflight;

    const recipe = this.recipes.get(origin);
    if (!recipe) return null;

    const work = (async (): Promise<FallbackEvent | null> => {
      this.lastWakeAt.set(origin, Date.now());
      const t0 = performance.now();
      const fpBefore = this.vault.summary(origin)?.fingerprint;
      const capsBefore = this.capabilitiesForOrigin(origin);

      const captured = await this.wakeBrowser(recipe);
      await this.crystallizeExchanges(captured.exchanges, {
        targetOrigin: origin,
        title: captured.title,
        cookies: captured.cookies,
        recipe,
        replaceOriginProviders: true,
      });

      const wakeDurationMs = Math.round((performance.now() - t0) * 10) / 10;
      const fpAfter = this.vault.summary(origin)?.fingerprint;
      const capsAfter = this.capabilitiesForOrigin(origin);
      const vaultChanged = fpBefore !== fpAfter;

      // Forgive transient 401/403/404 ledger penalties on the refreshed origin
      this.rc.ledger.forgive((id) => {
        const c = this.rc.graph.get(id);
        return originOfCapability(c) === origin;
      });

      const added = capsAfter.filter((c) => !capsBefore.includes(c));
      const removed = capsBefore.filter((c) => !capsAfter.includes(c));
      const event: FallbackEvent = {
        at: new Date().toISOString(),
        origin,
        capabilityId,
        trigger,
        ...(statusBefore !== undefined ? { statusBefore } : {}),
        wakeDurationMs,
        vaultChanged,
        ...(fpBefore ? { vaultFingerprintBefore: fpBefore } : {}),
        ...(fpAfter ? { vaultFingerprintAfter: fpAfter } : {}),
        capabilitiesBefore: capsBefore,
        capabilitiesAfter: capsAfter,
        note: `Woke browser for ${origin} (${wakeDurationMs}ms): vault ${vaultChanged ? "refreshed" : "unchanged"}, +${added.length}/-${removed.length} capabilities`,
      };
      this.fallbackHistory.push(event);
      return event;
    })();

    this.activeWakeByOrigin.set(origin, work);
    try {
      return await work;
    } finally {
      this.activeWakeByOrigin.delete(origin);
    }
  }

  private capabilitiesForOrigin(origin: string): string[] {
    return this.rc.graph
      .list()
      .filter((c) => {
        const p = this.rc.graph.providers.get(c.provider);
        return p?.meta?.moltOrigin === origin || originOfCapability(c) === origin;
      })
      .map((c) => c.id)
      .sort();
  }

  private findMoltOriginForFailure(cap: Capability | undefined, rec: RunRecord): string | null {
    if (cap) {
      const p = this.rc.graph.providers.get(cap.provider);
      if (typeof p?.meta?.moltOrigin === "string") return p.meta.moltOrigin;
      const direct = originOfCapability(cap);
      if (direct && this.recipes.has(direct)) return direct;
    }
    if (rec.attempts?.length) {
      for (const att of rec.attempts) {
        const ac = this.rc.graph.get(att.failed);
        if (ac) {
          const p = this.rc.graph.providers.get(ac.provider);
          if (typeof p?.meta?.moltOrigin === "string") return p.meta.moltOrigin;
          const direct = originOfCapability(ac);
          if (direct && this.recipes.has(direct)) return direct;
        }
      }
    }
    if (rec.steps?.length) {
      for (const stepRef of rec.steps) {
        const child = this.rc.runStatus({ runId: stepRef }) as RunRecord | undefined;
        const stepCap = child?.capability ? this.rc.graph.get(child.capability) : this.rc.graph.get(stepRef);
        const o = originOfCapability(stepCap);
        if (o && this.recipes.has(o)) return o;
      }
    }
    if (this.recipes.size === 1) {
      return [...this.recipes.keys()][0]!;
    }
    return null;
  }

  private isDriftOrAuthFailure(rec: RunRecord): boolean {
    if (rec.refusal) return true;
    if (rec.dataUnavailable || rec.graphqlFailure) return true;
    if (rec.responseStatus && [400, 401, 403, 404, 405, 410, 422].includes(rec.responseStatus)) return true;
    const combinedError = [rec.error, ...(rec.attempts ?? []).map((a) => a.error)].filter(Boolean).join("; ");
    if (/\bHTTP (400|401|403|404|405|410|422)\b|authentication or authorization refused|no value at|does not contain|no pipeline found/i.test(combinedError)) {
      return true;
    }
    return false;
  }

  private allExecutedStepsBeforeFailureWereReadOnly(rec: RunRecord): boolean {
    if (!rec.steps?.length) return true;
    for (const stepRef of rec.steps) {
      const child = this.rc.runStatus({ runId: stepRef }) as RunRecord | undefined;
      if (child) {
        if (child.status === "failed") continue;
        const c = this.rc.graph.get(child.capability);
        if (c && c.risk !== "read") return false;
      } else {
        if (stepRef === rec.failedCapability) break;
        const c = this.rc.graph.get(stepRef);
        if (c && c.risk !== "read") return false;
      }
    }
    return true;
  }

  private persistAuxiliary(): void {
    if (!this.stateDir) return;
    fs.mkdirSync(this.stateDir, { recursive: true });
    this.vault.saveEncrypted(path.join(this.stateDir, "origin.vault"), this.vaultPassphrase);
    fs.writeFileSync(
      path.join(this.stateDir, "recipes.json"),
      JSON.stringify([...this.recipes.values()], null, 2) + "\n",
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(this.stateDir, "contracts.json"),
      JSON.stringify(Object.fromEntries(this.virtualContracts), null, 2) + "\n",
      { mode: 0o600 },
    );
  }
}
