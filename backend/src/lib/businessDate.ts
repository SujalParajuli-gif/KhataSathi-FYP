const DAY_MS = 24 * 60 * 60 * 1000; // total milliseconds in one day, used for date arithmetic
const BUSINESS_OFFSET_MS = (5 * 60 + 45) * 60 * 1000; // Nepal timezone offset from UTC is +5 hours 45 minutes, converted to milliseconds

export const BUSINESS_TIME_ZONE = "Asia/Kathmandu"; // Nepal's timezone identifier used throughout the app

// parsing a date string in YYYY-MM-DD format into a UTC Date object
// we validate both the format and whether the date is a real calendar date (e.g., rejects Feb 30)
export function parseBusinessDate(value: string, label = "date") {
  // making sure the string matches the required format before trying to parse it
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must be in YYYY-MM-DD format.`);
  }

  const [year, month, day] = value.split("-").map(Number); // splitting the date string into year, month, day as numbers
  const parsed = new Date(Date.UTC(year, month - 1, day)); // creating a UTC date (month is 0-indexed in JavaScript)

  // verifying that JavaScript did not silently adjust the date
  // for example, Feb 31 would get silently changed to Mar 3, which is not what we want
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`${label} is not a valid calendar date.`);
  }

  return parsed;
}

// converting a business date to the start of that day in UTC
// we subtract the Nepal offset so that when we query the database (which stores UTC timestamps),
// we get records that fall within the correct Nepal business day
export function toBusinessRangeStart(date: Date) {
  return new Date(date.getTime() - BUSINESS_OFFSET_MS);
}

// converting a business date to the end of that day in UTC
// we add a full day, subtract the Nepal offset, and subtract 1ms to get 23:59:59.999 in Nepal time
export function toBusinessRangeEnd(date: Date) {
  return new Date(date.getTime() + DAY_MS - BUSINESS_OFFSET_MS - 1);
}

// converting a UTC Date to Nepal business time
// we use this when generating invoice numbers so the date part matches the actual Nepal business day
export function toBusinessClock(date: Date) {
  return new Date(date.getTime() + BUSINESS_OFFSET_MS);
}

// getting the start of a business day (00:00:00.000 UTC) for a given date
// this is used as a base for date range calculations
export function startOfBusinessDay(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

// getting the very end of a business day (23:59:59.999 UTC) for a given date
// we use this to build "up to and including" date range filters
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

// adding a given number of days to a date, used for shifting dates in report range calculations
export function addBusinessDays(date: Date, days: number) {
  return new Date(date.getTime() + days * DAY_MS);
}

// adding a given number of hours to a date
export function addBusinessHours(date: Date, hours: number) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

// finding the start of the business week (Monday) for a given date
// we calculate how many days back Monday is, then subtract that from the current date
export function startOfBusinessWeek(date: Date) {
  const day = date.getUTCDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  const distanceFromMonday = (day + 6) % 7; // converting so Monday = 0, Sunday = 6
  return addBusinessDays(startOfBusinessDay(date), -distanceFromMonday);
}

// building a Prisma-compatible date range filter from optional "from" and "to" date strings
// we use this in reports and invoice listing to filter records by a Nepal business date range
// returns undefined if neither from nor to is provided, so the query runs without a date filter
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

  return Object.keys(range).length > 0 ? range : undefined; // only return the range if at least one bound is set
}
