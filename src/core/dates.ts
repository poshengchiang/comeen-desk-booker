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
