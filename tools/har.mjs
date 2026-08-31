/**
 * Convert a Chrome DevTools HAR export into the capture format analyze.mjs
 * reads.
 *
 *   node tools/har.mjs ~/Downloads/my.comeen.io.har
 *   node tools/analyze.mjs
 *
 * ─── Why a HAR and not browser automation ────────────────────────────────────
 * The obvious approach — drive Chrome with Playwright and record the traffic —
 * cannot work here, and it is worth writing down so nobody spends an afternoon
 * rediscovering it:
 *
 *   - Playwright can only attach to a Chrome it launched with a debugging port,
 *     and Chrome >= 136 refuses to enable remote debugging on the default
 *     profile. That is deliberate: it is what stops malware attaching to your
 *     everyday browser and lifting its cookies. So the already-signed-in window
 *     is off limits by design.
 *   - A fresh profile sidesteps that, but then Google's risk check refuses the
 *     sign-in ("a device Google doesn't recognize"). A brand-new profile
 *     authenticating a company account from an automated browser is precisely
 *     the pattern that check exists to block, and automating the SSO to get
 *     around it is forbidden anyway.
 *
 * A HAR export inverts the problem: instead of bringing the session to the
 * tooling, it brings a recording of the session out of the browser the user is
 * already signed into. No automation, no second profile, no stored credential.
 *
 * ─── Redaction ───────────────────────────────────────────────────────────────
 * "Export HAR (sanitized)" already strips credential header values, but this
 * re-applies the same redaction on the way in, so an accidental "with sensitive
 * data" export still cannot write a token into .discovery/. If that happens the
 * converter says so loudly, because the source .har on disk is then the
 * problem, not the output.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '.discovery');
const BUNDLE_DIR = join(OUT_DIR, 'bundles');
const REQUESTS_FILE = join(OUT_DIR, 'requests.jsonl');

/** Header values that must never reach disk. Names are kept; values are not. */
const SECRET_HEADERS = /^(authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token)$/;

/** Chrome's own sanitizer leaves these markers behind. */
const ALREADY_REDACTED = /^\[redacted\]$/i;

// A floor's desk list is ~100 kB of JSON. Truncating it would cut off the very
// records the desk lookup has to be checked against, so the cap is generous.
const MAX_BODY = 400_000;

/** HAR headers are a list of {name, value}; everything downstream wants a map. */
function toRedactedMap(headerList) {
    const out = {};
    let leaked = 0;
    for (const { name, value } of headerList ?? []) {
        const key = String(name).toLowerCase();
        if (!SECRET_HEADERS.test(key)) {
            out[key] = value;
            continue;
        }
        if (!ALREADY_REDACTED.test(String(value ?? '').trim()) && value) leaked += 1;
        out[key] = `[REDACTED ${String(value ?? '').length} chars]`;
    }
    return { headers: out, leaked };
}

function isComeen(url) {
    try {
        return new URL(url).hostname.endsWith('comeen.io');
    } catch {
        return false;
    }
}

function looksLikeScript(url, mimeType) {
    return /javascript|ecmascript/.test(mimeType ?? '') || /\.m?js(\?|$)/.test(url);
}

/**
 * A HAR entry's body may be base64 (Chrome does this for anything it considers
 * binary, which sometimes includes gzipped JSON).
 */
function decodeContent(content) {
    if (!content || typeof content.text !== 'string') return null;
    if (content.encoding === 'base64') {
        try {
            return Buffer.from(content.text, 'base64').toString('utf8');
        } catch {
            return null;
        }
    }
    return content.text;
}

/**
 * DevTools does not write _resourceType on every entry, so fall back to the
 * MIME type. analyze.mjs uses this to tell data calls from page furniture.
 */
function resourceTypeOf(entry, mimeType) {
    if (entry._resourceType) return entry._resourceType;
    if (/javascript|ecmascript/.test(mimeType)) return 'script';
    if (/css/.test(mimeType)) return 'stylesheet';
    if (/image|font/.test(mimeType)) return 'image';
    if (/json/.test(mimeType)) return 'xhr';
    return 'other';
}

function main() {
    const harPath = process.argv[2];
    if (!harPath) {
        console.error('Usage: node tools/har.mjs <path-to.har>');
        process.exit(1);
    }
    if (!existsSync(harPath)) {
        console.error(`No such file: ${harPath}`);
        process.exit(1);
    }

    const har = JSON.parse(readFileSync(harPath, 'utf8'));
    const entries = har?.log?.entries;
    if (!Array.isArray(entries)) {
        console.error('That does not look like a HAR file (no log.entries array).');
        process.exit(1);
    }

    mkdirSync(BUNDLE_DIR, { recursive: true });
    const lines = [];

    let skippedForeign = 0;
    let bundles = 0;
    let withBody = 0;
    let leakedHeaders = 0;

    for (const entry of entries) {
        const url = entry?.request?.url ?? '';
        if (!isComeen(url)) {
            skippedForeign += 1;
            continue;
        }

        const mimeType = entry.response?.content?.mimeType ?? '';
        const request = toRedactedMap(entry.request?.headers);
        const response = toRedactedMap(entry.response?.headers);
        leakedHeaders += request.leaked + response.leaked;

        const record = {
            at: entry.startedDateTime ?? null,
            method: entry.request?.method ?? 'GET',
            url,
            status: entry.response?.status ?? 0,
            resourceType: resourceTypeOf(entry, mimeType),
            contentType: mimeType,
            requestHeaders: request.headers,
            responseHeaders: response.headers,
            requestBody: entry.request?.postData?.text ?? null,
            responseBody: null,
            bundleFile: null,
        };

        const body = decodeContent(entry.response?.content);

        if (body && looksLikeScript(url, mimeType)) {
            // Named by content hash so a reload does not multiply the corpus.
            const name = `${createHash('sha1').update(body).digest('hex').slice(0, 12)}.js`;
            writeFileSync(join(BUNDLE_DIR, name), body);
            record.bundleFile = name;
            bundles += 1;
        } else if (body) {
            record.responseBody = body.slice(0, MAX_BODY);
            withBody += 1;
        }

        lines.push(JSON.stringify(record));
    }

    writeFileSync(REQUESTS_FILE, lines.length ? `${lines.join('\n')}\n` : '');

    console.log(`Converted ${lines.length} comeen.io entr(ies) → ${REQUESTS_FILE}`);
    console.log(`  ${withBody} with a response body, ${bundles} script(s) saved for grepping`);
    if (skippedForeign > 0) console.log(`  ${skippedForeign} non-comeen.io entr(ies) ignored`);

    if (lines.length === 0) {
        console.log('\nNothing from comeen.io in that HAR. Was the Network panel recording');
        console.log('on the Comeen tab while you booked?');
    }

    // Response bodies are the difference between "I know the path" and "I know
    // the field names", so a body-less HAR needs saying before anyone tries to
    // read a contract out of it.
    if (lines.length > 0 && withBody === 0) {
        console.log('\nNo response bodies in this HAR. The paths are usable but the field');
        console.log('names are not — listDateFields and the desk id field cannot be read.');
        console.log('Re-export with response content included, or copy the two or three');
        console.log('relevant responses out of the Network panel by hand.');
    }

    if (leakedHeaders > 0) {
        console.log(`\n⚠  ${leakedHeaders} credential header(s) arrived UNREDACTED.`);
        console.log('   That means this was an "Export HAR (with sensitive data)". The');
        console.log('   output in .discovery/ is redacted, but the source file is not:');
        console.log(`     rm ${harPath}`);
        console.log('   and re-export with "Export HAR (sanitized)" next time.');
    }
}

main();
