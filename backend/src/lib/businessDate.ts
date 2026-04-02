const DAY_MS = 24 * 60 * 60 * 1000;
const BUSINESS_OFFSET_MS = (5 * 60 + 45) * 60 * 1000;

export const BUSINESS_TIME_ZONE = "Asia/Kathmandu";

export function parseBusinessDate(value: string, label = "date") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must be in YYYY-MM-DD format.`);
  }

  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`${label} is not a valid calendar date.`);
  }

  return parsed;
}

export function toBusinessRangeStart(date: Date) {
  return new Date(date.getTime() - BUSINESS_OFFSET_MS);
}

export function toBusinessRangeEnd(date: Date) {
  return new Date(date.getTime() + DAY_MS - BUSINESS_OFFSET_MS - 1);
}

export function toBusinessClock(date: Date) {
  return new Date(date.getTime() + BUSINESS_OFFSET_MS);
}

export function startOfBusinessDay(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

export function endOfBusinessDay(date: Date) {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      23,
      59,
      59,
      999,
    ),
  );
}

export function addBusinessDays(date: Date, days: number) {
  return new Date(date.getTime() + days * DAY_MS);
}

export function addBusinessHours(date: Date, hours: number) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

export function startOfBusinessWeek(date: Date) {
  const day = date.getUTCDay();
  const distanceFromMonday = (day + 6) % 7;
  return addBusinessDays(startOfBusinessDay(date), -distanceFromMonday);
}

export function buildBusinessDateRange(filters: {
  from?: string;
  to?: string;
}) {
  const range: { gte?: Date; lte?: Date } = {};

  if (filters.from) {
    range.gte = toBusinessRangeStart(
      parseBusinessDate(filters.from, "from"),
    );
  }

  if (filters.to) {
    range.lte = toBusinessRangeEnd(parseBusinessDate(filters.to, "to"));
  }

  return Object.keys(range).length > 0 ? range : undefined;
}
