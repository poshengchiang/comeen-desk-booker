import {
    BUILDING,
    DEFAULT_SETTINGS,
    FLOORS,
    isValidDeskName,
    loadSettings,
    prunePastSkipDates,
    saveSettings,
    type EndpointConfig,
    type Settings,
    type Slot,
} from './core/config.js';
import { datesToBook, localWeekday, toLocalISODate, type Weekday } from './core/dates.js';
import type { RunLog } from './background.js';

const DAYS: Weekday[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/** Monday-first, to match how a working week is read. */
const DOW_LABELS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

function el<T extends HTMLElement>(id: string): T {
    const node = document.getElementById(id);
    if (!node) throw new Error(`Missing element #${id}`);
    return node as T;
}

const fields = {
    enabled: el<HTMLInputElement>('enabled'),
    deskName: el<HTMLInputElement>('deskName'),
    deskId: el<HTMLInputElement>('deskId'),
    floorId: el<HTMLSelectElement>('floorId'),
    slot: el<HTMLSelectElement>('slot'),
    horizonDays: el<HTMLInputElement>('horizonDays'),
    timeZone: el<HTMLInputElement>('timeZone'),
    endpoint: el<HTMLTextAreaElement>('endpoint'),
    learnMode: el<HTMLInputElement>('learnMode'),
};

// ── static office facts ─────────────────────────────────────────────────────
el<HTMLSpanElement>('buildingName').textContent = BUILDING.name;

for (const floor of FLOORS) {
    const option = document.createElement('option');
    option.value = String(floor.id);
    option.textContent = floor.label;
    fields.floorId.append(option);
}

// ── weekday chips ───────────────────────────────────────────────────────────
const daysHost = el<HTMLDivElement>('days');
for (const day of DAYS) {
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = day;
    box.dataset.day = day;
    label.append(box, document.createTextNode(day.slice(0, 3)));
    daysHost.append(label);
}

function selectedDays(): Weekday[] {
    return [...daysHost.querySelectorAll<HTMLInputElement>('input:checked')]
        .map((box) => box.value as Weekday);
}

// ── state ───────────────────────────────────────────────────────────────────
// Settings auto-save, so this is the live copy rather than a snapshot taken at
// load. skipDates in particular is mutated by clicking the calendar.
let current: Settings = await loadSettings();

/**
 * The most recent run, so the calendar can show what was actually found rather
 * than only what is planned. Comes from storage on open and is replaced after
 * every run.
 */
let lastLog: RunLog | undefined;

function renderSettings(next: Settings): void {
    fields.enabled.checked = next.enabled;
    fields.deskName.value = next.deskName;
    fields.deskId.value = next.deskId;
    fields.floorId.value = String(next.floorId);
    fields.slot.value = next.slot;
    fields.horizonDays.value = String(next.horizonDays);
    fields.timeZone.value = next.timeZone;
    fields.endpoint.value = JSON.stringify(next.endpoint, null, 2);
    el<HTMLSpanElement>('timeZoneLabel').textContent = next.timeZone;
    for (const box of daysHost.querySelectorAll<HTMLInputElement>('input')) {
        box.checked = next.weekdays.includes(box.value as Weekday);
    }
}

/**
 * Read the form back into a Settings.
 *
 * The endpoint textarea is the one field that can be mid-edit and unparseable.
 * Auto-save runs on every keystroke, so a half-typed brace must not throw away
 * the working config: the last good value is kept and the caller is told.
 */
function collect(): { settings: Settings; endpointError?: string } {
    let endpoint: EndpointConfig = current.endpoint;
    let endpointError: string | undefined;
    try {
        endpoint = JSON.parse(fields.endpoint.value) as EndpointConfig;
    } catch (err) {
        endpointError = `Endpoint config is not valid JSON: ${(err as Error).message}`;
    }

    return {
        settings: {
            // Saving stamps the version the user has actually seen, so a later
            // build with a corrected contract still supersedes this.
            endpointVersion: current.endpointVersion,
            enabled: fields.enabled.checked,
                deskName: fields.deskName.value.trim(),
            deskId: fields.deskId.value.trim(),
            floorId: Number(fields.floorId.value) || DEFAULT_SETTINGS.floorId,
            // Fixed: there is one building, and it is shown as text, not edited.
            buildingId: BUILDING.id,
            weekdays: selectedDays(),
            slot: fields.slot.value as Slot,
            horizonDays: Number(fields.horizonDays.value) || DEFAULT_SETTINGS.horizonDays,
            // Owned by the calendar, not by any form field. Pruned on every
            // save so months of past entries do not pile up.
            skipDates: prunePastSkipDates(
                current.skipDates,
                toLocalISODate(new Date(), fields.timeZone.value.trim() || DEFAULT_SETTINGS.timeZone),
            ),
            timeZone: fields.timeZone.value.trim() || DEFAULT_SETTINGS.timeZone,
            endpoint,
        },
        endpointError,
    };
}

// ── the booking plan calendar ───────────────────────────────────────────────

const pad = (value: number): string => String(value).padStart(2, '0');
const isoFor = (year: number, month: number, day: number): string =>
    `${year}-${pad(month + 1)}-${pad(day)}`;

/**
 * Two months of days, with the ones that will actually be booked highlighted.
 *
 * This is the answer to "what is this going to do", which is why it draws the
 * whole horizon rather than only the exceptions to it. Clicking a planned day
 * moves it in and out of skipDates.
 */
function renderPlan(): void {
    const host = el<HTMLDivElement>('calendar');
    host.textContent = '';

    const today = toLocalISODate(new Date(), current.timeZone);
    const [todayYear, todayMonth] = today.split('-').map(Number) as [number, number, number];

    // Candidates ignoring skipDates, so a skipped day is still drawn as one of
    // the planned days rather than vanishing into the background.
    let candidates: Set<string>;
    try {
        candidates = new Set(datesToBook({
            weekdays: current.weekdays,
            horizonDays: current.horizonDays,
            skipDates: [],
            timeZone: current.timeZone,
        }));
    } catch {
        candidates = new Set();
    }

    // Whether a date is a weekday you come in, ignoring the horizon entirely.
    // Knowing in September that you are away in October is normal; the horizon
    // governs what gets booked, and has no business governing what you are
    // allowed to tell it in advance.
    const chosenWeekdays = new Set(current.weekdays);
    const isWorkday = (iso: string): boolean => {
        try {
            // Midday avoids any chance of the parsed instant landing on the
            // previous day once shifted into the target zone.
            return chosenWeekdays.has(localWeekday(new Date(`${iso}T12:00:00Z`), current.timeZone));
        } catch {
            return false;
        }
    };
    const skipped = new Set(current.skipDates);

    // What the last run found, by date. `booked` and `skipped` both mean "you
    // hold that day" — one just happened now and the other earlier.
    const outcome = new Map<string, string>();
    for (const row of lastLog?.rows ?? []) {
        if (row.status === 'booked' || row.status === 'skipped') outcome.set(row.date, 'have');
        else if (row.status === 'unavailable') outcome.set(row.date, 'taken');
        else if (row.status === 'error') outcome.set(row.date, 'failed');
    }

    // A run from days ago can still be showing green for days that have since
    // been given away, so the plan says how old it is rather than implying it
    // is live.
    const asOf = el<HTMLSpanElement>('planAsOf');
    asOf.textContent = lastLog
        ? `colours from ${new Date(lastLog.at).toLocaleString()} · click a day to skip it`
        : 'click a day to skip it';

    for (let offset = 0; offset < 2; offset += 1) {
        const month = todayMonth - 1 + offset;
        const year = todayYear + Math.floor(month / 12);
        const normalised = ((month % 12) + 12) % 12;

        const block = document.createElement('div');
        block.className = 'month';

        const name = document.createElement('div');
        name.className = 'month-name';
        name.textContent = new Date(Date.UTC(year, normalised, 1))
            .toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
        block.append(name);

        const grid = document.createElement('div');
        grid.className = 'grid';
        for (const label of DOW_LABELS) {
            const head = document.createElement('div');
            head.className = 'dow';
            head.textContent = label;
            grid.append(head);
        }

        const firstDayOfWeek = new Date(Date.UTC(year, normalised, 1)).getUTCDay();
        // getUTCDay is Sunday-first; the grid is Monday-first.
        const lead = (firstDayOfWeek + 6) % 7;
        for (let blank = 0; blank < lead; blank += 1) grid.append(document.createElement('div'));

        const daysInMonth = new Date(Date.UTC(year, normalised + 1, 0)).getUTCDate();
        for (let day = 1; day <= daysInMonth; day += 1) {
            const iso = isoFor(year, normalised, day);
            const cell = document.createElement('button');
            cell.className = 'day';
            cell.textContent = String(day);
            cell.type = 'button';

            if (iso < today) cell.classList.add('past');
            if (iso === today) cell.classList.add('today');

            const planned = candidates.has(iso);
            const markable = planned || (iso >= today && isWorkday(iso));

            if (markable) {
                // The user's own choice to skip outranks anything a run found:
                // it is an instruction, not an observation.
                const state = skipped.has(iso)
                    ? 'skip'
                    : outcome.get(iso) ?? (planned ? 'book' : 'later');
                cell.classList.add(state, 'clickable');
                cell.title = {
                    skip: 'Skipped — click to book it',
                    have: 'You already have this day. Clicking stops future runs re-booking it; '
                        + 'it does not cancel the booking in Comeen.',
                    taken: 'Someone else has this desk that day. Clicking stops it being retried.',
                    failed: 'The last attempt failed on this day. Open Last run for the reason.',
                    book: 'Click to skip',
                    later: 'Beyond the booking window for now. Click to skip it in advance — it '
                        + 'will be remembered when the window reaches it.',
                }[state] ?? 'Click to skip';
                cell.addEventListener('click', () => {
                    current.skipDates = skipped.has(iso)
                        ? current.skipDates.filter((entry) => entry !== iso)
                        : [...current.skipDates, iso].sort();
                    renderPlan();
                    queueSave();
                });
            }

            grid.append(cell);
        }

        block.append(grid);
        host.append(block);
    }
}

/**
 * Show whether the desk name is usable, and stop the buttons if it is not.
 *
 * Three states rather than two: empty is not an error, it is the starting
 * point, so it gets a plain hint. Only something typed and wrong turns red.
 * Scolding someone for not having filled a field in yet is how a setup screen
 * makes people feel stupid.
 */
function renderDeskState(): void {
    const raw = fields.deskName.value.trim();
    const note = el<HTMLParagraphElement>('deskNote');
    const valid = isValidDeskName(raw);

    if (raw === '') {
        note.textContent = 'Pick your desk first — the number printed on it, like 3-23.';
        note.classList.remove('bad');
        fields.deskName.classList.remove('bad');
    } else if (valid) {
        note.textContent = 'Looked up by name on every run, so the ID stays empty.';
        note.classList.remove('bad');
        fields.deskName.classList.remove('bad');
    } else {
        note.textContent = `"${raw}" is not a desk number. It should be digits, a dash, digits — like 3-23.`;
        note.classList.add('bad');
        fields.deskName.classList.add('bad');
    }

    // A desk ID set by hand in Advanced is a deliberate override, and stands in
    // for the name.
    const runnable = valid || fields.deskId.value.trim() !== '';
    for (const id of ['runNow', 'dryRun']) {
        el<HTMLButtonElement>(id).disabled = !runnable;
    }
}

function renderAutoNote(): void {
    const note = el<HTMLParagraphElement>('autoNote');
    note.textContent = current.enabled
        ? `On. Checks every 6 hours and books any missing day in the next ${current.horizonDays} `
            + 'days. Only runs while Chrome is open — a closed laptop just means it catches up later.'
        : 'Off. Nothing is booked unless you press Book now.';
}

// ── saving ──────────────────────────────────────────────────────────────────

function flashSaved(text = 'Saved'): void {
    const flag = el<HTMLSpanElement>('savedFlag');
    flag.textContent = text;
    flag.hidden = false;
    window.setTimeout(() => { flag.hidden = true; }, 1_200);
}

let saveTimer: number | undefined;

/**
 * There is no Save button: every change persists on its own after a short
 * pause. The pause is what keeps a typed desk name from writing storage once
 * per keystroke.
 */
function queueSave(): void {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => { void commit(); }, 300);
}

