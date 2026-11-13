import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Authority } from "../../vendor/rightclick-x/src/index.ts";
import type { OriginCookie, OriginVaultSummary, WireExchange } from "../types.ts";

const VAULT_HEADER_RE =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-csrf-token|x-xsrf-token|csrf-token|xsrf-token|x-csrftoken|anti-csrf-token|x-api-key|api-key|apikey|x-auth-token|x-access-token|x-session-token|x-session-id|x-amz-security-token)$/i;

const SENSITIVE_SUBSTRING_RE =
  /csrf|xsrf|cookie|bearer|passw(or)?d|passphrase|secret|credential|private[-_]?key|api[-_]?key|apikey|auth[-_]?token|access[-_]?token|session[-_]?(id|key|token)/i;

const CSRF_HEADER_RE = /csrf|xsrf/i;

/** Transport/browser plumbing headers that are neither LLM ports nor credentials. */
const TRANSPORT_PLUMBING_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "connection",
  "content-length",
  "content-type",
  "dnt",
  "host",
  "if-modified-since",
  "if-none-match",
  "keep-alive",
  "origin",
  "pragma",
  "priority",
  "referer",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "sec-fetch-user",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "upgrade-insecure-requests",
  "user-agent",
  "x-requested-with",
]);

export function isVaultedHeaderName(name: string): boolean {
  const trimmed = name.trim().toLowerCase();
  if (trimmed.startsWith(":")) return false;
  return VAULT_HEADER_RE.test(trimmed) || SENSITIVE_SUBSTRING_RE.test(trimmed);
}

export function isPlumbingHeaderName(name: string): boolean {
  const trimmed = name.trim().toLowerCase();
  if (trimmed.startsWith(":") || trimmed.startsWith("sec-") || trimmed.startsWith("cf-")) return true;
  return TRANSPORT_PLUMBING_HEADERS.has(trimmed);
}

interface OriginEntry {
  origin: string;
  headers: Record<string, string>;
  cookies: Record<string, OriginCookie>;
  updatedAt: string;
}

interface EncryptedVaultEnvelope {
  format: "molt-vault-v1";
  kdf: "scrypt";
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

function canonicalOrigin(originOrUrl: string): string {
  const u = new URL(originOrUrl);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`OriginVault refuses non-HTTP(S) origin: ${u.protocol}`);
  }
  return u.origin;
}

function parseCookieHeader(raw: string): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (name) out.push({ name, value });
  }
  return out;
}

/**
 * Split multi-line or comma-joined Set-Cookie headers without breaking Expires=Wed, 21 Oct...
 */
export function splitSetCookieHeader(raw: string): string[] {
  const lines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    // Split on commas ONLY when followed by token= (not inside Expires=Wed, ...)
    const parts = line.split(/,(?=\s*[A-Za-z0-9!#$%&'*+.^_`|~-]+=)/);
    for (const p of parts) {
      const t = p.trim();
      if (t) lines.push(t);
    }
  }
  return lines;
}

export function parseSetCookie(rawLine: string): { cookie: OriginCookie; deleted: boolean } | null {
  const segments = rawLine.split(";").map((s) => s.trim()).filter(Boolean);
  if (!segments.length) return null;
  const eq = segments[0].indexOf("=");
  if (eq <= 0) return null;
  const name = segments[0].slice(0, eq).trim();
  const value = segments[0].slice(eq + 1).trim();
  if (!name) return null;

  const cookie: OriginCookie = { name, value };
  let deleted = value === "";
  for (const attr of segments.slice(1)) {
    const aeq = attr.indexOf("=");
    const k = (aeq >= 0 ? attr.slice(0, aeq) : attr).trim().toLowerCase();
    const v = aeq >= 0 ? attr.slice(aeq + 1).trim() : "";
    if (k === "path" && v) cookie.path = v;
    else if (k === "domain" && v) cookie.domain = v.replace(/^\./, "").toLowerCase();
    else if (k === "httponly") cookie.httpOnly = true;
    else if (k === "secure") cookie.secure = true;
    else if (k === "max-age") {
      const sec = Number(v);
      if (Number.isFinite(sec)) {
        if (sec <= 0) deleted = true;
        else cookie.expiresAt = Date.now() + sec * 1000;
      }
    } else if (k === "expires" && v) {
      const ts = Date.parse(v);
      if (Number.isFinite(ts)) {
        if (ts <= Date.now()) deleted = true;
        else if (cookie.expiresAt === undefined) cookie.expiresAt = ts;
      }
    }
  }
  return { cookie, deleted };
}

function computeFingerprint(entry: OriginEntry): string {
  const canonical = JSON.stringify({
    origin: entry.origin,
    headers: Object.entries(entry.headers).sort(([a], [b]) => a.localeCompare(b)),
    cookies: Object.entries(entry.cookies)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, c]) => [k, c.value]),
  });
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * Origin-bound local credential vault.
 *
 * Session cookies, Authorization tokens, API keys, and CSRF headers extracted from
 * browser wire frames live exclusively inside this vault:
 *   1. Strict RFC 6454 origin pinning (never sent across hosts or cross-origin redirects).
 *   2. Zero LLM exposure: specs, capabilities, prompts, and receipts see only SHA-256 fingerprints.
 *   3. Encrypted at rest with AES-256-GCM.
 */
