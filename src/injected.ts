import type { EndpointConfig } from './core/config.js';

export interface InPageArgs {
    endpoint: EndpointConfig;
    dates: string[];
    /** Human label, e.g. "3-23". Used to resolve the id when one is not cached. */
    deskName: string;
    /** Internal id. Only used when no resolve endpoint is configured. */
    deskId: string;
    slot: string;
    /** Naive local times for the slot, e.g. "00:00:00.000Z". */
    startTime: string;
    endTime: string;
    floorId: number;
    buildingId: number;
    dryRun: boolean;
}

export type InPageStatus = 'booked' | 'skipped' | 'dry-run' | 'unavailable' | 'error';

export interface InPageRow {
    date: string;
    status: InPageStatus;
    detail?: string;
}

export interface InPageResult {
    rows: InPageRow[];
    notes: string[];
    /** Set when the desk id was looked up, so the caller can cache it. */
    resolvedDeskId?: string;
    /**
     * Present on every early return. Never contains a credential — only which
     * page this ran on and which storage keys exist, never their values.
     */
    diagnostics?: Record<string, unknown>;
    /**
     * The session is dead. A structured flag rather than something the caller
     * has to pattern-match out of `notes`, because the background script acts
     * on it: it badges, notifies, and retries when you next visit Comeen.
     */
    signedOut?: boolean;
}

/**
 * Runs inside the Comeen tab, in the page's own JavaScript world.
 *
 * ─── Why it looks like this ──────────────────────────────────────────────────
 * `chrome.scripting.executeScript` serializes this function and re-parses it in
 * the page. It therefore CANNOT reference anything outside its own body: no
 * imports, no module-level helpers, no closures. Every helper is defined inline
 * on purpose. Resist the urge to "clean this up" by hoisting them out.
 *
 * ─── The security property ───────────────────────────────────────────────────
 * The credential is read here, used here, and discarded here. It is never
 * returned to the extension, never written to chrome.storage, and never leaves
 * the tab. The extension holds configuration only. That is the whole reason to
 * prefer this design over a server-side script holding a stored token.
 */
