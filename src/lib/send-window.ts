import type { Copilot } from "../db/schema";

function parseHhmm(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

/** Local date/time parts for an instant in an IANA timezone. */
export function getZonedParts(
  date: Date,
  timeZone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** ISO weekday: 1=Mon … 7=Sun */
  isoWeekday: number;
  minutesSinceMidnight: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";

  const weekdayMap: Record<string, number> = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
  };

  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  const isoWeekday = weekdayMap[get("weekday")] ?? 1;

  return {
    year,
    month,
    day,
    hour,
    minute,
    isoWeekday,
    minutesSinceMidnight: hour * 60 + minute,
  };
}

/**
 * UTC instant for local calendar midnight on (year, month, day) in `timeZone`.
 */
function zonedMidnightUtc(
  year: number,
  month: number,
  day: number,
  timeZone: string,
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  const atGuess = getZonedParts(new Date(utcGuess), timeZone);
  const offsetMs =
    Date.UTC(
      atGuess.year,
      atGuess.month - 1,
      atGuess.day,
      atGuess.hour,
      atGuess.minute,
    ) - utcGuess;

  return new Date(utcGuess - offsetMs);
}

/**
 * UTC instants for local midnight → next midnight in `timeZone`.
 */
export function getCopilotDayBounds(
  timeZone: string,
  now: Date = new Date(),
): { start: Date; end: Date } {
  const parts = getZonedParts(now, timeZone);
  const start = zonedMidnightUtc(parts.year, parts.month, parts.day, timeZone);

  // Advance one local calendar day via UTC date arithmetic on Y-M-D
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  const end = zonedMidnightUtc(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    timeZone,
  );

  return { start, end };
}

function isWithinHours(
  minutesSinceMidnight: number,
  start: string,
  end: string,
): boolean {
  const startMin = parseHhmm(start);
  const endMin = parseHhmm(end);

  if (startMin === endMin) {
    return true;
  }

  if (endMin > startMin) {
    return minutesSinceMidnight >= startMin && minutesSinceMidnight < endMin;
  }

  // Overnight window (e.g. 22:00–06:00)
  return minutesSinceMidnight >= startMin || minutesSinceMidnight < endMin;
}

export function isWithinSendWindow(
  copilot: Pick<
    Copilot,
    "activeDays" | "sendingHours" | "sendingHoursActive" | "timezone"
  >,
  now: Date = new Date(),
): boolean {
  const parts = getZonedParts(now, copilot.timezone);

  if (!copilot.activeDays.includes(parts.isoWeekday)) {
    return false;
  }

  if (!copilot.sendingHoursActive) {
    return true;
  }

  return isWithinHours(
    parts.minutesSinceMidnight,
    copilot.sendingHours.start,
    copilot.sendingHours.end,
  );
}

export const OUTSIDE_SEND_WINDOW_MSG =
  "Outside send window — will resume on next active day/hours";
