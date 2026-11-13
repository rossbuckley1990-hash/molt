import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserRecipe, BrowserStep, OriginCookie, WireExchange } from "../types.ts";

const CHROME_CANDIDATES = [
  process.env.MOLT_CHROME_PATH,
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter((p): p is string => Boolean(p));

export function findChromeExecutable(): string | null {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Try next
    }
  }
  return null;
}

interface CdpTargetInfo {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/** Minimal zero-dependency Chrome DevTools Protocol client over Node's native WebSocket. */
export class CdpClient {
  private readonly ws: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly listeners = new Map<string, Set<(params: any) => void>>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const text = typeof ev.data === "string" ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString("utf8");
      let msg: any;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (typeof msg.id === "number") {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) {
          entry.reject(new Error(`CDP ${msg.error.code ?? ""}: ${msg.error.message ?? "unknown error"}`));
        } else {
          entry.resolve(msg.result ?? {});
        }
      } else if (typeof msg.method === "string") {
        const handlers = this.listeners.get(msg.method);
        if (handlers) {
          for (const fn of handlers) fn(msg.params ?? {});
        }
      }
    });

    ws.addEventListener("close", () => {
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error("CDP WebSocket closed"));
      }
      this.pending.clear();
    });
  }

  static async connect(wsUrl: string, timeoutMs = 10_000): Promise<CdpClient> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        reject(new Error(`Timed out connecting to CDP at ${wsUrl}`));
      }, timeoutMs);
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error(`Failed to open CDP WebSocket at ${wsUrl}`));
        },
        { once: true },
      );
    });
    return new CdpClient(ws);
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<T> {
    if (this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`CDP socket not open for ${method}`));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP call timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, handler: (params: any) => void): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // Ignore close errors
    }
  }
}

interface InflightFrame {
  requestId: string;
  startedAt: number;
  wallEpochMs: number;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  resourceType: string;
  status: number;
  responseHeaders: Record<string, string>;
  mimeType: string;
  finished: boolean;
}

function normalizeHeaderMap(raw: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === null) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.map(String).join("\n") : String(v);
  }
  return out;
}

function isTextualMime(mime: string): boolean {
  const m = mime.toLowerCase();
  return (
    m === "" ||
    m.includes("json") ||
    m.includes("graphql") ||
    m.startsWith("text/") ||
    m.includes("xml") ||
    m.includes("form-urlencoded")
  );
}

/**
 * Live CDP Network wire recorder attached to a single page target.
 */
export class CdpWireRecorder {
  private readonly cdp: CdpClient;
  private readonly inflight = new Map<string, InflightFrame>();
  private readonly completed: WireExchange[] = [];
  private readonly bodyReads: Promise<void>[] = [];
  private activeApiCount = 0;
  private seq = 0;

  constructor(cdp: CdpClient) {
    this.cdp = cdp;
  }

