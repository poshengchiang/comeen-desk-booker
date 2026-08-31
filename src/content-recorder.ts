/**
 * Learn mode, page side. Runs in the page's own world so it can see the SPA's
 * own fetch/XHR calls.
 *
 * Book a desk by hand with learn mode on, and this records the shape of the
 * request the SPA made, which is what the endpoint config needs. It exists so
 * you never have to read the OpenAPI spec Comeen does not publish.
 *
 * Authorization and Cookie header VALUES are replaced with "[REDACTED]" right
 * here, before the data leaves this function. The point of learn mode is to
 * learn the request shape, not to copy your credential anywhere.
 */

import { CAPTURE_MARKER } from './core/marker.js';

const MAX_TEXT = 2_000;

interface Capture {
    at: string;
    method: string;
    url: string;
    requestHeaders: Record<string, string>;
    requestBody: string | null;
    status: number;
    responseBody: string | null;
}

function isInteresting(url: string): boolean {
    try {
        const u = new URL(url, window.location.href);
        if (u.hostname.endsWith('comeen.io') && u.hostname !== 'my.comeen.io') return true;
        return /\/(api|graphql)\//.test(u.pathname);
    } catch {
        return false;
    }
}

function redact(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [rawKey, value] of Object.entries(headers)) {
        const key = rawKey.toLowerCase();
        out[key] = /^(authorization|cookie|x-api-key|x-auth-token)$/.test(key)
            ? '[REDACTED]'
            : value;
    }
    return out;
}

function report(capture: Capture): void {
    window.postMessage({ [CAPTURE_MARKER]: true, capture }, window.location.origin);
}

function headersToObject(init: HeadersInit | undefined): Record<string, string> {
    if (!init) return {};
    const out: Record<string, string> = {};
    if (init instanceof Headers) {
        init.forEach((v, k) => { out[k] = v; });
    } else if (Array.isArray(init)) {
        for (const [k, v] of init) if (k) out[k] = v ?? '';
    } else {
        Object.assign(out, init);
    }
    return out;
}

// ── fetch ───────────────────────────────────────────────────────────────────
const originalFetch = window.fetch;
window.fetch = async function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

    const res = await originalFetch.call(this, input as RequestInfo, init);

    if (isInteresting(url) && method !== 'OPTIONS') {
        let responseBody: string | null = null;
        try {
            responseBody = (await res.clone().text()).slice(0, MAX_TEXT);
        } catch { /* opaque or already consumed */ }

        report({
            at: new Date().toISOString(),
            method,
            url,
            requestHeaders: redact(headersToObject(init?.headers)),
            requestBody: typeof init?.body === 'string' ? init.body.slice(0, MAX_TEXT) : null,
            status: res.status,
            responseBody,
        });
    }

    return res;
};

// ── XMLHttpRequest ──────────────────────────────────────────────────────────
type XhrMeta = { method: string; url: string; headers: Record<string, string> };
const metaFor = new WeakMap<XMLHttpRequest, XhrMeta>();

const originalOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function patchedOpen(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
) {
    metaFor.set(this, { method: method.toUpperCase(), url: String(url), headers: {} });
    // eslint-disable-next-line prefer-rest-params
    return originalOpen.apply(this, arguments as never);
};

const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;
XMLHttpRequest.prototype.setRequestHeader = function patchedSetHeader(
    this: XMLHttpRequest,
    name: string,
    value: string,
) {
    const meta = metaFor.get(this);
    if (meta) meta.headers[name] = value;
    return originalSetHeader.call(this, name, value);
};

const originalSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.send = function patchedSend(this: XMLHttpRequest, body?: unknown) {
    const meta = metaFor.get(this);
    if (meta && isInteresting(meta.url) && meta.method !== 'OPTIONS') {
        this.addEventListener('loadend', () => {
            report({
                at: new Date().toISOString(),
                method: meta.method,
                url: meta.url,
                requestHeaders: redact(meta.headers),
                requestBody: typeof body === 'string' ? body.slice(0, MAX_TEXT) : null,
                status: this.status,
                responseBody: typeof this.responseText === 'string'
                    ? this.responseText.slice(0, MAX_TEXT)
                    : null,
            });
        });
    }
    return originalSend.call(this, body as Document | XMLHttpRequestBodyInit | null | undefined);
};

console.info('[comeen] learn-mode recorder attached');
