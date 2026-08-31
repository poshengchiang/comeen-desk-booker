import test from 'node:test';
import assert from 'node:assert/strict';
import { bookInPage, type InPageArgs } from '../src/injected.js';
import { DEFAULT_SETTINGS, SLOT_TIMES } from '../src/core/config.js';

/**
 * bookInPage is the riskiest code in the project and the hardest to eyeball: it
 * is serialized into the page, so a mistake surfaces as a runtime error in
 * somebody's browser rather than a compile error here. These tests drive it
 * against a stubbed fetch using response shapes copied from a real August 2026
 * capture, so the parsing is checked against what Comeen actually returns
 * rather than what the config claims it returns.
 */

// ── fixtures, trimmed from the real capture ─────────────────────────────────

// Deliberately invented, and deliberately not the shipped defaults either.
// A test that asserts the request body against the same constants the
// implementation reads would pass even if those constants were wrong; passing
// distinct values in and looking for them coming out is what actually proves
// the substitution works.
const DESK_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const USER_ID = 999999;
const FLOOR_ID = 7777;
const AREA_ID = 8888;
const BUILDING_ID = 6666;

/** /v1/floors/<id>/desks_schedule.json — note there is no `id`, only `uuid`. */
const DESKS = [
    {
        uuid: 'bb2451cb-3fb4-4ce5-ae53-c461758d5574',
        name: '3-01',
        sync_id: '3-01',
        available_to_booking: true,
        person_id: null,
        floor_id: FLOOR_ID,
        area_id: 4321,
        schedule: [],
    },
    {
        uuid: DESK_UUID,
        name: '3-23',
        sync_id: '3-23',
        available_to_booking: true,
        person_id: null,
        floor_id: FLOOR_ID,
        area_id: AREA_ID,
        schedule: [],
    },
];

/** /v1/users/me/work_activity_schedule.json — the date is the KEY, not a field. */
function scheduleResponse(byDate: Record<string, unknown[]>) {
    return {
        parent: { id: USER_ID, email: 'someone@example.com' },
        user: { id: USER_ID, email: 'someone@example.com' },
        schedule: byDate,
    };
}

const BOOKING_ID = 12345;

const BOOKING = {
    id: BOOKING_ID,
    period: 'all_day',
    work_activity: 'on_site',
    state: 'pending',
    start_datetime: '2026-09-01T00:00:00',
    end_datetime: '2026-09-01T23:59:59',
};

// ── stub browser ────────────────────────────────────────────────────────────

interface Call {
    method: string;
    url: string;
    body: unknown;
}

interface Route {
    match: RegExp;
    method?: string;
    status?: number;
    json?: unknown;
    text?: string;
    /** Final URL after redirects, as a real Response would report it. */
    url?: string;
}

/**
 * Installs a window/document good enough for bookInPage and returns the log of
 * requests it made, so a test can assert on the request as well as the outcome.
 */
function stubBrowser(routes: Route[]): Call[] {
    const calls: Call[] = [];

    const fetchStub = async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? 'GET';
        const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
        calls.push({ method, url, body });

        const route = routes.find((candidate) => candidate.match.test(url)
            && (candidate.method ?? 'GET') === method);
        if (!route) throw new Error(`No stub route for ${method} ${url}`);

        const status = route.status ?? 200;
        const text = route.text ?? JSON.stringify(route.json ?? null);
        return {
            ok: status >= 200 && status < 300,
            status,
            url: route.url ?? url,
            text: async () => text,
        };
    };

    const fakeWindow = {
        fetch: fetchStub,
        location: { href: 'https://my.comeen.io/map' },
        localStorage: {
            getItem: () => null,
            // Object.keys() on this yields the method names, which is exactly
            // the "names only, never values" shape diagnostics promises.
        },
    };

    Reflect.set(globalThis, 'window', fakeWindow);
    Reflect.set(globalThis, 'document', { cookie: '_comeen_session=abc; locale=en' });
    return calls;
}

