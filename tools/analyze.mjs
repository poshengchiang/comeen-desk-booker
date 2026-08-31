/**
 * Turn a discover.mjs capture into the five answers config.ts needs:
 * apiBase, auth.mode, resolve, list and create.
 *
 *   node tools/analyze.mjs            everything
 *   node tools/analyze.mjs bundles    only the offline bundle grep
 *
 * Reads .discovery/ and prints. It writes nothing and decides nothing — the
 * endpoint block is edited by hand, because picking the right candidate out of
 * a capture is a judgement call and a wrong guess here fails confusingly at
 * runtime rather than loudly at build time.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '.discovery');
const BUNDLE_DIR = join(OUT_DIR, 'bundles');
const REQUESTS_FILE = join(OUT_DIR, 'requests.jsonl');

const BOOKING_WORDS = /desk|booking|resource|presence|reservation|seat|space|floor/i;

function loadRequests() {
    if (!existsSync(REQUESTS_FILE)) {
        console.error(`No capture at ${REQUESTS_FILE}. Run: node tools/discover.mjs`);
        process.exit(1);
    }
    return readFileSync(REQUESTS_FILE, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
}

/** Data calls only. Documents, scripts, images and fonts are noise here. */
function isApiCall(record) {
    if (record.bundleFile) return false;
    if (['image', 'font', 'stylesheet', 'media'].includes(record.resourceType)) return false;
    return /json/.test(record.contentType) || ['xhr', 'fetch'].includes(record.resourceType);
}

function section(title) {
    console.log(`\n${'─'.repeat(78)}\n${title}\n${'─'.repeat(78)}`);
}

/**
 * apiBase is whichever host the SPA actually talks JSON to — not necessarily
 * the one whose docs are public. Ranking by call volume makes that obvious.
 */
function reportHosts(apiCalls) {
    section('1. apiBase candidates — hosts the app talks JSON to');
    const hosts = new Map();
    for (const record of apiCalls) {
        const { hostname } = new URL(record.url);
        hosts.set(hostname, (hosts.get(hostname) ?? 0) + 1);
    }
    if (hosts.size === 0) {
        console.log('  (none — was the capture taken while signed in?)');
        return;
    }
    for (const [host, count] of [...hosts].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(count).padStart(4)}  https://${host}`);
    }

    // A shared leading path segment is the rest of apiBase, e.g. /api/v1.
    section('1b. Shared path prefixes per host');
    const prefixes = new Map();
    for (const record of apiCalls) {
        const url = new URL(record.url);
        const parts = url.pathname.split('/').filter(Boolean).slice(0, 2);
        for (let depth = 1; depth <= parts.length; depth += 1) {
            const key = `${url.hostname}/${parts.slice(0, depth).join('/')}`;
            prefixes.set(key, (prefixes.get(key) ?? 0) + 1);
        }
    }
    for (const [prefix, count] of [...prefixes].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
        console.log(`  ${String(count).padStart(4)}  ${prefix}`);
    }
}

/**
 * Cookie or header? The extension's in-page code has to pick one, and the
 * capture answers it directly: an Authorization header either rides along or
 * it does not.
 */
function reportAuth(apiCalls) {
    section('2. auth.mode — how API calls carry the credential');
    let withHeader = 0;
    let withCookie = 0;
    const headerNames = new Set();

    for (const record of apiCalls) {
        const names = Object.keys(record.requestHeaders ?? {});
        const authNames = names.filter((n) => /authorization|x-api-key|x-auth-token|token/.test(n));
        if (authNames.length > 0) {
            withHeader += 1;
            authNames.forEach((n) => headerNames.add(n));
        }
        if (names.includes('cookie')) withCookie += 1;
    }

    console.log(`  API calls carrying an auth header: ${withHeader}`);
    console.log(`  API calls carrying a cookie:       ${withCookie}`);
    if (headerNames.size > 0) console.log(`  Header names seen: ${[...headerNames].join(', ')}`);

    if (withHeader > 0) {
        console.log('\n  → auth.mode is very likely "localStorage" (or whichever store the SPA');
        console.log('    keeps that token in). Find the token source with, in the page console:');
        console.log('      Object.keys(localStorage)');
        console.log('    then set storageKey + jsonPath in AuthConfig.');
    } else if (withCookie > 0) {
        console.log('\n  → auth.mode "cookie" is correct. credentials:"include" is enough.');
    } else {
        console.log('\n  → Inconclusive. No API calls captured with either.');
    }
}