async function commit(): Promise<void> {
    const { settings, endpointError } = collect();
    current = settings;
    await saveSettings(settings);
    renderPlan();
    renderAutoNote();
    renderDeskState();
    flashSaved(endpointError ? 'Endpoint JSON invalid — not saved' : 'Saved');
}

for (const field of [
    fields.enabled, fields.deskName, fields.deskId, fields.floorId,
    fields.slot, fields.horizonDays, fields.timeZone, fields.endpoint,
]) {
    field.addEventListener('change', queueSave);
    field.addEventListener('input', queueSave);
}

// The save is debounced; the validation must not be, or the field stays red for
// a third of a second after you have already fixed it.
for (const field of [fields.deskName, fields.deskId]) {
    field.addEventListener('input', renderDeskState);
}
daysHost.addEventListener('change', queueSave);

// ── run log ─────────────────────────────────────────────────────────────────

function renderLog(log: RunLog | undefined): void {
    const host = el<HTMLPreElement>('log');
    host.textContent = '';
    if (!log) {
        host.textContent = 'No runs yet.';
        return;
    }

    const when = new Date(log.at).toLocaleString();
    const head = document.createElement('div');
    head.textContent = `${when}${log.dryRun ? '  (preview — nothing was booked)' : ''}`;
    host.append(head);

    if (log.error) {
        const problem = document.createElement('div');
        problem.className = 'st-error';
        problem.textContent = `error: ${log.error}`;
        host.append(problem);
    }

    for (const note of log.notes) {
        const line = document.createElement('div');
        line.className = 'st-skipped';
        line.textContent = `· ${note}`;
        host.append(line);
    }

    for (const row of log.rows) {
        const line = document.createElement('div');
        line.className = `st-${row.status}`;
        line.textContent = `${row.date}  ${row.status}${row.detail ? `  ${row.detail}` : ''}`;
        host.append(line);
    }
}

