import type {OfficeHoursDay} from '@plunk/types';

/* Dependency-free so the messenger bundle can import it through the `./office-hours` subpath. */

export const MESSENGER_REPLY_TIMES = ['FEW_MINUTES', 'FEW_HOURS', 'ONE_DAY'] as const;
export const MESSENGER_DEFAULT_TIMEZONE = 'UTC';

const DAY = 1440;
const WEEK = 7 * DAY;
const MINUTE_MS = 60_000;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatters.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, cached);
  }
  return cached;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', {timeZone});
    return true;
  } catch {
    return false;
  }
}

/** Minutes since Monday 00:00 on the wall clock of `timeZone`. */
function weekMinute(date: Date, timeZone: string): number {
  let weekday = 0;
  let hour = 0;
  let minute = 0;
  for (const part of formatter(timeZone).formatToParts(date)) {
    if (part.type === 'weekday') weekday = WEEKDAYS.indexOf(part.value);
    else if (part.type === 'hour') hour = Number(part.value) % 24;
    else if (part.type === 'minute') minute = Number(part.value);
  }
  return weekday * DAY + hour * 60 + minute;
}

export interface OfficeHoursStatus {
  online: boolean;
  /** When the team is next online. Null while online, or when no day has hours. */
  nextOpenAt: Date | null;
}

/** Whether `now` falls inside the office hours, judged on the wall clock of `timeZone`. */
export function officeHoursStatus(days: OfficeHoursDay[], timeZone: string, now: Date): OfficeHoursStatus {
  const ranges = days
    .filter(day => day.day >= 1 && day.day <= 7 && day.end > day.start)
    .map(day => [(day.day - 1) * DAY + day.start, (day.day - 1) * DAY + day.end] as const)
    .sort((a, b) => a[0] - b[0]);
  if (ranges.length === 0) {
    return {online: false, nextOpenAt: null};
  }

  const current = weekMinute(now, timeZone);
  if (ranges.some(([start, end]) => current >= start && current < end)) {
    return {online: true, nextOpenAt: null};
  }

  const next = ranges.find(([start]) => start > current)?.[0] ?? ranges[0]![0] + WEEK;
  let at = now.getTime() - (now.getTime() % MINUTE_MS) + (next - current) * MINUTE_MS;
  /* Stepping by wall-clock minutes is off by the offset change when a DST switch falls in between,
  so the landing time is read back and corrected by however far its wall clock is from the target. */
  const drift = next - weekMinute(new Date(at), timeZone);
  at += ((((drift + WEEK / 2) % WEEK) + WEEK) % WEEK - WEEK / 2) * MINUTE_MS;
  return {online: false, nextOpenAt: new Date(at)};
}
