import type { Weekday } from './dates.js';

export type Slot = 'all_day' | 'morning' | 'afternoon';

/**
 * How the in-page code should authenticate.
 *
 * `cookie`       - just send credentials with the request. Correct if Comeen
 *                  authenticates with a session cookie.
 * `localStorage` - read a token out of the page's own localStorage and put it
 *                  in a header. Correct if Comeen uses a bearer token.
 *
 * Either way the value is read inside the page and used there. It is never
 * copied into extension storage, never persisted, and never leaves the tab.
 */
export interface AuthConfig {
    mode: 'cookie' | 'localStorage';
    /** localStorage key holding the token. */
    storageKey?: string;
    /** Dotted path inside the parsed JSON, e.g. `stsTokenManager.accessToken` */
    jsonPath?: string;
    /** Header to set, default `authorization` */
    header?: string;
    /** Prefix before the token, default `Bearer ` */
    prefix?: string;
}

export interface RequestTemplate {
    method: 'GET' | 'POST' | 'PUT';
    /** Path appended to apiBase. May contain placeholders. */
    path: string;
    query?: Record<string, string>;
    body?: unknown;
}

/**
 * How the "what do I already hold" response is laid out.
 *
 * `array`        - a flat list of bookings, each carrying its own date field,
 *                  read via `listDateFields`.
 * `dateKeyedMap` - an object keyed by `YYYY-MM-DD` whose values are that day's
 *                  entries. Comeen returns this one. The date is the *key*, not
 *                  a field, so no amount of sniffing field names would find it —
 *                  which is exactly why the shape is configuration rather than
 *                  something the in-page code guesses.
 */
export type ListShape = 'array' | 'dateKeyedMap';

/**
 * The whole API contract lives here as data so it can be corrected from the
 * popup without rebuilding. Placeholders available to paths, queries and
 * bodies: {{date}}, {{deskId}}, {{deskName}}, {{slot}}, {{startTime}},
 * {{endTime}}, {{from}}, {{to}}, {{userId}}, {{floorId}}, {{buildingId}},
 * {{areaId}}.
 */
export interface EndpointConfig {
    apiBase: string;
    auth: AuthConfig;
    /**
     * Look a desk up by its human name so nobody has to know its internal id.
     * Set to null only if your Comeen has no desk-search endpoint.
     */
    resolve: RequestTemplate | null;
    /** Field names that might hold a desk's human label in a search result. */
    deskNameFields: string[];
    /** Field names that might hold a desk's internal id. Comeen uses `uuid`. */
    deskIdFields: string[];
    /**
     * Field on a desk record holding that desk's own bookings for the queried
     * window. Used to tell you a day is already taken *before* you press Book
     * now. Set to '' to disable.
     */
    deskScheduleField: string;
    /**
     * Date fields to read off one of those entries, in priority order, first
     * match wins.
     *
     * The order matters more than it looks: an entry almost certainly also
     * carries created_at and updated_at, which are when the booking was made,
     * not the day booked. Listing only the fields that mean "the day this is
     * for" is what stops a booking made three weeks ago from marking three
     * weeks ago as taken.
     */
    deskScheduleDateFields: string[];
    /** Set to null to skip the "what do I already have" check. */
    list: RequestTemplate | null;
    /** Dotted path to the container inside the list response. '' means root. */
    listRoot: string;
    listShape: ListShape;
    /** Only consulted when listShape is 'array'. */
    listDateFields: string[];
    /**
     * Dotted path to the signed-in user's id inside the list response. Empty
     * disables the lookup, and {{userId}} then stays unfilled.
     */
    userIdPath: string;
    create: RequestTemplate;
}

export interface Settings {
    /**
     * Bumped in DEFAULT_SETTINGS whenever the shipped endpoint config is
     * corrected. See mergeSettings: a stored config older than the shipped one
     * is replaced rather than merged, which is what lets a fix actually reach
     * people who have already saved settings once.
     */
    endpointVersion: number;
    enabled: boolean;
    deskName: string;
    deskId: string;
    /**
     * The floor the desk is on. This one cannot be derived: resolving a desk by
     * name means listing a floor's desks, so the floor has to be known first.
     * Visible in the URL of Comeen's floor plan, and in `floor_id` on any desk.
     */
    floorId: number;
    /**
     * The building the floor is in. Also not derivable — a desk record carries
     * `floor_id` and `area_id` but no `building_id`, and the only endpoint that
     * maps one to the other needs a space UUID we never otherwise fetch.
     */
    buildingId: number;
    weekdays: Weekday[];
    slot: Slot;
    horizonDays: number;
    skipDates: string[];
    timeZone: string;
    endpoint: EndpointConfig;
}

