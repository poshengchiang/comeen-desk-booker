import { datesToBook } from './core/dates.js';
import {
    isValidDeskName,
    loadSettings,
    saveSettings,
    SLOT_TIMES,
    type Settings,
} from './core/config.js';
import { bookInPage, type InPageResult } from './injected.js';

const ALARM = 'comeen-top-up';
const COMEEN_URL = 'https://my.comeen.io/';
const TAB_MATCH = 'https://my.comeen.io/*';
const SIGNED_OUT_NOTIFICATION = 'comeen-signed-out';

/**
 * Thrown when the session is gone, so the caller can tell it apart from an
 * ordinary failure by type rather than by reading the message text.
 */
class SignedOutError extends Error {}

export interface RunLog {
    at: string;
    dryRun: boolean;
    dates: string[];
    rows: InPageResult['rows'];
    notes: string[];
    error?: string;
    /** The run stopped because the Comeen session has expired. */
    signedOut?: boolean;
}

async function appendLog(entry: RunLog): Promise<void> {
    const { runs = [] } = await chrome.storage.local.get('runs') as { runs?: RunLog[] };
    await chrome.storage.local.set({ runs: [entry, ...runs].slice(0, 10) });
}

/**
 * Find a Comeen tab, or open one in the background.
 * Returns the tab id plus whether we created it (and should therefore close it).
 */
async function getComeenTab(): Promise<{ tabId: number; temporary: boolean }> {
    const open = await chrome.tabs.query({ url: TAB_MATCH });
    const existing = open.find((t) => typeof t.id === 'number' && t.status === 'complete')
        ?? open.find((t) => typeof t.id === 'number');
    if (existing?.id !== undefined) return { tabId: existing.id, temporary: false };

    const tab = await chrome.tabs.create({ url: COMEEN_URL, active: false });
    if (tab.id === undefined) throw new Error('Could not open a Comeen tab.');
    await waitForLoad(tab.id);

    // An expired session redirects my.comeen.io to accounts.comeen.io, which is
    // deliberately not in host_permissions — so executeScript would fail there
    // with a permissions error that says nothing about the actual problem.
    // Checking the URL turns that into a sentence worth reading.
    const loaded = await chrome.tabs.get(tab.id);
    if (loaded.url && !loaded.url.startsWith(COMEEN_URL)) {
        throw new SignedOutError(
            'Not signed in to Comeen (the page redirected to sign-in). '
            + 'Open https://my.comeen.io/, sign in, then run again.',
        );
    }

    return { tabId: tab.id, temporary: true };
}

function waitForLoad(tabId: number, timeoutMs = 30_000): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            reject(new Error('Comeen tab did not finish loading in time.'));
        }, timeoutMs);

        const listener = (id: number, info: chrome.tabs.TabChangeInfo): void => {
            if (id !== tabId || info.status !== 'complete') return;
            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(listener);
            // The SPA needs a moment after `complete` before its auth state is ready.
            setTimeout(resolve, 2_500);
        };
        chrome.tabs.onUpdated.addListener(listener);
    });
}

let inFlight: Promise<RunLog> | undefined;

/**
 * One run at a time. Two overlapping runs would each read the bookings list
 * before the other had written anything, so both would decide the same day was
 * free and both would try to book it.
 */
export function runBooking(dryRun: boolean): Promise<RunLog> {
    if (inFlight) return inFlight;
    inFlight = runBookingOnce(dryRun).finally(() => { inFlight = undefined; });
    return inFlight;
}

async function runBookingOnce(dryRun: boolean): Promise<RunLog> {
    const settings: Settings = await loadSettings();

    const dates = datesToBook({
        weekdays: settings.weekdays,
        horizonDays: settings.horizonDays,
        skipDates: settings.skipDates,
        timeZone: settings.timeZone,
    });

    const base: RunLog = { at: new Date().toISOString(), dryRun, dates, rows: [], notes: [] };

    if (dates.length === 0) {
        const entry = { ...base, notes: ['No candidate dates in the horizon.'] };
        await appendLog(entry);
        await reflectRun(entry);
        return entry;
    }

    if (!settings.deskName && !settings.deskId) {
        const entry = { ...base, error: 'Pick your desk in the popup first (the number on it, like 3-23).' };
        await appendLog(entry);
        await reflectRun(entry);
        return entry;
    }

    // The popup gates its own buttons on this, but an automatic run reads
    // straight from storage — which could hold a bad value saved by an older
    // build, or edited by hand. Checking here is what makes the rule real.
    if (settings.deskName && !isValidDeskName(settings.deskName)) {
        const entry = {
            ...base,
            error: `"${settings.deskName}" is not a desk number. It should be digits, a dash, `
                + 'digits — like 3-23.',
        };
        await appendLog(entry);
        await reflectRun(entry);
        return entry;
    }

    let temporary = false;
    let tabId: number | undefined;

    try {
        const tab = await getComeenTab();
        tabId = tab.tabId;
        temporary = tab.temporary;

        const [result] = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: bookInPage,
            args: [{
                endpoint: settings.endpoint,
                dates,
                deskName: settings.deskName,
                deskId: settings.deskId,
                slot: settings.slot,
                // Resolved out here so the slot-to-times table stays testable
                // instead of being inlined into the serialized page function.
                startTime: SLOT_TIMES[settings.slot].start,
                endTime: SLOT_TIMES[settings.slot].end,
                floorId: settings.floorId,
                buildingId: settings.buildingId,
                dryRun,
            }],
        });

        const value = result?.result as InPageResult | undefined;

        // Cache the looked-up id so the next run skips the search entirely.
        if (value?.resolvedDeskId && value.resolvedDeskId !== settings.deskId) {
            await saveSettings({ ...settings, deskId: value.resolvedDeskId });
        }

        const entry: RunLog = {
            ...base,
            rows: value?.rows ?? [],
            notes: value?.notes ?? ['The in-page script returned nothing.'],
            signedOut: value?.signedOut === true,
        };
        await appendLog(entry);
        await reflectRun(entry);
        return entry;
    } catch (err) {
        const entry: RunLog = {
            ...base,
            error: err instanceof Error ? err.message : String(err),
            signedOut: err instanceof SignedOutError,
        };
        await appendLog(entry);
        await reflectRun(entry);
        return entry;
    } finally {
        // Only close what we opened. Never close a tab the user was using.
        if (temporary && tabId !== undefined) {
            try { await chrome.tabs.remove(tabId); } catch { /* already gone */ }
        }
    }
}

