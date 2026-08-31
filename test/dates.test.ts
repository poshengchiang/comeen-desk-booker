import test from 'node:test';
import assert from 'node:assert/strict';
import { datesToBook, localWeekday, toLocalISODate, type Weekday } from '../src/core/dates.js';
import {
    DEFAULT_SETTINGS,
    isValidDeskName,
    mergeSettings,
    prunePastSkipDates,
    substitute,
    type Settings,
} from '../src/core/config.js';

const TZ = 'Europe/Prague';
const TUESDAY = new Date('2026-08-25T07:00:00Z');
const WEEKDAYS: Weekday[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];

test('weekday and date are read in the target timezone', () => {
    assert.equal(localWeekday(TUESDAY, TZ), 'tuesday');
    assert.equal(toLocalISODate(TUESDAY, TZ), '2026-08-25');
});

test('late-evening UTC still resolves to the correct Prague day', () => {
    const lateNight = new Date('2026-08-25T23:30:00Z');
    assert.equal(toLocalISODate(lateNight, TZ), '2026-08-26');
    assert.equal(localWeekday(lateNight, TZ), 'wednesday');
});

test('weekends are excluded and the horizon is inclusive', () => {
    const dates = datesToBook({ weekdays: WEEKDAYS, horizonDays: 14, timeZone: TZ, now: TUESDAY });
    assert.equal(dates[0], '2026-08-25');
    assert.equal(dates.at(-1), '2026-09-08');
    assert.equal(dates.length, 11);
    assert.ok(!dates.includes('2026-08-29'));
    assert.ok(!dates.includes('2026-08-30'));
});

test('a subset of weekdays is respected, case-insensitively', () => {
    const dates = datesToBook({
        weekdays: ['MONDAY', 'Thursday'], horizonDays: 14, timeZone: TZ, now: TUESDAY,
    });
    assert.deepEqual(dates, ['2026-08-27', '2026-08-31', '2026-09-03', '2026-09-07']);
});

test('skipDates removes specific days', () => {
    const dates = datesToBook({
        weekdays: WEEKDAYS, horizonDays: 7, skipDates: ['2026-08-26'], timeZone: TZ, now: TUESDAY,
    });
    assert.ok(!dates.includes('2026-08-26'));
    assert.ok(dates.includes('2026-08-27'));
});

test('an unknown weekday name is rejected', () => {
    assert.throws(() => datesToBook({ weekdays: ['mon'], timeZone: TZ, now: TUESDAY }), /Not a weekday/);
});

test('DST boundary does not shift dates', () => {
    const beforeDst = new Date('2026-10-23T07:00:00Z');
    const dates = datesToBook({ weekdays: WEEKDAYS, horizonDays: 7, timeZone: TZ, now: beforeDst });
    assert.deepEqual(dates, [
        '2026-10-23', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30',
    ]);
});

test('substitute fills placeholders through nested structures', () => {
    const template = {
        desk_id: '{{deskId}}',
        date: '{{date}}',
        nested: { period: '{{slot}}', list: ['{{date}}', 'literal'] },
        untouched: 42,
    };
    assert.deepEqual(
        substitute(template, { deskId: 'abc', date: '2026-08-25', slot: 'all_day' }),
        {
            desk_id: 'abc',
            date: '2026-08-25',
            nested: { period: 'all_day', list: ['2026-08-25', 'literal'] },
            untouched: 42,
        },
    );
});

test('substitute leaves unknown placeholders in place rather than blanking them', () => {
    assert.equal(substitute('{{deskId}}/{{mystery}}', { deskId: 'abc' }), 'abc/{{mystery}}');
});

// ── mergeSettings: this is what makes "one person figures out the API, everyone
// else inherits it" actually work. Without the version check, a shipped fix is
// silently overridden by whatever the user saved months earlier.

test('a first-time user gets the shipped defaults', () => {
    const merged = mergeSettings(undefined);
    assert.deepEqual(merged.endpoint, DEFAULT_SETTINGS.endpoint);
    assert.equal(merged.endpointVersion, DEFAULT_SETTINGS.endpointVersion);
});

test('personal choices survive a merge', () => {
    const stored: Partial<Settings> = {
        endpointVersion: DEFAULT_SETTINGS.endpointVersion,
        deskName: '7-01',
        weekdays: ['tuesday', 'thursday'],
        timeZone: 'Asia/Taipei',
        enabled: true,
    };
    const merged = mergeSettings(stored);
    assert.equal(merged.deskName, '7-01');
    assert.deepEqual(merged.weekdays, ['tuesday', 'thursday']);
    assert.equal(merged.timeZone, 'Asia/Taipei');
    assert.equal(merged.enabled, true);
});