export async function bookInPage(args: InPageArgs): Promise<InPageResult> {
    const { endpoint, dates, deskName, slot, startTime, endTime, dryRun } = args;
    const notes: string[] = [];
    const rows: InPageRow[] = [];
    let deskId = args.deskId;
    let resolvedDeskId: string | undefined;
    let signedOut = false;
    /**
     * Days this desk already looks spoken for, read off the resolved desk's own
     * schedule. Deliberately ADVISORY: it changes what Preview reports, and
     * never whether a real booking is attempted. See the create loop.
     */
    const takenDates = new Set<string>();

    // Whatever we learn along the way ends up here and feeds the create body.
    const vars: Record<string, string> = {
        deskName,
        slot,
        startTime,
        endTime,
        floorId: String(args.floorId),
        buildingId: String(args.buildingId),
        from: dates[0] ?? '',
        to: dates[dates.length - 1] ?? '',
    };

    // Diagnostics for every failure path. Key NAMES only, never values, so this
    // can say "you are signed out" without ever handling a credential.
    const diagnostics = (): Record<string, unknown> => ({
        url: window.location.href,
        localStorageKeys: (() => {
            try { return Object.keys(window.localStorage); } catch { return ['<unreadable>']; }
        })(),
        cookieNames: (() => {
            try {
                return document.cookie.split(';')
                    .map((pair) => pair.split('=')[0]?.trim() ?? '')
                    .filter(Boolean);
            } catch { return ['<unreadable>']; }
        })(),
    });

    // ── inline helpers (see comment above) ──────────────────────────────────

    // Mirrors `substitute` in core/config.ts. A placeholder that is the entire
    // value and resolves to an integer becomes a number, because Comeen's
    // presence block wants building_id: 5151, not "5151". Partial
    // interpolation stays a string, which is what a URL path needs.
    const fill = (value: unknown, source: Record<string, string>): unknown => {
        if (typeof value === 'string') {
            const whole = /^\{\{(\w+)\}\}$/.exec(value);
            if (whole) {
                const replacement = source[whole[1] ?? ''];
                if (replacement === undefined) return value;
                return /^-?\d+$/.test(replacement) ? Number(replacement) : replacement;
            }
            return value.replace(/\{\{(\w+)\}\}/g, (match, key: string) => source[key] ?? match);
        }
        if (Array.isArray(value)) return value.map((entry) => fill(entry, source));
        if (value && typeof value === 'object') {
            const out: Record<string, unknown> = {};
            for (const [key, entry] of Object.entries(value)) out[key] = fill(entry, source);
            return out;
        }
        return value;
    };

    const dig = (obj: unknown, path: string): unknown => path
        .split('.')
        .reduce<unknown>((current, key) => (
            current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined
        ), obj);

    const authHeaders = (): Record<string, string> => {
        if (endpoint.auth.mode !== 'localStorage') return {};
        const { storageKey, jsonPath, header, prefix } = endpoint.auth;
        if (!storageKey || !jsonPath) {
            notes.push('auth.mode is localStorage but storageKey/jsonPath are missing.');
            return {};
        }
        const raw = window.localStorage.getItem(storageKey);
        if (!raw) {
            notes.push(`localStorage key "${storageKey}" not found. Are you signed in?`);
            return {};
        }
        let token: unknown;
        try {
            token = dig(JSON.parse(raw), jsonPath);
        } catch {
            notes.push(`localStorage key "${storageKey}" is not JSON.`);
            return {};
        }
        if (typeof token !== 'string' || !token) {
            notes.push(`No token at path "${jsonPath}".`);
            return {};
        }
        return { [header ?? 'authorization']: `${prefix ?? 'Bearer '}${token}` };
    };

    const call = async (
        tpl: { method: string; path: string; query?: Record<string, string>; body?: unknown },
        source: Record<string, string>,
    ): Promise<{ ok: boolean; status: number; data: unknown; text: string; signedOut: boolean }> => {
        const path = fill(tpl.path, source) as string;
        const url = new URL(`${endpoint.apiBase.replace(/\/$/, '')}${path}`);
        for (const [key, value] of Object.entries(fill(tpl.query ?? {}, source) as Record<string, string>)) {
            url.searchParams.set(key, String(value));
        }
        const body = tpl.body === undefined ? undefined : JSON.stringify(fill(tpl.body, source));

        const res = await window.fetch(url.toString(), {
            method: tpl.method,
            credentials: 'include',
            headers: {
                accept: 'application/json',
                ...(body === undefined ? {} : { 'content-type': 'application/json' }),
                ...authHeaders(),
            },
            body,
        });

        const text = await res.text();
        let data: unknown = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }

        // An expired session does not announce itself with a tidy 401. Comeen
        // redirects to the login page, so the fetch follows it and hands back a
        // 200 full of HTML. Parsed as JSON that becomes null, which downstream
        // reads as "zero results" — hence the old, badly misleading "no desk
        // called 3-23 in 0 search result(s)". Catch it here instead.
        let finalHost = '';
        try { finalHost = new URL(res.url).hostname; } catch { /* stub or opaque */ }
        const looksLikeHtml = /^\s*<(!doctype|html)/i.test(text);
        const signedOut = res.status === 401
            || res.status === 403
            || /(^|\.)accounts\.comeen\.io$/.test(finalHost)
            || (looksLikeHtml && data === null);

        return { ok: res.ok, status: res.status, data, text, signedOut };
    };

    const signedOutResult = (): InPageResult => ({
        rows: [],
        notes: ['Not signed in to Comeen. Open https://my.comeen.io/, sign in, then run again.'],
        diagnostics: diagnostics(),
        signedOut: true,
    });

    const asList = (data: unknown): Record<string, unknown>[] => {
        if (Array.isArray(data)) return data as Record<string, unknown>[];
        if (data && typeof data === 'object') {
            const obj = data as Record<string, unknown>;
            for (const key of ['items', 'data', 'results', 'bookings', 'desks']) {
                if (Array.isArray(obj[key])) return obj[key] as Record<string, unknown>[];
            }
        }
        return [];
    };

    const normalise = (value: unknown): string => String(value ?? '')
        .trim().toLowerCase().replace(/[\s_]+/g, '-');

    // Confirmed against a real contended day: Comeen rejects a desk someone else
    // already holds with 422 and a message, not a clean 409. Reading the message
    // as well as the status is what keeps that reported as "unavailable" rather
    // than as an error that looks like a bug in this extension.
    const looksTaken = (status: number, text: string): boolean => status === 409
        || status === 422
        || /taken|already|unavailable|occupied|full|conflict/i.test(text);

    // ── 1. which desk? ──────────────────────────────────────────────────────
    // Resolving every run rather than trusting a cached id: the lookup also
    // yields the desk's area_id, which the create body needs, and it means a
    // renumbered or moved desk corrects itself instead of booking the wrong seat.
    if (endpoint.resolve) {
        const res = await call(endpoint.resolve, vars);
        if (res.signedOut) return signedOutResult();
        if (!res.ok) {
            return {
                rows: [],
                notes: [`Desk lookup failed (${res.status}): ${res.text.slice(0, 200)}`],
                diagnostics: diagnostics(),
            };
        }

        const candidates = asList(res.data);
        const match = candidates.find((desk) => endpoint.deskNameFields
            .some((field) => normalise(desk[field]) === normalise(deskName)));

        if (!match) {
            return {
                rows: [],
                notes: [
                    `No desk called "${deskName}" in ${candidates.length} search result(s).`,
                    `First few: ${JSON.stringify(candidates.slice(0, 3)).slice(0, 400)}`,
                ],
                diagnostics: diagnostics(),
            };
        }

        const idField = endpoint.deskIdFields.find((field) => match[field] !== undefined
            && match[field] !== null);
        if (!idField) {
            return {
                rows: [],
                notes: [
                    `Found "${deskName}" but none of ${endpoint.deskIdFields.join('/')} held an id.`,
                    `Record: ${JSON.stringify(match).slice(0, 400)}`,
                ],
                diagnostics: diagnostics(),
            };
        }

        deskId = String(match[idField]);
        resolvedDeskId = deskId;
        notes.push(`Resolved "${deskName}" to ${idField} ${deskId}.`);

        // The desk knows which area and floor it is in; prefer that over the
        // configured floor, which is only a starting point for the lookup.
        if (match.area_id !== undefined && match.area_id !== null) vars.areaId = String(match.area_id);
        if (match.floor_id !== undefined && match.floor_id !== null) vars.floorId = String(match.floor_id);

        if (match.available_to_booking === false) {
            notes.push(`⚠ "${deskName}" is marked not available to booking — it may be assigned to someone.`);
        }

        // The desk carries its own bookings for the queried window, which is how
        // Preview can say "someone else has it" instead of cheerfully promising
        // a day that will 422 the moment you press Book now.
        if (endpoint.deskScheduleField) {
            const entries = match[endpoint.deskScheduleField];
            if (Array.isArray(entries)) {
                for (const entry of entries as Record<string, unknown>[]) {
                    if (!entry || typeof entry !== 'object') continue;
                    for (const field of endpoint.deskScheduleDateFields) {
                        const value = entry[field];
                        if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
                            takenDates.add(value.slice(0, 10));
                            break;
                        }
                    }
                }
                if (takenDates.size > 0) {
                    notes.push(`"${deskName}" already has ${takenDates.size} day(s) booked in this window.`);
                }
            }
        }
    }

    if (!deskId) {
        return {
            rows: [],
            notes: ['No desk ID set and no desk-search endpoint configured.'],
            diagnostics: diagnostics(),
        };
    }
    vars.deskId = deskId;

    // ── 2. what do I already have? ──────────────────────────────────────────
    const heldDates = new Set<string>();

    if (endpoint.list) {
        const res = await call(endpoint.list, vars);
        if (res.signedOut) return signedOutResult();
        if (!res.ok) {
            // Not fatal, but it means we lose idempotency, so say so loudly.
            notes.push(
                `Could not list existing bookings (${res.status}). Proceeding without the `
                + `duplicate check, so expect "unavailable" on days you already hold. `
                + `Response: ${res.text.slice(0, 200)}`,
            );
        } else {
            // The signed-in user's own id is in this response, and the create
            // path needs it. Reading it here avoids a second round trip and
            // avoids making the user look their own id up.
            if (endpoint.userIdPath) {
                const userId = dig(res.data, endpoint.userIdPath);
                if (userId !== undefined && userId !== null) vars.userId = String(userId);
                else notes.push(`No user id at "${endpoint.userIdPath}" in the list response.`);
            }

            const container = endpoint.listRoot ? dig(res.data, endpoint.listRoot) : res.data;

            if (endpoint.listShape === 'dateKeyedMap') {
                // { "2026-09-01": [entry], "2026-09-02": [] } — a day with any
                // entry is a day already spoken for.
                if (container && typeof container === 'object' && !Array.isArray(container)) {
                    for (const [date, entries] of Object.entries(container as Record<string, unknown>)) {
                        if (Array.isArray(entries) && entries.length > 0) heldDates.add(date.slice(0, 10));
                    }
                    notes.push(`Found ${heldDates.size} day(s) already booked in the window.`);
                } else {
                    notes.push(
                        `listShape is dateKeyedMap but "${endpoint.listRoot}" is not an object. `
                        + `Got: ${JSON.stringify(container).slice(0, 200)}`,
                    );
                }
            } else {
                const existing = asList(container);
                for (const booking of existing) {
                    for (const field of endpoint.listDateFields) {
                        const value = booking[field];
                        if (typeof value === 'string' && value) {
                            heldDates.add(value.slice(0, 10));
                            break;
                        }
                    }
                }
                notes.push(`Found ${existing.length} existing booking(s) in the window.`);
            }
        }
    }

    // `me` works for reads, so it is a better fallback than a literal
    // {{userId}} in the path if the list step could not supply one.
    if (vars.userId === undefined) {
        vars.userId = 'me';
        if (endpoint.userIdPath) notes.push('Falling back to /users/me for the booking path.');
    }

    // ── 3. book the gaps ────────────────────────────────────────────────────
    for (const date of dates) {
        if (heldDates.has(date)) {
            rows.push({ date, status: 'skipped', detail: 'already booked' });
            continue;
        }
        if (dryRun) {
            rows.push(takenDates.has(date)
                ? { date, status: 'unavailable', detail: 'someone else holds this desk that day' }
                : { date, status: 'dry-run', detail: `would book ${deskId} (${slot})` });
            continue;
        }

        // Note the asymmetry, and do not "optimise" this into a skip. The desk
        // schedule is read defensively from a shape that has never been seen
        // populated, so a misreading is possible. Attempting anyway costs one
        // request that returns 422 and is reported as unavailable — exactly what
        // would have been reported by skipping. Skipping wrongly costs a day
        // you could have had, and does it silently.
        if (takenDates.has(date)) {
            notes.push(`${date}: desk looks taken; trying anyway in case that reading is wrong.`);
        }

        try {
            const res = await call(endpoint.create, { ...vars, date });
            if (res.signedOut) {
                rows.push({ date, status: 'error', detail: 'not signed in' });
                notes.push('Signed out partway through. Sign in at https://my.comeen.io/ and run '
                    + 'again — the days already booked will be skipped.');
                signedOut = true;
                break;
            }
            if (res.ok) {
                rows.push({ date, status: 'booked' });
            } else if (looksTaken(res.status, res.text)) {
                rows.push({ date, status: 'unavailable', detail: `${res.status}: ${res.text.slice(0, 160)}` });
            } else {
                rows.push({ date, status: 'error', detail: `${res.status}: ${res.text.slice(0, 200)}` });
            }
        } catch (err) {
            rows.push({ date, status: 'error', detail: err instanceof Error ? err.message : String(err) });
        }
    }

    return { rows, notes, resolvedDeskId, signedOut };
}