  async start(): Promise<void> {
    await this.cdp.send("Page.enable");
    await this.cdp.send("Runtime.enable");
    await this.cdp.send("Network.enable", { maxPostDataSize: 2 * 1024 * 1024 });

    this.cdp.on("Network.requestWillBeSent", (p) => {
      const reqId = String(p.requestId ?? "");
      if (!reqId || !p.request?.url) return;
      const rType = String(p.type ?? "Other");
      if (rType === "Fetch" || rType === "XHR") this.activeApiCount++;

      const existing = this.inflight.get(reqId);
      const reqHeaders = {
        ...(existing?.requestHeaders ?? {}),
        ...normalizeHeaderMap(p.request.headers),
      };
      this.inflight.set(reqId, {
        requestId: reqId,
        startedAt: typeof p.timestamp === "number" ? p.timestamp * 1000 : performance.now(),
        wallEpochMs: Date.now() + this.seq++ * 0.01,
        method: String(p.request.method ?? "GET").toUpperCase(),
        url: String(p.request.url),
        requestHeaders: reqHeaders,
        requestBody: typeof p.request.postData === "string" ? p.request.postData : null,
        resourceType: rType,
        status: existing?.status ?? 0,
        responseHeaders: existing?.responseHeaders ?? {},
        mimeType: existing?.mimeType ?? "",
        finished: false,
      });
    });

    // ExtraInfo carries raw wire Cookie & Authorization headers omitted by requestWillBeSent!
    this.cdp.on("Network.requestWillBeSentExtraInfo", (p) => {
      const reqId = String(p.requestId ?? "");
      if (!reqId) return;
      const extra = normalizeHeaderMap(p.headers);
      const frame = this.inflight.get(reqId);
      if (frame) {
        frame.requestHeaders = { ...frame.requestHeaders, ...extra };
      } else {
        this.inflight.set(reqId, {
          requestId: reqId,
          startedAt: performance.now(),
          wallEpochMs: Date.now() + this.seq++ * 0.01,
          method: "GET",
          url: "",
          requestHeaders: extra,
          requestBody: null,
          resourceType: "Other",
          status: 0,
          responseHeaders: {},
          mimeType: "",
          finished: false,
        });
      }
    });

    this.cdp.on("Network.responseReceived", (p) => {
      const reqId = String(p.requestId ?? "");
      const frame = this.inflight.get(reqId);
      if (!frame || !p.response) return;
      frame.status = Number(p.response.status ?? 0);
      frame.mimeType = String(p.response.mimeType ?? "");
      frame.responseHeaders = {
        ...frame.responseHeaders,
        ...normalizeHeaderMap(p.response.headers),
      };
    });

    this.cdp.on("Network.responseReceivedExtraInfo", (p) => {
      const reqId = String(p.requestId ?? "");
      const frame = this.inflight.get(reqId);
      if (!frame) return;
      const extra = normalizeHeaderMap(p.headers);
      frame.responseHeaders = { ...frame.responseHeaders, ...extra };
    });

    this.cdp.on("Network.loadingFailed", (p) => {
      const reqId = String(p.requestId ?? "");
      const frame = this.inflight.get(reqId);
      if (!frame || frame.finished) return;
      frame.finished = true;
      if (frame.resourceType === "Fetch" || frame.resourceType === "XHR") {
        this.activeApiCount = Math.max(0, this.activeApiCount - 1);
      }
    });

    this.cdp.on("Network.loadingFinished", (p) => {
      const reqId = String(p.requestId ?? "");
      const frame = this.inflight.get(reqId);
      if (!frame || frame.finished || !frame.url) return;
      frame.finished = true;
      if (frame.resourceType === "Fetch" || frame.resourceType === "XHR") {
        this.activeApiCount = Math.max(0, this.activeApiCount - 1);
      }
      const endTs = typeof p.timestamp === "number" ? p.timestamp * 1000 : performance.now();
      const durationMs = Math.max(0, Math.round((endTs - frame.startedAt) * 10) / 10);

      const readTask = (async () => {
        let responseBody: string | null = null;
        if (
          frame.status !== 204 &&
          frame.status !== 304 &&
          isTextualMime(frame.mimeType) &&
          (frame.resourceType === "Fetch" ||
            frame.resourceType === "XHR" ||
            frame.resourceType === "Document" ||
            frame.mimeType.includes("json"))
        ) {
          try {
            const res = await this.cdp.send<{ body?: string; base64Encoded?: boolean }>(
              "Network.getResponseBody",
              { requestId: reqId },
              3000,
            );
            if (typeof res.body === "string") {
              responseBody = res.base64Encoded ? Buffer.from(res.body, "base64").toString("utf8") : res.body;
            }
          } catch {
            // Body may have been evicted for navigated documents
          }
        }
        this.completed.push({
          id: `cdp-${reqId}`,
          startedAt: frame.wallEpochMs,
          durationMs,
          method: frame.method,
          url: frame.url,
          requestHeaders: frame.requestHeaders,
          requestBody: frame.requestBody,
          status: frame.status,
          responseHeaders: frame.responseHeaders,
          responseBody,
          resourceType: frame.resourceType,
        });
      })();

      this.bodyReads.push(readTask);
    });
  }

  async waitForNetworkIdle(idleMs = 250, timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let quietSince = this.activeApiCount === 0 ? Date.now() : 0;
    while (Date.now() < deadline) {
      if (this.activeApiCount === 0) {
        if (quietSince === 0) quietSince = Date.now();
        if (Date.now() - quietSince >= idleMs) break;
      } else {
        quietSince = 0;
      }
      await new Promise((r) => setTimeout(r, 35));
    }
    await Promise.allSettled(this.bodyReads);
  }

  async getOriginCookies(urls: string[]): Promise<OriginCookie[]> {
    try {
      const res = await this.cdp.send<{ cookies?: Array<Record<string, any>> }>("Network.getCookies", { urls });
      return (res.cookies ?? []).map((c) => ({
        name: String(c.name ?? ""),
        value: String(c.value ?? ""),
        ...(c.domain ? { domain: String(c.domain) } : {}),
        ...(c.path ? { path: String(c.path) } : {}),
        ...(typeof c.expires === "number" && c.expires > 0 ? { expiresAt: c.expires * 1000 } : {}),
        ...(typeof c.httpOnly === "boolean" ? { httpOnly: c.httpOnly } : {}),
        ...(typeof c.secure === "boolean" ? { secure: c.secure } : {}),
      }));
    } catch {
      return [];
    }
  }