/**
 * The write is the whole point: whatever POST/PUT landed when a desk was
 * booked by hand is, verbatim, the `create` template.
 */
function reportWrites(apiCalls) {
    section('3. create — every write the app made');
    const writes = apiCalls.filter((record) => record.method !== 'GET' && record.method !== 'OPTIONS');
    if (writes.length === 0) {
        console.log('  (none captured — book a day by hand while discover.mjs is recording)');
        return;
    }
    for (const record of writes) {
        const url = new URL(record.url);
        console.log(`\n  ${record.method} ${record.status}  ${url.hostname}${url.pathname}`);
        if (url.search) console.log(`    query:    ${url.search}`);
        if (record.requestBody) console.log(`    request:  ${record.requestBody.slice(0, 1200)}`);
        if (record.responseBody) console.log(`    response: ${record.responseBody.slice(0, 800)}`);
    }
}

/**
 * `list` and `resolve` are both reads, so they are separated from the rest of
 * the GET traffic by nothing but their subject matter.
 */
function reportReads(apiCalls) {
    section('4. list / resolve — booking-related reads');
    const reads = apiCalls.filter((record) => record.method === 'GET' && BOOKING_WORDS.test(record.url));
    if (reads.length === 0) {
        console.log('  (none — check section 5 for every GET, the naming may not match)');
        return;
    }
    const seen = new Set();
    for (const record of reads) {
        const url = new URL(record.url);
        const key = `${url.hostname}${url.pathname}`;
        if (seen.has(key)) continue;
        seen.add(key);
        console.log(`\n  GET ${record.status}  ${key}`);
        if (url.search) {
            for (const [name, value] of url.searchParams) console.log(`    ?${name} = ${value}`);
        }
        if (record.responseBody) console.log(`    response: ${record.responseBody.slice(0, 1000)}`);
    }
}

function reportAllReads(apiCalls) {
    section('5. every other API read (deduped)');
    const seen = new Set();
    for (const record of apiCalls) {
        if (record.method !== 'GET') continue;
        const url = new URL(record.url);
        const key = `${url.hostname}${url.pathname}`;
        if (seen.has(key) || BOOKING_WORDS.test(record.url)) continue;
        seen.add(key);
        console.log(`  ${String(record.status).padStart(3)}  ${key}`);
    }
}

/**
 * Grepping the signed-in bundle can hand over the endpoints without a single
 * booking being created, which is why discover.mjs saves every script it sees.
 */
function reportBundles() {
    section('6. bundle grep — path literals mentioning booking concepts');
    if (!existsSync(BUNDLE_DIR)) {
        console.log('  (no bundles captured)');
        return;
    }
    const files = readdirSync(BUNDLE_DIR).filter((name) => name.endsWith('.js'));
    console.log(`  ${files.length} script(s) in ${BUNDLE_DIR}\n`);

    const hits = new Map();
    // Path-shaped literals: a leading slash, then path-safe characters, and
    // permissive about ${…} and :param so templated routes still match.
    const PATH_LITERAL = /["'`](\/[A-Za-z0-9_\-/.${}:]{3,80})["'`]/g;

    for (const name of files) {
        const source = readFileSync(join(BUNDLE_DIR, name), 'utf8');
        for (const [, path] of source.matchAll(PATH_LITERAL)) {
            if (!BOOKING_WORDS.test(path)) continue;
            hits.set(path, (hits.get(path) ?? 0) + 1);
        }
    }

    if (hits.size === 0) {
        console.log('  (no matching path literals — the bundle may be split or lazily loaded;');
        console.log('   browse the floor plan with discover.mjs running so its chunk loads)');
        return;
    }
    for (const [path, count] of [...hits].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(count).padStart(3)}×  ${path}`);
    }
}

const mode = process.argv[2];
if (mode === 'bundles') {
    reportBundles();
} else {
    const apiCalls = loadRequests().filter(isApiCall);
    console.log(`Loaded ${apiCalls.length} API call(s) from ${REQUESTS_FILE}`);
    reportHosts(apiCalls);
    reportAuth(apiCalls);
    reportWrites(apiCalls);
    reportReads(apiCalls);
    reportAllReads(apiCalls);
    reportBundles();
}