/**
 * Show the outcome of a run somewhere the user will actually see it.
 *
 * Everything before this was written into chrome.storage and rendered only if
 * you opened the popup — so an automatic run that failed at 3am was, in
 * practice, silent. An automation you cannot tell has stopped is worse than no
 * automation, because you stop checking.
 *
 * The badge means "there is a failure you have not read yet", not "the last run
 * failed". The difference matters: read as the latter, a badge raised by a
 * signed-out run stayed lit after you signed in and previewed successfully,
 * with no way to dismiss it, because only a successful real run cleared it.
 * Automatic switched off, and it stayed lit for good. Opening the popup is what
 * marks it read — see clearFailureBadge.
 */
async function reflectRun(entry: RunLog): Promise<void> {
    const failed = Boolean(entry.error) || entry.rows.some((row) => row.status === 'error');

    // A preview cannot exercise the create call, so a clean one is not proof
    // that booking works and must not clear a real failure. It can still raise
    // the badge: whatever it hit — signed out, bad desk, API down — is real.
    if (entry.dryRun && !failed) return;

    await chrome.action.setBadgeText({ text: failed ? '!' : '' });
    if (failed) {
        await chrome.action.setBadgeBackgroundColor({ color: '#b91c1c' });
    }

    if (entry.signedOut) {
        // Fixed id, so a session that stays expired across several runs
        // replaces its own notification instead of stacking up.
        chrome.notifications.create(SIGNED_OUT_NOTIFICATION, {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icon-128.png'),
            title: 'Comeen desk booker',
            message: 'Your Comeen session expired. Click here to sign in — booking resumes on '
                + 'its own once you are back.',
        });
    } else if (!entry.dryRun) {
        chrome.notifications.clear(SIGNED_OUT_NOTIFICATION);
    }
}

/**
 * Mark the failure as read. Called when the popup opens, because that is where
 * the detail lives: if you have looked at Last run, you know.
 */
async function clearFailureBadge(): Promise<void> {
    await chrome.action.setBadgeText({ text: '' });
}

/**
 * Signing back in is the fix, so noticing that you have is the whole feature:
 * the next time a Comeen page finishes loading after a signed-out failure, the
 * missed run happens by itself. No button to find, no notification to act on.
 */
async function retryAfterSignIn(): Promise<void> {
    const { runs = [] } = await chrome.storage.local.get('runs') as { runs?: RunLog[] };
    if (runs[0]?.signedOut !== true) return;

    // Only the automatic path self-heals. If automatic is off, every run is
    // something the user asked for, and a surprise booking would not be.
    const settings = await loadSettings();
    if (!settings.enabled) return;

    console.info('[comeen] signed back in — retrying the run that failed');
    await runBooking(false);
}

async function ensureAlarm(): Promise<void> {
    const existing = await chrome.alarms.get(ALARM);
    if (existing) return;
    // Every 6 hours. The 14-day booking horizon means precision does not matter:
    // any run tops the whole window back up, so a missed firing costs nothing.
    await chrome.alarms.create(ALARM, { periodInMinutes: 360, delayInMinutes: 1 });
}

async function runIfEnabled(reason: string): Promise<void> {
    const settings = await loadSettings();
    if (!settings.enabled) return;
    console.info(`[comeen] running (${reason})`);
    await runBooking(false);
}

chrome.runtime.onInstalled.addListener(() => {
    void ensureAlarm();
});

// Chrome was just started: catch up immediately rather than waiting for the alarm.
chrome.runtime.onStartup.addListener(() => {
    void ensureAlarm();
    void runIfEnabled('browser startup');
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ALARM) return;
    void runIfEnabled('alarm');
});

chrome.tabs.onUpdated.addListener((_tabId, info, tab) => {
    if (info.status !== 'complete') return;
    if (!tab.url?.startsWith(COMEEN_URL)) return;
    void retryAfterSignIn();
});

chrome.notifications.onClicked.addListener((id) => {
    if (id !== SIGNED_OUT_NOTIFICATION) return;
    void chrome.tabs.create({ url: COMEEN_URL });
    chrome.notifications.clear(SIGNED_OUT_NOTIFICATION);
});

chrome.runtime.onMessage.addListener((message: { type?: string; dryRun?: boolean }, _sender, respond) => {
    if (message?.type === 'popup-opened') {
        void clearFailureBadge();
        respond({ ok: true });
        return false;
    }
    if (message?.type === 'run') {
        runBooking(message.dryRun ?? false)
            .then((log) => respond({ ok: true, log }))
            .catch((err: unknown) => respond({
                ok: false,
                error: err instanceof Error ? err.message : String(err),
            }));
        return true; // keep the channel open for the async response
    }
    return false;
});