function argsFor(dates: string[], overrides: Partial<InPageArgs> = {}): InPageArgs {
    return {
        endpoint: DEFAULT_SETTINGS.endpoint,
        dates,
        deskName: '3-23',
        deskId: '',
        slot: 'all_day',
        cancelDates: [],
        startTime: SLOT_TIMES.all_day.start,
        endTime: SLOT_TIMES.all_day.end,
        floorId: FLOOR_ID,
        buildingId: BUILDING_ID,
        dryRun: false,
        ...overrides,
    };
}

const DESKS_ROUTE: Route = { match: /desks_schedule\.json/, json: DESKS };

// ── the desk lookup ─────────────────────────────────────────────────────────

test('a desk resolves by uuid, because Comeen desks have no id field', async () => {
    stubBrowser([
        DESKS_ROUTE,
        { match: /work_activity_schedule/, json: scheduleResponse({ '2026-09-01': [] }) },
        { match: /work_activity_schedule/, method: 'POST', json: BOOKING },
    ]);

    const result = await bookInPage(argsFor(['2026-09-01']));

    assert.equal(result.resolvedDeskId, DESK_UUID);
    assert.ok(result.notes.some((note) => note.includes('uuid')));
});

test('a desk that is missing reports it, with diagnostics and no credential', async () => {
    stubBrowser([{ match: /desks_schedule\.json/, json: [DESKS[0]] }]);

    const result = await bookInPage(argsFor(['2026-09-01'], { deskName: '9-99' }));

    assert.deepEqual(result.rows, []);
    assert.ok(result.notes[0]?.includes('No desk called "9-99"'));
    assert.equal(result.diagnostics?.url, 'https://my.comeen.io/map');
    // Cookie NAMES are diagnostic; cookie values would be a credential leak.
    assert.deepEqual(result.diagnostics?.cookieNames, ['_comeen_session', 'locale']);
    assert.ok(!JSON.stringify(result.diagnostics).includes('abc'));
});

// ── the create request ──────────────────────────────────────────────────────

test('the booking request matches what the app itself sends', async () => {
    const calls = stubBrowser([
        DESKS_ROUTE,
        { match: /work_activity_schedule/, json: scheduleResponse({ '2026-09-01': [] }) },
        { match: /work_activity_schedule/, method: 'POST', json: BOOKING },
    ]);

    const result = await bookInPage(argsFor(['2026-09-01']));
    assert.deepEqual(result.rows, [{ date: '2026-09-01', status: 'booked' }]);

    const post = calls.find((call) => call.method === 'POST');
    assert.ok(post, 'expected a POST');

    // The numeric user id comes out of the list response, not from settings.
    assert.ok(post.url.includes(`/v1/users/${USER_ID}/work_activity_schedule.json`));

    assert.deepEqual(post.body, {
        work_activity: {
            state: 'on_site',
            start_datetime: '2026-09-01T00:00:00.000Z',
            end_datetime: '2026-09-01T23:59:59.000Z',
        },
        presence: {
            // Numbers, not strings: a whole-value placeholder resolving to an
            // integer is emitted as JSON number. area_id is the DESK's area,
            // read off the resolved record rather than configured.
            building_id: BUILDING_ID,
            floor_id: FLOOR_ID,
            area_id: AREA_ID,
        },
        desk_booking: { desk_uuid: DESK_UUID },
    });
});

test('a half-day slot moves the times without touching the date', async () => {
    const calls = stubBrowser([
        DESKS_ROUTE,
        { match: /work_activity_schedule/, json: scheduleResponse({ '2026-09-01': [] }) },
        { match: /work_activity_schedule/, method: 'POST', json: BOOKING },
    ]);

    await bookInPage(argsFor(['2026-09-01'], {
        slot: 'afternoon',
        startTime: SLOT_TIMES.afternoon.start,
        endTime: SLOT_TIMES.afternoon.end,
    }));

    const post = calls.find((call) => call.method === 'POST');
    const activity = (post?.body as { work_activity: Record<string, string> }).work_activity;
    assert.equal(activity.start_datetime, '2026-09-01T12:00:00.000Z');
    assert.equal(activity.end_datetime, '2026-09-01T23:59:59.000Z');
});