/**
 * A slot as the naive local times Comeen expects.
 *
 * Comeen sends datetimes like `2026-09-01T00:00:00.000Z` and echoes them back
 * as `2026-09-01T00:00:00` — a local wall-clock time wearing a `Z`. So the day
 * is used verbatim and no timezone conversion happens anywhere in the booking
 * path. The date logic in dates.ts already produces exactly this.
 *
 * ⚠️ Only `all_day` is confirmed against a real booking. The half-days are a
 * reasonable reading of the same scheme, not an observed one.
 */
export const SLOT_TIMES: Record<Slot, { start: string; end: string }> = {
    all_day: { start: '00:00:00.000Z', end: '23:59:59.000Z' },
    morning: { start: '00:00:00.000Z', end: '12:00:00.000Z' },
    afternoon: { start: '12:00:00.000Z', end: '23:59:59.000Z' },
};

/**
 * Confirmed against a real signed-in session in August 2026, by capturing the
 * traffic of one desk booking made by hand.
 *
 * Notes worth keeping, because each one contradicts a reasonable guess:
 *   - `apiBase` is my.comeen.io/api, the SPA's own origin, NOT api.comeen.io
 *     where the public docs live. It is a Rails backend behind a Nuxt front end,
 *     which is why paths end in `.json`.
 *   - The API version varies per endpoint (/v1, /v2, /v2beta), so the version
 *     belongs in each path rather than in apiBase.
 *   - A desk's id is `uuid`. There is no `id` field on a desk at all.
 *   - The bookings list is keyed by date; the date is not a field on an entry.
 *   - A booking is a "work activity" with a desk attached, not a desk booking
 *     as such. That is why the path says work_activity_schedule.
 *   - Auth is the session cookie. A fetch from the page with credentials
 *     included and no Authorization header returns 200, so there is no token to
 *     read and nothing for the extension to hold.
 */
export const DEFAULT_SETTINGS: Settings = {
    // ⬆ BUMP THIS whenever you correct the `endpoint` block below, otherwise
    // anyone who already pressed Save keeps their stale copy forever.
    endpointVersion: 3,
    enabled: false,
    // Empty on purpose. Shipping a real desk number as the default means the
    // first person to install this and press Book now takes somebody else's
    // seat, having done nothing wrong. Nothing runs until a desk is chosen.
    deskName: '',
    deskId: '',
    floorId: 4952,
    buildingId: 5151,
    weekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
    slot: 'all_day',
    horizonDays: 14,
    skipDates: [],
    timeZone: 'Europe/Prague',
    endpoint: {
        apiBase: 'https://my.comeen.io/api',
        auth: { mode: 'cookie' },
        resolve: {
            method: 'GET',
            path: '/v1/floors/{{floorId}}/desks_schedule.json',
            query: {
                start_date: '{{from}}T00:00:00.000Z',
                end_date: '{{to}}T23:59:59.000Z',
            },
        },
        deskNameFields: ['name', 'sync_id'],
        deskIdFields: ['uuid', 'id'],
        deskScheduleField: 'schedule',
        deskScheduleDateFields: ['start_datetime', 'start_date', 'date', 'day', 'start'],
        list: {
            method: 'GET',
            path: '/v1/users/me/work_activity_schedule.json',
            query: {
                start_date: '{{from}}T00:00:00.000Z',
                end_date: '{{to}}T23:59:59.000Z',
            },
        },
        listRoot: 'schedule',
        listShape: 'dateKeyedMap',
        listDateFields: ['start_datetime', 'date'],
        userIdPath: 'user.id',
        create: {
            method: 'POST',
            // The `me` alias works for reads; the app itself uses the numeric
            // id to write, so that is what is used here.
            path: '/v1/users/{{userId}}/work_activity_schedule.json',
            body: {
                work_activity: {
                    state: 'on_site',
                    start_datetime: '{{date}}T{{startTime}}',
                    end_datetime: '{{date}}T{{endTime}}',
                },
                presence: {
                    building_id: '{{buildingId}}',
                    floor_id: '{{floorId}}',
                    area_id: '{{areaId}}',
                },
                desk_booking: { desk_uuid: '{{deskId}}' },
            },
        },
    },
};