export class OriginVault {
  private readonly entries = new Map<string, OriginEntry>();

  private ensure(originOrUrl: string): OriginEntry {
    const origin = canonicalOrigin(originOrUrl);
    let entry = this.entries.get(origin);
    if (!entry) {
      entry = {
        origin,
        headers: {},
        cookies: {},
        updatedAt: new Date().toISOString(),
      };
      this.entries.set(origin, entry);
    }
    return entry;
  }

  /** Ingest cookies obtained directly from CDP Network.getCookies for an origin. */
  ingestCookies(originOrUrl: string, cookies: OriginCookie[]): void {
    if (!cookies.length) return;
    const origin = canonicalOrigin(originOrUrl);
    const host = new URL(origin).hostname.toLowerCase();
    const isHttps = new URL(origin).protocol === "https:";
    const entry = this.ensure(origin);
    for (const c of cookies) {
      if (!c.name) continue;
      if (c.secure && !isHttps && host !== "localhost" && host !== "127.0.0.1") continue;
      if (c.domain) {
        const cd = c.domain.replace(/^\./, "").toLowerCase();
        if (host !== cd && !host.endsWith(`.${cd}`)) continue;
      }
      if (c.expiresAt !== undefined && c.expiresAt > 0 && c.expiresAt <= Date.now()) continue;
      entry.cookies[c.name] = { ...c };
    }
    entry.updatedAt = new Date().toISOString();
  }

  /** Set explicit origin-bound headers (e.g. Authorization, X-CSRF-Token). */
  setHeaders(originOrUrl: string, headers: Record<string, string>): void {
    const entry = this.ensure(originOrUrl);
    for (const [rawName, value] of Object.entries(headers)) {
      if (!value) continue;
      const name = rawName.trim().toLowerCase();
      if (name === "cookie") {
        for (const c of parseCookieHeader(value)) {
          entry.cookies[c.name] = { name: c.name, value: c.value };
        }
      } else {
        entry.headers[name] = value;
      }
    }
    entry.updatedAt = new Date().toISOString();
  }

  /**
   * Strip and vault credentials/CSRF tokens from a captured browser wire exchange.
   * Also processes Set-Cookie and dynamic CSRF rotations from the response.
   */
  ingestExchange(exchange: WireExchange): void {
    let origin: string;
    try {
      origin = canonicalOrigin(exchange.url);
    } catch {
      return;
    }
    let touched = false;
    const entry = this.entries.get(origin) ?? {
      origin,
      headers: {},
      cookies: {},
      updatedAt: new Date().toISOString(),
    };

    for (const [rawName, value] of Object.entries(exchange.requestHeaders ?? {})) {
      if (!value) continue;
      const name = rawName.trim().toLowerCase();
      if (name === "cookie") {
        for (const c of parseCookieHeader(value)) {
          entry.cookies[c.name] = { name: c.name, value: c.value };
          touched = true;
        }
      } else if (isVaultedHeaderName(name)) {
        entry.headers[name] = value;
        touched = true;
      }
    }

    // Apply Set-Cookie and CSRF response header updates.
    if (this.ingestResponseHeadersInternal(entry, exchange.responseHeaders ?? {}, exchange.responseBody)) {
      touched = true;
    }

    if (touched || this.entries.has(origin)) {
      if (Object.keys(entry.headers).length > 0 || Object.keys(entry.cookies).length > 0) {
        entry.updatedAt = new Date().toISOString();
        this.entries.set(origin, entry);
      }
    }
  }