  async flush(): Promise<WireExchange[]> {
    await Promise.allSettled(this.bodyReads);
    return [...this.completed].sort((a, b) => a.startedAt - b.startedAt);
  }
}

async function evalInPage<T = unknown>(cdp: CdpClient, expression: string): Promise<T> {
  const res = await cdp.send<{ result?: { value?: T }; exceptionDetails?: { text?: string } }>("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    throw new Error(`Page evaluation error: ${res.exceptionDetails.text ?? "unknown"}`);
  }
  return res.result?.value as T;
}

async function waitForSelectorInPage(cdp: CdpClient, selector: string, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const selJson = JSON.stringify(selector);
  while (Date.now() < deadline) {
    const found = await evalInPage<boolean>(cdp, `Boolean(document.querySelector(${selJson}))`);
    if (found) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for selector: ${selector}`);
}

export async function runBrowserStep(cdp: CdpClient, recorder: CdpWireRecorder, step: BrowserStep): Promise<void> {
  switch (step.action) {
    case "goto": {
      await cdp.send("Page.navigate", { url: step.url });
      await recorder.waitForNetworkIdle(200, 8000);
      break;
    }
    case "waitForSelector": {
      await waitForSelectorInPage(cdp, step.selector, step.timeoutMs ?? 6000);
      break;
    }
    case "click": {
      await waitForSelectorInPage(cdp, step.selector, step.timeoutMs ?? 6000);
      const selJson = JSON.stringify(step.selector);
      await evalInPage(
        cdp,
        `(() => {
          const el = document.querySelector(${selJson});
          if (!el) throw new Error("Missing element: " + ${selJson});
          el.scrollIntoView({ block: "center" });
          el.click();
          return true;
        })()`,
      );
      await recorder.waitForNetworkIdle(180, 6000);
      break;
    }
    case "fill": {
      await waitForSelectorInPage(cdp, step.selector, step.timeoutMs ?? 6000);
      const selJson = JSON.stringify(step.selector);
      const valJson = JSON.stringify(step.value);
      // React 18/19 controlled-input compatible native prototype value setter + input/change events!
      await evalInPage(
        cdp,
        `(() => {
          const el = document.querySelector(${selJson});
          if (!el) throw new Error("Missing input: " + ${selJson});
          el.focus();
          const proto = el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : el instanceof HTMLSelectElement
              ? HTMLSelectElement.prototype
              : HTMLInputElement.prototype;
          const desc = Object.getOwnPropertyDescriptor(proto, "value");
          if (desc && desc.set) desc.set.call(el, ${valJson});
          else el.value = ${valJson};
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        })()`,
      );
      break;
    }
    case "waitForIdle": {
      await recorder.waitForNetworkIdle(step.idleMs ?? 250, step.timeoutMs ?? 8000);
      break;
    }
    case "evaluate": {
      await evalInPage(cdp, step.expression);
      break;
    }
  }
}

export interface EphemeralCaptureResult {
  exchanges: WireExchange[];
  cookies: OriginCookie[];
  durationMs: number;
  domSnapshotChars: number;
  pageTitle: string;
}

/**
 * Launch an isolated Chrome instance over raw CDP, execute a BrowserRecipe,
 * capture all wire exchanges + cookies, and immediately kill & clean up Chrome ("self-evaporating").
 */
export async function captureWithEphemeralChrome(recipe: BrowserRecipe): Promise<EphemeralCaptureResult> {
  const chromeBin = findChromeExecutable();
  if (!chromeBin) {
    throw new Error(
      "No Chromium/Chrome executable found. Install Google Chrome or set MOLT_CHROME_PATH.",
    );
  }

  const t0 = performance.now();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "molt-chrome-"));
  const args = [
    ...(recipe.headless !== false ? ["--headless=new"] : []),
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-client-side-phishing-detection",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-popup-blocking",
    "--disable-sync",
    "--metrics-recording-only",
    "--password-store=basic",
    "--use-mock-keychain",
    "about:blank",
  ];

  let proc: ChildProcess | undefined;
  let cdp: CdpClient | undefined;

  try {
    proc = spawn(chromeBin, args, { stdio: ["ignore", "ignore", "pipe"] });
    const browserWsUrl = await new Promise<string>((resolve, reject) => {
      let stderr = "";
      const timer = setTimeout(() => reject(new Error(`Timed out starting Chrome: ${stderr.slice(-300)}`)), 12_000);
      proc!.stderr!.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        const m = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]!);
        }
      });
      proc!.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Chrome exited prematurely with code ${code}: ${stderr.slice(-300)}`));
      });
    });

    const portMatch = /^ws:\/\/127\.0\.0\.1:(\d+)\//.exec(browserWsUrl) ?? /^ws:\/\/localhost:(\d+)\//.exec(browserWsUrl);
    if (!portMatch) throw new Error(`Could not parse debugging port from ${browserWsUrl}`);
    const debugPort = Number(portMatch[1]);

    // Find initial page target
    let pageWsUrl: string | undefined;
    for (let attempt = 0; attempt < 25; attempt++) {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const targets = (await res.json()) as CdpTargetInfo[];
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) {
        pageWsUrl = page.webSocketDebuggerUrl;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!pageWsUrl) throw new Error("Chrome started but exposed no debuggable page target");

    cdp = await CdpClient.connect(pageWsUrl);
    const recorder = new CdpWireRecorder(cdp);
    await recorder.start();

    await runBrowserStep(cdp, recorder, { action: "goto", url: recipe.entryUrl });
    for (const step of recipe.steps ?? []) {
      await runBrowserStep(cdp, recorder, step);
    }
    await recorder.waitForNetworkIdle(recipe.settleMs ?? 220, 6000);

    const meta = await evalInPage<{ title: string; domChars: number }>(
      cdp,
      `({ title: document.title || "", domChars: document.documentElement ? document.documentElement.outerHTML.length : 0 })`,
    );
    const cookies = await recorder.getOriginCookies([recipe.origin, recipe.entryUrl]);
    const exchanges = await recorder.flush();

    return {
      exchanges,
      cookies,
      durationMs: Math.round((performance.now() - t0) * 10) / 10,
      domSnapshotChars: meta?.domChars ?? 0,
      pageTitle: meta?.title ?? "",
    };
  } finally {
    cdp?.close();
    if (proc && proc.exitCode === null) {
      proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
          try {
            proc?.kill("SIGKILL");
          } catch {}
          resolve();
        }, 1500);
        proc!.once("exit", () => {
          clearTimeout(killTimer);
          resolve();
        });
      });
    }
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {
      // Ignore temp cleanup race
    }
  }
}