test('a stale stored endpoint config is replaced by a newer shipped one', () => {
    const stale: Partial<Settings> = {
        endpointVersion: DEFAULT_SETTINGS.endpointVersion - 1,
        deskName: '7-01',
        endpoint: { ...DEFAULT_SETTINGS.endpoint, apiBase: 'https://wrong.example.com' },
    };
    const merged = mergeSettings(stale);

    assert.equal(merged.endpoint.apiBase, DEFAULT_SETTINGS.endpoint.apiBase,
        'the shipped fix must win over the stale stored copy');
    assert.equal(merged.endpointVersion, DEFAULT_SETTINGS.endpointVersion);
    assert.equal(merged.deskName, '7-01', 'but the personal setting is still kept');
});

test('a current-version local endpoint edit is respected', () => {
    const local: Partial<Settings> = {
        endpointVersion: DEFAULT_SETTINGS.endpointVersion,
        endpoint: { ...DEFAULT_SETTINGS.endpoint, apiBase: 'https://my.comeen.io/api' },
    };
    assert.equal(mergeSettings(local).endpoint.apiBase, 'https://my.comeen.io/api',
        'someone mid-diagnostics must not have their edit reverted');
});

// ── numeric placeholders. Comeen's presence block wants a number, and a JSON
// string "6666" is not the same thing. injected.ts carries a copy of
// this rule, so these cases pin down the behaviour both must share.

test('a placeholder that is the whole value and resolves to an integer becomes a number', () => {
    assert.deepEqual(
        substitute({ building_id: '{{buildingId}}', desk_uuid: '{{deskId}}' }, {
            buildingId: '6666',
            deskId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        }),
        { building_id: 6666, desk_uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    );
});

test('a placeholder inside a larger string stays a string, which is what a path needs', () => {
    assert.equal(
        substitute('/v1/users/{{userId}}/work_activity_schedule.json', { userId: '999999' }),
        '/v1/users/999999/work_activity_schedule.json',
    );
});

test('a date keeps its dashes and so is never mistaken for a number', () => {
    assert.equal(substitute('{{date}}', { date: '2026-09-01' }), '2026-09-01');
});

// ── desk name format ────────────────────────────────────────────────────────
// The popup gates its buttons on this and background re-checks it, so the rule
// lives in one place and is pinned here.

test('a desk number is digits, a dash, digits', () => {
    for (const name of ['3-23', '3-01', '12-4', '1-1', '10-100']) {
        assert.equal(isValidDeskName(name), true, name);
    }
});

test('surrounding whitespace is tolerated, because people paste', () => {
    assert.equal(isValidDeskName('  3-23  '), true);
});

test('anything that is not a desk number is rejected', () => {
    for (const name of [
        '',            // the starting point, not an error, but not runnable
        '323',         // no separator
        '3 23',        // space instead of a dash
        '3–23',        // en dash, which is what a text editor autocorrects to
        'A-23',        // a letter
        '3-23-1',      // too many parts
        '3-',          // half typed
        'meeting room',
    ]) {
        assert.equal(isValidDeskName(name), false, JSON.stringify(name));
    }
});

test('the shipped default is empty, so a fresh install cannot book anyone else\'s desk', () => {
    assert.equal(DEFAULT_SETTINGS.deskName, '');
    assert.equal(isValidDeskName(DEFAULT_SETTINGS.deskName), false);
});

// ── skip dates outlive the horizon ──────────────────────────────────────────
// Marking a day months ahead is the point, so nothing may quietly discard an
// entry for being beyond the booking window — only for being in the past.

test('a skip date beyond the horizon still applies once the horizon reaches it', () => {
    const farOff = '2026-10-05'; // a Monday, well past a 14-day horizon
    const inWindow = datesToBook({
        weekdays: ['monday'],
        horizonDays: 14,
        skipDates: [farOff],
        timeZone: TZ,
        now: TUESDAY,
    });
    assert.ok(!inWindow.includes(farOff), 'not in the window yet either way');

    // Same skip list, a horizon long enough to reach it.
    const reached = datesToBook({
        weekdays: ['monday'],
        horizonDays: 60,
        skipDates: [farOff],
        timeZone: TZ,
        now: TUESDAY,
    });
    assert.ok(reached.length > 0, 'other Mondays are still booked');
    assert.ok(!reached.includes(farOff), 'the pre-marked day is honoured');
});

test('pruning drops only past skip dates, never future ones', () => {
    assert.deepEqual(
        prunePastSkipDates(['2026-08-01', '2026-08-30', '2026-08-31', '2026-12-25'], '2026-08-31'),
        ['2026-08-31', '2026-12-25'],
    );
});

test('pruning keeps today, because today is still bookable', () => {
    assert.deepEqual(prunePastSkipDates(['2026-08-31'], '2026-08-31'), ['2026-08-31']);
});
