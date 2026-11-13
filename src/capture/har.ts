import fs from "node:fs";
import type { OriginCookie, WireExchange } from "../types.ts";

interface HarHeader {
  name?: string;
  value?: string;
}

interface HarCookie {
  name?: string;
  value?: string;
  path?: string;
  domain?: string;
  expires?: string;
  httpOnly?: boolean;
  secure?: boolean;
}

interface HarEntry {
  startedDateTime?: string;
  time?: number;
  _resourceType?: string;
  request?: {
    method?: string;
    url?: string;
    headers?: HarHeader[];
    cookies?: HarCookie[];
    postData?: {
      mimeType?: string;
      text?: string;
      params?: Array<{ name?: string; value?: string }>;
    };
  };
  response?: {
    status?: number;
    headers?: HarHeader[];
    cookies?: HarCookie[];
    content?: {
      mimeType?: string;
      text?: string;
      encoding?: string;
    };
  };
}

function headersArrayToRecord(headers: HarHeader[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers ?? []) {
    if (!h?.name || h.value === undefined) continue;
    const key = h.name.toLowerCase();
    if (key === "set-cookie" && out[key]) {
      out[key] = `${out[key]}\n${h.value}`;
    } else {
      out[key] = h.value;
    }
  }
  return out;
}

/**
 * Parse a standard HAR 1.2 document (object or JSON string) into chronological WireExchanges
 * and OriginCookies.
 */
export function parseHar(input: string | Record<string, unknown>): {
  exchanges: WireExchange[];
  cookiesByOrigin: Map<string, OriginCookie[]>;
} {
  const doc = (typeof input === "string" ? JSON.parse(input) : input) as { log?: { entries?: HarEntry[] } };
  const entries = doc?.log?.entries;
  if (!Array.isArray(entries)) {
    throw new Error("Invalid HAR file: missing log.entries array");
  }

  const exchanges: WireExchange[] = [];
  const cookiesByOrigin = new Map<string, OriginCookie[]>();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const req = entry.request;
    const res = entry.response;
    if (!req?.url || !req?.method) continue;

    const parsedTs = entry.startedDateTime ? Date.parse(entry.startedDateTime) : NaN;
    const startedAt = Number.isFinite(parsedTs) ? parsedTs + i * 0.001 : 1_700_000_000_000 + i * 10;

    const requestHeaders = headersArrayToRecord(req.headers);
    const responseHeaders = headersArrayToRecord(res?.headers);

    // Preserve structured HAR cookies if the Cookie header was stripped by DevTools export
    try {
      const origin = new URL(req.url).origin;
      const list = cookiesByOrigin.get(origin) ?? [];
      for (const hc of [...(req.cookies ?? []), ...(res?.cookies ?? [])]) {
        if (!hc?.name || hc.value === undefined) continue;
        const exp = hc.expires ? Date.parse(hc.expires) : NaN;
        list.push({
          name: hc.name,
          value: hc.value,
          ...(hc.domain ? { domain: hc.domain } : {}),
          ...(hc.path ? { path: hc.path } : {}),
          ...(Number.isFinite(exp) ? { expiresAt: exp } : {}),
          ...(hc.httpOnly !== undefined ? { httpOnly: hc.httpOnly } : {}),
          ...(hc.secure !== undefined ? { secure: hc.secure } : {}),
        });
      }
      if (list.length > 0) cookiesByOrigin.set(origin, list);
    } catch {
      // Ignore non-HTTP URLs
    }

    let requestBody: string | null = null;
    if (typeof req.postData?.text === "string") {
      requestBody = req.postData.text;
    } else if (Array.isArray(req.postData?.params) && req.postData.params.length > 0) {
      const sp = new URLSearchParams();
      for (const p of req.postData.params) {
        if (p?.name) sp.append(p.name, p.value ?? "");
      }
      requestBody = sp.toString();
    }

    let responseBody: string | null = null;
    if (typeof res?.content?.text === "string") {
      responseBody =
        res.content.encoding === "base64"
          ? Buffer.from(res.content.text, "base64").toString("utf8")
          : res.content.text;
    }

    exchanges.push({
      id: `har-${i + 1}`,
      startedAt,
      durationMs: typeof entry.time === "number" ? entry.time : undefined,
      method: req.method.toUpperCase(),
      url: req.url,
      requestHeaders,
      requestBody,
      status: res?.status ?? 0,
      responseHeaders,
      responseBody,
      resourceType: entry._resourceType,
    });
  }

  return { exchanges, cookiesByOrigin };
}

export function loadHarFile(filePath: string): ReturnType<typeof parseHar> {
  return parseHar(fs.readFileSync(filePath, "utf8"));
}