/**
 * Attach passively to an ALREADY open, authenticated Chrome tab on `http://127.0.0.1:<port>`,
 * stream wire frames for `durationMs`, read existing cookies via Network.getCookies,
 * and detach cleanly without closing the user's browser tab!
 */
export async function attachToExistingChromeTab(opts: {
  port?: number;
  urlIncludes?: string;
  durationMs?: number;
  steps?: BrowserStep[];
}): Promise<{
  targetTitle: string;
  targetUrl: string;
  origin: string;
  exchanges: WireExchange[];
  cookies: OriginCookie[];
}> {
  const port = opts.port ?? 9222;
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!res.ok) {
    throw new Error(`Failed to query Chrome DevTools at http://127.0.0.1:${port}/json/list (HTTP ${res.status})`);
  }
  const targets = (await res.json()) as CdpTargetInfo[];
  const pages = targets.filter(
    (t) => t.type === "page" && t.webSocketDebuggerUrl && /^https?:\/\//i.test(t.url),
  );
  const chosen = opts.urlIncludes
    ? pages.find((t) => t.url.includes(opts.urlIncludes!))
    : pages[0];

  if (!chosen?.webSocketDebuggerUrl) {
    throw new Error(
      opts.urlIncludes
        ? `No open HTTP(S) Chrome tab matching "${opts.urlIncludes}" on port ${port}`
        : `No open HTTP(S) Chrome tab found on port ${port}`,
    );
  }

  const origin = new URL(chosen.url).origin;
  const cdp = await CdpClient.connect(chosen.webSocketDebuggerUrl);
  try {
    const recorder = new CdpWireRecorder(cdp);
    await recorder.start();

    if (opts.steps?.length) {
      for (const step of opts.steps) {
        await runBrowserStep(cdp, recorder, step);
      }
      await recorder.waitForNetworkIdle(250, 6000);
    } else {
      await new Promise((r) => setTimeout(r, opts.durationMs ?? 10_000));
    }

    const cookies = await recorder.getOriginCookies([origin, chosen.url]);
    const exchanges = await recorder.flush();
    return {
      targetTitle: chosen.title,
      targetUrl: chosen.url,
      origin,
      exchanges,
      cookies,
    };
  } finally {
    cdp.close();
  }
}