async function renderCaptures(): Promise<void> {
    const { captures = [] } = await chrome.storage.local.get('captures') as { captures?: unknown[] };
    const host = el<HTMLPreElement>('captures');
    if (captures.length === 0) {
        host.textContent = 'Nothing recorded yet.';
        return;
    }
    host.textContent = captures.map((capture) => JSON.stringify(capture, null, 1)).join('\n\n');
}

// ── load ────────────────────────────────────────────────────────────────────
renderSettings(current);
renderPlan();
renderAutoNote();
renderDeskState();

const { runs = [], learnMode = false } = await chrome.storage.local.get(['runs', 'learnMode']) as {
    runs?: RunLog[];
    learnMode?: boolean;
};
fields.learnMode.checked = learnMode;
lastLog = runs[0];
renderLog(runs[0]);
// The plan was drawn before the log was loaded, so colour it in now.
renderPlan();

// Opening the popup is what marks a failure as read, so the badge clears here
// rather than waiting for the next successful run.
void chrome.runtime.sendMessage({ type: 'popup-opened' }).catch(() => { /* worker asleep */ });
await renderCaptures();

// ── actions ─────────────────────────────────────────────────────────────────

async function triggerRun(button: HTMLButtonElement, dryRun: boolean): Promise<void> {
    button.disabled = true;
    const original = button.textContent;
    button.textContent = dryRun ? 'Checking…' : 'Booking…';
    try {
        await commit();
        const response = await chrome.runtime.sendMessage({ type: 'run', dryRun }) as {
            ok: boolean;
            log?: RunLog;
            error?: string;
        };
        if (response.ok && response.log) {
            lastLog = response.log;
            renderLog(response.log);
            renderPlan();
        } else {
            renderLog({
                at: new Date().toISOString(),
                dryRun,
                dates: [],
                rows: [],
                notes: [],
                error: response.error ?? 'Unknown failure',
            });
        }
    } catch (err) {
        renderLog({
            at: new Date().toISOString(),
            dryRun,
            dates: [],
            rows: [],
            notes: [],
            error: err instanceof Error ? err.message : String(err),
        });
    } finally {
        button.textContent = original;
        // Not `disabled = false`: whether these are usable is renderDeskState's
        // decision, and a run does not change it.
        renderDeskState();
    }
}

el<HTMLButtonElement>('runNow').addEventListener('click', (event) => {
    void triggerRun(event.currentTarget as HTMLButtonElement, false);
});

el<HTMLButtonElement>('dryRun').addEventListener('click', (event) => {
    void triggerRun(event.currentTarget as HTMLButtonElement, true);
});

fields.learnMode.addEventListener('change', () => {
    void chrome.storage.local.set({ learnMode: fields.learnMode.checked });
});

el<HTMLButtonElement>('copyCaptures').addEventListener('click', async (event) => {
    const { captures = [] } = await chrome.storage.local.get('captures') as { captures?: unknown[] };
    await navigator.clipboard.writeText(JSON.stringify(captures, null, 2));
    const button = event.currentTarget as HTMLButtonElement;
    const original = button.textContent;
    button.textContent = 'Copied';
    window.setTimeout(() => { button.textContent = original; }, 1_400);
});

el<HTMLButtonElement>('clearCaptures').addEventListener('click', async () => {
    await chrome.storage.local.set({ captures: [] });
    await renderCaptures();
});