// ── idempotency, which is the whole point of the list step ──────────────────

test('days already held are skipped, gaps are booked', async () => {
    const calls = stubBrowser([
        DESKS_ROUTE,
        {
            match: /work_activity_schedule/,
            json: scheduleResponse({
                '2026-09-01': [BOOKING],
                '2026-09-02': [],
                '2026-09-03': [BOOKING],
            }),
        },
        { match: /work_activity_schedule/, method: 'POST', json: BOOKING },
    ]);

    const result = await bookInPage(argsFor(['2026-09-01', '2026-09-02', '2026-09-03']));

    assert.deepEqual(result.rows, [
        { date: '2026-09-01', status: 'skipped', detail: 'already booked' },
        { date: '2026-09-02', status: 'booked' },
        { date: '2026-09-03', status: 'skipped', detail: 'already booked' },
    ]);
    assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
});

test('re-running once everything is held books nothing at all', async () => {
    const calls = stubBrowser([
        DESKS_ROUTE,
        {
            match: /work_activity_schedule/,
            json: scheduleResponse({ '2026-09-01': [BOOKING], '2026-09-02': [BOOKING] }),
        },
    ]);

    const result = await bookInPage(argsFor(['2026-09-01', '2026-09-02']));

    assert.ok(result.rows.every((row) => row.status === 'skipped'));
    assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
});

test('a dry run resolves the desk but writes nothing', async () => {
    const calls = stubBrowser([
        DESKS_ROUTE,
        { match: /work_activity_schedule/, json: scheduleResponse({ '2026-09-01': [] }) },
    ]);

    const result = await bookInPage(argsFor(['2026-09-01'], { dryRun: true }));

    assert.equal(result.rows[0]?.status, 'dry-run');
    assert.ok(result.rows[0]?.detail?.includes(DESK_UUID));
    assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
});

// ── contention and failure ──────────────────────────────────────────────────

test('a desk someone else took is unavailable, and the run continues', async () => {
    let attempt = 0;
    stubBrowser([
        DESKS_ROUTE,
        {
            match: /work_activity_schedule/,
            json: scheduleResponse({ '2026-09-01': [], '2026-09-02': [] }),
        },
        {
            match: /work_activity_schedule/,
            method: 'POST',
            get status() { return ++attempt === 1 ? 422 : 200; },
            get text() {
                return attempt === 1
                    ? '{"error":"This desk is already taken"}'
                    : JSON.stringify(BOOKING);
            },
        } as Route,
    ]);

    const result = await bookInPage(argsFor(['2026-09-01', '2026-09-02']));

    assert.equal(result.rows[0]?.status, 'unavailable');
    assert.ok(result.rows[0]?.detail?.includes('taken'));
    // The second day must still be attempted: one contended day is not a run failure.
    assert.equal(result.rows[1]?.status, 'booked');
});

test('a 500 is an error, not silently swallowed as unavailable', async () => {
    stubBrowser([
        DESKS_ROUTE,
        { match: /work_activity_schedule/, json: scheduleResponse({ '2026-09-01': [] }) },
        {
            match: /work_activity_schedule/,
            method: 'POST',
            status: 500,
            text: 'upstream exploded',
        },
    ]);

    const result = await bookInPage(argsFor(['2026-09-01']));

    assert.equal(result.rows[0]?.status, 'error');
    assert.ok(result.rows[0]?.detail?.includes('500'));
});

