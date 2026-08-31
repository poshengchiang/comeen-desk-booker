export type Weekday =
    | 'monday' | 'tuesday' | 'wednesday'
    | 'thursday' | 'friday' | 'saturday' | 'sunday';

const WEEKDAY_NAMES: readonly Weekday[] = [
    'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
];

function isWeekday(value: string): value is Weekday {
    return (WEEKDAY_NAMES as readonly string[]).includes(value);
}

/** Format a Date as YYYY-MM-DD as seen in `timeZone`. */
export function toLocalISODate(date: Date, timeZone: string): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(date);
}

/** Weekday name of `date` as seen in `timeZone`. */
export function localWeekday(date: Date, timeZone: string): Weekday {
    const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' })
        .format(date)
        .toLowerCase();
    if (!isWeekday(name)) throw new Error(`Unexpected weekday from Intl: "${name}"`);
    return name;
}

/** Local wall-clock time as `YYYY-MM-DDTHH:mm:ss`, matching what Comeen sends. */
export function toLocalISODateTime(date: Date, timeZone: string): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
    }).formatToParts(date);
    const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '00';
    // Intl renders midnight as 24 in some locales/engines.
    const hour = get('hour') === '24' ? '00' : get('hour');
    return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:${get('second')}`;
}

/**
 * Has this day's slot already begun?
 *
 * Comeen refuses a booking whose start time is in the past — with a 500 rather
 * than anything helpful, and it refuses its own web UI just the same, so this
 * is its behaviour and not something we are doing wrong. For an all-day slot
 * the start is midnight, so today is unbookable from one second past midnight
 * onwards. For an afternoon slot, today stays bookable until noon.
 *
 * Both sides are naive local wall-clock, which is the whole convention Comeen
 * uses, so a string comparison is exactly right here.
 */
export function hasSlotStarted(
    date: string,
    startTime: string,
    timeZone: string,
    now = new Date(),
): boolean {
    const start = `${date}T${startTime.replace(/\.\d+Z?$/, '').replace(/Z$/, '')}`;
    return toLocalISODateTime(now, timeZone) >= start;
}

export interface DatesToBookOptions {
    weekdays: string[];
    horizonDays?: number;
    skipDates?: string[];
    timeZone?: string;
    now?: Date;
}

/**
 * Every day from today (inclusive) up to `horizonDays` ahead whose weekday is
 * in `weekdays`, minus `skipDates`.
 *
 * The 14-day default is what makes unreliable scheduling acceptable: each run
 * tops the whole window back up, so missing a day (laptop shut, Chrome closed)
 * costs nothing as long as the extension runs again before the window drains.
 */
export function datesToBook({
    weekdays,
    horizonDays = 14,
    skipDates = [],
    timeZone = 'Europe/Prague',
    now = new Date(),
}: DatesToBookOptions): string[] {
    const wanted = new Set<Weekday>();
    for (const raw of weekdays) {
        const name = raw.toLowerCase();
        if (!isWeekday(name)) throw new Error(`Not a weekday name: "${raw}"`);
        wanted.add(name);
    }

    const skip = new Set(skipDates);
    const out: string[] = [];

    for (let offset = 0; offset <= horizonDays; offset += 1) {
        const day = new Date(now.getTime() + offset * 86_400_000);
        const iso = toLocalISODate(day, timeZone);
        if (!wanted.has(localWeekday(day, timeZone))) continue;
        if (skip.has(iso)) continue;
        out.push(iso);
    }

    return out;
}