  /**
   * Update an existing origin's cookies and CSRF tokens from a live wire response
   * (called automatically during headless-free execution so rotating cookies stay valid).
   */
  ingestLiveResponse(url: string, response: Response, parsedJsonBody?: unknown): boolean {
    let origin: string;
    try {
      origin = canonicalOrigin(url);
    } catch {
      return false;
    }
    const entry = this.entries.get(origin);
    if (!entry) return false;

    const before = computeFingerprint(entry);
    const headersObj: Record<string, string> = {};
    response.headers.forEach((v, k) => {
      headersObj[k.toLowerCase()] = v;
    });
    const setCookies =
      typeof (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === "function"
        ? (response.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
        : headersObj["set-cookie"]
          ? splitSetCookieHeader(headersObj["set-cookie"])
          : [];

    for (const rawCookie of setCookies) {
      const parsed = parseSetCookie(rawCookie);
      if (!parsed) continue;
      if (parsed.deleted) delete entry.cookies[parsed.cookie.name];
      else entry.cookies[parsed.cookie.name] = parsed.cookie;
    }

    this.rotateCsrfFromResponse(entry, headersObj, parsedJsonBody);
    const after = computeFingerprint(entry);
    if (before !== after) {
      entry.updatedAt = new Date().toISOString();
      return true;
    }
    return false;
  }

  private ingestResponseHeadersInternal(
    entry: OriginEntry,
    responseHeaders: Record<string, string>,
    responseBody?: string | null,
  ): boolean {
    let changed = false;
    const lowered: Record<string, string> = {};
    for (const [k, v] of Object.entries(responseHeaders)) {
      lowered[k.toLowerCase()] = v;
    }
    if (lowered["set-cookie"]) {
      for (const raw of splitSetCookieHeader(lowered["set-cookie"])) {
        const parsed = parseSetCookie(raw);
        if (!parsed) continue;
        if (parsed.deleted) delete entry.cookies[parsed.cookie.name];
        else entry.cookies[parsed.cookie.name] = parsed.cookie;
        changed = true;
      }
    }
    let parsedBody: unknown;
    if (responseBody && responseBody.trim().startsWith("{")) {
      try {
        parsedBody = JSON.parse(responseBody);
      } catch {
        // Ignore non-JSON bodies
      }
    }
    if (this.rotateCsrfFromResponse(entry, lowered, parsedBody)) {
      changed = true;
    }
    return changed;
  }

  private rotateCsrfFromResponse(
    entry: OriginEntry,
    loweredHeaders: Record<string, string>,
    parsedBody?: unknown,
  ): boolean {
    let changed = false;
    for (const [k, v] of Object.entries(loweredHeaders)) {
      if (CSRF_HEADER_RE.test(k) && v) {
        entry.headers[k] = v;
        changed = true;
      }
    }
    // Synchronize standard XSRF-TOKEN cookie -> x-xsrf-token header if already used or present.
    for (const c of Object.values(entry.cookies)) {
      if (/^xsrf[-_]?token$/i.test(c.name) && entry.headers["x-xsrf-token"] !== undefined) {
        if (entry.headers["x-xsrf-token"] !== decodeURIComponent(c.value)) {
          entry.headers["x-xsrf-token"] = decodeURIComponent(c.value);
          changed = true;
        }
      }
      if (/^csrf[-_]?token$/i.test(c.name) && entry.headers["x-csrf-token"] !== undefined) {
        if (entry.headers["x-csrf-token"] !== decodeURIComponent(c.value)) {
          entry.headers["x-csrf-token"] = decodeURIComponent(c.value);
          changed = true;
        }
      }
    }
    // If response body explicitly carries a rotated csrfToken field AND this origin uses a CSRF header, update it.
    if (parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)) {
      const obj = parsedBody as Record<string, unknown>;
      const bodyToken =
        typeof obj.csrfToken === "string"
          ? obj.csrfToken
          : typeof obj.csrf_token === "string"
            ? obj.csrf_token
            : typeof obj._csrf === "string"
              ? obj._csrf
              : undefined;
      if (bodyToken) {
        const existingCsrfHeader = Object.keys(entry.headers).find((h) => CSRF_HEADER_RE.test(h)) ?? "x-csrf-token";
        if (entry.headers[existingCsrfHeader] !== bodyToken) {
          entry.headers[existingCsrfHeader] = bodyToken;
          changed = true;
        }
      }
    }
    return changed;
  }

  /**
   * Return origin-pinned headers for an exact URL.
   * Never attaches credentials to any other origin.
   */
  headersForUrl(rawUrl: string): Record<string, string> {
    let u: URL;
    try {
      u = new URL(rawUrl);
    } catch {
      return {};
    }
    const entry = this.entries.get(u.origin);
    if (!entry) return {};

    const out: Record<string, string> = { ...entry.headers };
    const now = Date.now();
    const validCookies = Object.values(entry.cookies).filter((c) => {
      if (c.expiresAt !== undefined && c.expiresAt > 0 && c.expiresAt <= now) return false;
      if (c.path && !u.pathname.startsWith(c.path)) return false;
      return true;
    });
    if (validCookies.length > 0) {
      out.cookie = validCookies.map((c) => `${c.name}=${c.value}`).join("; ");
    }
    return out;
  }

  /** Synchronize all origin-pinned headers into RightClick X's Authority registry. */
  syncToAuthority(authority: Authority): void {
    for (const origin of this.entries.keys()) {
      const headers = this.headersForUrl(`${origin}/`);
      if (Object.keys(headers).length > 0) {
        authority.set(origin, headers);
      }
    }
  }

  origins(): string[] {
    return [...this.entries.keys()];
  }

  summary(originOrUrl: string): OriginVaultSummary | null {
    let origin: string;
    try {
      origin = canonicalOrigin(originOrUrl);
    } catch {
      return null;
    }
    const entry = this.entries.get(origin);
    if (!entry) return null;
    const headerNames = Object.keys(entry.headers).sort();
    const cookieNames = Object.keys(entry.cookies).sort();
    return {
      origin,
      headerNames: [...headerNames, ...(cookieNames.length ? ["cookie"] : [])].sort(),
      cookieNames,
      csrfHeaderNames: headerNames.filter((h) => CSRF_HEADER_RE.test(h)),
      fingerprint: computeFingerprint(entry),
      updatedAt: entry.updatedAt,
    };
  }

  summaries(): OriginVaultSummary[] {
    return this.origins()
      .map((o) => this.summary(o))
      .filter((s): s is OriginVaultSummary => s !== null);
  }

  /** Internal only: list secret values >= 6 chars so error scrubbers can redact accidental server echoes. */
  secretValuesForScrubbing(): string[] {
    const out = new Set<string>();
    for (const entry of this.entries.values()) {
      for (const v of Object.values(entry.headers)) {
        if (v.length >= 6) out.add(v);
        const bearer = /^Bearer\s+(.+)$/i.exec(v)?.[1];
        if (bearer && bearer.length >= 6) out.add(bearer);
      }
      for (const c of Object.values(entry.cookies)) {
        if (c.value.length >= 6) out.add(c.value);
      }
    }
    return [...out];
  }

  clearOrigin(originOrUrl: string): void {
    try {
      this.entries.delete(canonicalOrigin(originOrUrl));
    } catch {
      // Ignore invalid URL
    }
  }

  /** Save encrypted vault to disk (AES-256-GCM, 0o600 permissions). */
  saveEncrypted(vaultPath: string, secretPassphrase?: string): void {
    const dir = path.dirname(vaultPath);
    fs.mkdirSync(dir, { recursive: true });
    const pass = secretPassphrase ?? this.loadOrCreateLocalKey(vaultPath);
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = crypto.scryptSync(pass, salt, 32);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const plaintext = Buffer.from(JSON.stringify([...this.entries.values()]), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    const envelope: EncryptedVaultEnvelope = {
      format: "molt-vault-v1",
      kdf: "scrypt",
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    const tmp = `${vaultPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(envelope, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, vaultPath);
  }

  /** Load encrypted vault from disk. */
  loadEncrypted(vaultPath: string, secretPassphrase?: string): void {
    if (!fs.existsSync(vaultPath)) return;
    const raw = JSON.parse(fs.readFileSync(vaultPath, "utf8")) as EncryptedVaultEnvelope;
    if (raw?.format !== "molt-vault-v1") {
      throw new Error(`Unsupported vault format at ${vaultPath}`);
    }
    const pass = secretPassphrase ?? this.loadOrCreateLocalKey(vaultPath);
    const salt = Buffer.from(raw.salt, "base64");
    const iv = Buffer.from(raw.iv, "base64");
    const tag = Buffer.from(raw.tag, "base64");
    const ciphertext = Buffer.from(raw.ciphertext, "base64");
    const key = crypto.scryptSync(pass, salt, 32);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(decrypted) as OriginEntry[];
    this.entries.clear();
    for (const item of parsed) {
      if (item?.origin) this.entries.set(item.origin, item);
    }
  }

  private loadOrCreateLocalKey(vaultPath: string): string {
    const envKey = process.env.MOLT_VAULT_KEY;
    if (envKey && envKey.length >= 16) return envKey;
    const keyFile = `${vaultPath}.key`;
    if (fs.existsSync(keyFile)) {
      return fs.readFileSync(keyFile, "utf8").trim();
    }
    const generated = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(keyFile, generated + "\n", { mode: 0o600 });
    return generated;
  }
}