test('a failed list costs idempotency but not the run, and says so', async () => {
    stubBrowser([
        DESKS_ROUTE,
        { match: /work_activity_schedule/, status: 503, text: 'nope' },
        { match: /work_activity_schedule/, method: 'POST', json: BOOKING },
    ]);

    const result = await bookInPage(argsFor(['2026-09-01']));

    assert.ok(result.notes.some((note) => note.includes('Could not list existing bookings')));
    assert.equal(result.rows[0]?.status, 'booked');
});

test('without a user id from the list, the path falls back to /users/me', async () => {
    const calls = stubBrowser([
        DESKS_ROUTE,
        { match: /work_activity_schedule/, status: 503, text: 'nope' },
        { match: /work_activity_schedule/, method: 'POST', json: BOOKING },
    ]);

    await bookInPage(argsFor(['2026-09-01']));

    const post = calls.find((call) => call.method === 'POST');
    assert.ok(post?.url.includes('/v1/users/me/work_activity_schedule.json'));
});

// ── an expired session ──────────────────────────────────────────────────────
// This is the case that used to lie: Comeen answers a dead session by
// redirecting to the login page, so the fetch returns 200 full of HTML, which
// parses to null and reads downstream as "zero desks". The message a user got
// was "No desk called 3-23", which sends them looking in entirely the wrong
// place.

const LOGIN_PAGE = '<!doctype html><html><head><title>Sign in</title></head><body></body></html>';

test('a login page served with 200 is reported as signed out, not as a missing desk', async () => {
    stubBrowser([{ match: /desks_schedule\.json/, text: LOGIN_PAGE }]);

    const result = await bookInPage(argsFor(['2026-09-01']));

    assert.deepEqual(result.rows, []);
    assert.match(result.notes[0] ?? '', /Not signed in/);
    assert.ok(!result.notes.some((note) => note.includes('No desk called')));
    assert.equal(result.diagnostics?.url, 'https://my.comeen.io/map');
});

test('a redirect to the accounts host is signed out even when the body is JSON', async () => {
    stubBrowser([{
        match: /desks_schedule\.json/,
        json: {},
        url: 'https://accounts.comeen.io/auth/login',
    }]);

    const result = await bookInPage(argsFor(['2026-09-01']));
    assert.match(result.notes[0] ?? '', /Not signed in/);
});

test('a 401 on the list step stops the run rather than booking blind', async () => {
    const calls = stubBrowser([
        DESKS_ROUTE,
        { match: /work_activity_schedule/, status: 401, text: '{"error":"unauthorized"}' },
    ]);

    const result = await bookInPage(argsFor(['2026-09-01']));

    assert.match(result.notes[0] ?? '', /Not signed in/);
    // An ordinary list failure carries on without the duplicate check. A dead
    // session must not, or every date POSTs into a 401.
    assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
});

test('signing out partway through stops the loop instead of hammering every date', async () => {
    const calls = stubBrowser([
        DESKS_ROUTE,
        {
            match: /work_activity_schedule/,
            json: scheduleResponse({ '2026-09-01': [], '2026-09-02': [], '2026-09-03': [] }),
        },
        { match: /work_activity_schedule/, method: 'POST', status: 403, text: 'forbidden' },
    ]);

    const result = await bookInPage(argsFor(['2026-09-01', '2026-09-02', '2026-09-03']));

    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0]?.detail, 'not signed in');
    assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
    assert.ok(result.notes.some((note) => note.includes('Signed out partway through')));
});

// ── the desk's own schedule ─────────────────────────────────────────────────
// Read defensively: the capture that produced this contract never had a
// populated schedule[], so the shape below is inferred. That is exactly why the
// reading is advisory — see the safety test at the end of this block.

/** A desk record whose schedule says someone holds it on 2026-09-02. */
function deskHeldOn(dates: string[]) {
    return [{
        ...DESKS[1],
        schedule: dates.map((date) => ({
            id: 1,
            // Deliberately present: these are when the booking was MADE. A
            // naive scan for anything date-shaped would mark 2026-08-06 taken.
            created_at: '2026-08-06T16:03:32.324Z',
            updated_at: '2026-08-06T16:03:32.324Z',
            start_datetime: `${date}T00:00:00`,
            end_datetime: `${date}T23:59:59`,
        })),
    }];
}