/**
 * The office, as captured in August 2026.
 *
 * Hardcoded rather than fetched. The floor dropdown has to be populated before
 * any network call happens, an office layout changes about never, and a
 * hardcoded floor that is wrong is a visible mistake rather than a silent one.
 *
 * To add a floor, read the ids from the response of
 * /api/v2/spaces/<space-uuid>/buildings/<building-id>/floors.json with the
 * floor plan open.
 */
export const BUILDING = { id: 5151, name: '100yards' };

/**
 * A desk name is digits, a dash, digits — `3-23`, `12-4`.
 *
 * Deliberately not tightened to two zero-padded digits, which is what this
 * office happens to use: a floor 12 or a desk 100 would then be rejected for
 * looking wrong rather than for being wrong. What this catches is the mistake
 * people actually make — typing something that is not a desk number at all: a
 * name, a room, a stray space.
 */
export const DESK_NAME_PATTERN = /^\d+-\d+$/;

/** Empty is not valid, but it is not an error either — see the popup. */
export function isValidDeskName(name: string): boolean {
    return DESK_NAME_PATTERN.test(name.trim());
}

/**
 * Drop skip dates that have already passed.
 *
 * Days can be marked months ahead, so without this the list only ever grows —
 * a year of "I was away that Tuesday" accumulating in storage and in the
 * settings JSON, where it is noise that makes the real entries hard to read.
 */
export function prunePastSkipDates(skipDates: string[], today: string): string[] {
    return skipDates.filter((date) => date >= today);
}

export const FLOORS: { id: number; label: string }[] = [
    { id: 4952, label: 'Floor 3' },
    { id: 4953, label: 'Floor 4' },
];

export type Vars = Record<string, string>;

/**
 * A placeholder that makes up the *entire* value and resolves to an integer
 * becomes a number.
 *
 * This matters because JSON distinguishes 5151 from "5151" and Comeen's
 * presence block wants the former. Partial interpolation — "/users/{{userId}}/x"
 * — always yields a string, which is what a path needs, so the two cases never
 * collide. A uuid or a date contains non-digits and stays a string either way.
 */
const WHOLE_PLACEHOLDER = /^\{\{(\w+)\}\}$/;
const INTEGER = /^-?\d+$/;

/** Replace {{placeholders}} throughout a JSON-ish value. */
export function substitute(value: unknown, vars: Vars): unknown {
    if (typeof value === 'string') {
        const whole = WHOLE_PLACEHOLDER.exec(value);
        if (whole) {
            const replacement = vars[whole[1] ?? ''];
            if (replacement === undefined) return value;
            return INTEGER.test(replacement) ? Number(replacement) : replacement;
        }
        return value.replace(/\{\{(\w+)\}\}/g, (match, key: string) => vars[key] ?? match);
    }
    if (Array.isArray(value)) {
        return value.map((entry) => substitute(entry, vars));
    }
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value)) out[key] = substitute(entry, vars);
        return out;
    }
    return value;
}

/**
 * Merge stored settings over the shipped defaults.
 *
 * Personal choices (desk, weekdays, timezone) always win: they are the user's.
 * The endpoint config is different. It is not a preference, it is a fact about
 * Comeen's API that one person discovers and everyone else inherits. If a
 * stored copy predates the shipped one, the shipped one replaces it outright.
 * Merging key-by-key would be worse than useless here: a corrected `create`
 * block would sit next to a stale `list` block and fail in a confusing way.
 *
 * Pure and separate from chrome.storage so it can be tested.
 */
export function mergeSettings(stored: Partial<Settings> | undefined): Settings {
    const storedVersion = stored?.endpointVersion ?? 0;
    const shippedIsNewer = storedVersion < DEFAULT_SETTINGS.endpointVersion;

    return {
        ...DEFAULT_SETTINGS,
        ...stored,
        endpointVersion: DEFAULT_SETTINGS.endpointVersion,
        endpoint: shippedIsNewer || !stored?.endpoint
            ? DEFAULT_SETTINGS.endpoint
            : stored.endpoint,
    };
}

export async function loadSettings(): Promise<Settings> {
    const stored = await chrome.storage.local.get('settings');
    return mergeSettings(stored.settings as Partial<Settings> | undefined);
}

export async function saveSettings(settings: Settings): Promise<void> {
    await chrome.storage.local.set({ settings });
}