test('preview reports a day someone else holds instead of promising to book it', async () => {
    stubBrowser([
        { match: /desks_schedule\.json/, json: deskHeldOn(['2026-09-02']) },
        {
            match: /work_activity_schedule/,
            json: scheduleResponse({ '2026-09-01': [], '2026-09-02': [] }),
        },
    ]);

    const result = await bookInPage(argsFor(['2026-09-01', '2026-09-02'], { dryRun: true }));

    assert.equal(result.rows[0]?.status, 'dry-run');
    assert.equal(result.rows[1]?.status, 'unavailable');
    assert.match(result.rows[1]?.detail ?? '', /someone else/);
});

test('the booking date is read from start_datetime, never from created_at', async () => {
    stubBrowser([
        { match: /desks_schedule\.json/, json: deskHeldOn(['2026-09-02']) },
        { match: /work_activity_schedule/, json: scheduleResponse({ '2026-08-06': [] }) },
    ]);

    // 2026-08-06 is the created_at of that entry. Treating it as the booked day
    // would mark an unrelated date taken.
    const result = await bookInPage(argsFor(['2026-08-06'], { dryRun: true }));

    assert.equal(result.rows[0]?.status, 'dry-run');
});

test('a real run still attempts a day the schedule calls taken', async () => {
    const calls = stubBrowser([
        { match: /desks_schedule\.json/, json: deskHeldOn(['2026-09-02']) },
        { match: /work_activity_schedule/, json: scheduleResponse({ '2026-09-02': [] }) },
        { match: /work_activity_schedule/, method: 'POST', json: BOOKING },
    ]);

    const result = await bookInPage(argsFor(['2026-09-02']));

    // The whole safety property: a misread schedule can mislead the preview but
    // can never cost a booking. If this ever flips to `skipped`, the asymmetry
    // argued in injected.ts has been optimised away.
    assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
    assert.equal(result.rows[0]?.status, 'booked');
});

test('a desk with no schedule entries is simply not flagged', async () => {
    stubBrowser([
        DESKS_ROUTE,
        { match: /work_activity_schedule/, json: scheduleResponse({ '2026-09-01': [] }) },
    ]);

    const result = await bookInPage(argsFor(['2026-09-01'], { dryRun: true }));
    assert.equal(result.rows[0]?.status, 'dry-run');
});

// ── cancelling ──────────────────────────────────────────────────────────────
// The only destructive operation here, so these tests are about what it must
// NOT do as much as what it must.

test('cancelling deletes by the numeric booking id from the list, not the desk uuid', async () => {
    const calls = stubBrowser([
        DESKS_ROUTE,
        { match: /users\/me\/work_activity_schedule/, json: scheduleResponse({ '2026-09-01': [BOOKING] }) },
        { match: /work_activity_schedule\/\d+/, method: 'DELETE', status: 204, text: '' },
    ]);

    const result = await bookInPage(argsFor([], { cancelDates: ['2026-09-01'] }));

    const del = calls.find((call) => call.method === 'DELETE');
    assert.ok(del, 'expected a DELETE');
    assert.ok(del.url.endsWith(`/v1/me/work_activity_schedule/${BOOKING_ID}`), del.url);
    // The desk uuid identifies a desk, not a booking. Sending it here is a 404.
    assert.ok(!del.url.includes(DESK_UUID));

    assert.deepEqual(result.rows, [{ date: '2026-09-01', status: 'cancelled', detail: undefined }]);
    assert.deepEqual(result.cancelled, ['2026-09-01']);
});

test('a day with nothing booked is not an error — the wanted state is already true', async () => {
    const calls = stubBrowser([
        DESKS_ROUTE,
        { match: /users\/me\/work_activity_schedule/, json: scheduleResponse({ '2026-09-01': [] }) },
    ]);

    const result = await bookInPage(argsFor([], { cancelDates: ['2026-09-01'] }));

    assert.equal(result.rows[0]?.status, 'skipped');
    assert.equal(calls.filter((call) => call.method === 'DELETE').length, 0);
    // Still reported done, so it stops being retried on every future run.
    assert.deepEqual(result.cancelled, ['2026-09-01']);
});

test('a 404 counts as cancelled, because something else already removed it', async () => {
    stubBrowser([
        DESKS_ROUTE,
        { match: /users\/me\/work_activity_schedule/, json: scheduleResponse({ '2026-09-01': [BOOKING] }) },
        { match: /work_activity_schedule\/\d+/, method: 'DELETE', status: 404, text: 'not found' },
    ]);

    const result = await bookInPage(argsFor([], { cancelDates: ['2026-09-01'] }));

    assert.equal(result.rows[0]?.status, 'cancelled');
    assert.equal(result.rows[0]?.detail, 'already gone');
});

test('a failed cancellation is not reported as done, so it will be retried', async () => {
    stubBrowser([
        DESKS_ROUTE,
        { match: /users\/me\/work_activity_schedule/, json: scheduleResponse({ '2026-09-01': [BOOKING] }) },
        { match: /work_activity_schedule\/\d+/, method: 'DELETE', status: 500, text: 'boom' },
    ]);

    const result = await bookInPage(argsFor([], { cancelDates: ['2026-09-01'] }));

    assert.equal(result.rows[0]?.status, 'error');
    assert.deepEqual(result.cancelled, []);
});

test('a preview never deletes anything', async () => {
    const calls = stubBrowser([
        DESKS_ROUTE,
        { match: /users\/me\/work_activity_schedule/, json: scheduleResponse({ '2026-09-01': [BOOKING] }) },
    ]);

    const result = await bookInPage(argsFor([], { cancelDates: ['2026-09-01'], dryRun: true }));

    assert.equal(result.rows[0]?.status, 'dry-run');
    assert.match(result.rows[0]?.detail ?? '', /would cancel/);
    assert.equal(calls.filter((call) => call.method === 'DELETE').length, 0);
    assert.deepEqual(result.cancelled, []);
});

test('a date being cancelled is never booked in the same run', async () => {
    const calls = stubBrowser([
        DESKS_ROUTE,
        { match: /users\/me\/work_activity_schedule/, json: scheduleResponse({ '2026-09-01': [BOOKING] }) },
        { match: /work_activity_schedule\/\d+/, method: 'DELETE', status: 204, text: '' },
        { match: /users\/\d+\/work_activity_schedule/, method: 'POST', json: BOOKING },
    ]);

    // Both lists naming the same day is the worst case: cancel then rebook
    // would leave the booking in place and report success at both ends.
    await bookInPage(argsFor(['2026-09-01'], { cancelDates: ['2026-09-01'] }));

    assert.equal(calls.filter((call) => call.method === 'DELETE').length, 1);
    assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
});

test('the list window stretches to cover a cancellation beyond the booking horizon', async () => {
    const calls = stubBrowser([
        DESKS_ROUTE,
        { match: /users\/me\/work_activity_schedule/, json: scheduleResponse({ '2026-12-24': [BOOKING] }) },
        { match: /work_activity_schedule\/\d+/, method: 'DELETE', status: 204, text: '' },
        { match: /users\/\d+\/work_activity_schedule/, method: 'POST', json: BOOKING },
    ]);

    await bookInPage(argsFor(['2026-09-01'], { cancelDates: ['2026-12-24'] }));

    // A list query that stopped at the booking horizon would never return the
    // December booking, and the cancellation could never find its id.
    const list = calls.find((call) => call.url.includes('users/me/work_activity_schedule'));
    assert.match(list?.url ?? '', /end_date=2026-12-24/);
});
