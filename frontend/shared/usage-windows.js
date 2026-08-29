// The time windows the Usage screen asks for, one per bucket.
//
// Every window is half-open — `[since, until)` — matching the store's own
// query, and every boundary is LOCAL midnight rather than a UTC one. A user
// reading "today" means the day they are standing in; a UTC day boundary would
// move that line by up to 13 hours and quietly reassign a night's work to
// yesterday.
//
// The date arithmetic here is all done by stepping a `Date` through the
// calendar rather than by adding seconds to a timestamp. The two agree until
// they don't: a DST boundary makes a "day" 23 or 25 hours long, and a month is
// not a fixed number of days at all.

/**
 * `until` for a window that runs up to this instant.
 *
 * The `+ 1` is the half-open interval: an event recorded during the current
 * second sits at exactly `now`, and `[since, now)` would drop it. The user
 * would see their most recent turn missing from a report they opened
 * immediately after it finished — the one moment they are most likely to check.
 */
export function usageUntilNow() {
  return Math.floor(Date.now() / 1000) + 1;
}

/**
 * Local midnight, `daysAgo` calendar days back.
 *
 * `setDate` steps the calendar; subtracting `daysAgo * 86400` from a timestamp
 * does not. Across a DST change the subtraction lands an hour to either side of
 * midnight, which either duplicates a day in the bucket list or skips one.
 */
export function localMidnightDaysAgo(daysAgo = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return Math.floor(d.getTime() / 1000);
}

// `dayCount - 1`, because today is one of the days being counted: a 14-day
// window starts 13 days back, not 14. The `Math.max(1, …)` floor is here and in
// the two below so a caller passing 0 gets the smallest sensible window rather
// than an inverted one, where `since` is after `until` and the report is empty
// for a reason no error message would explain.
export function dayReportWindow(dayCount = 14) {
  return {
    since: localMidnightDaysAgo(Math.max(1, dayCount) - 1),
    until: usageUntilNow(),
    bucket: "day",
  };
}

/**
 * Whole weeks back, each starting Monday.
 *
 * `getDay()` numbers Sunday 0 … Saturday 6, so the step back to Monday is
 * `day - 1` for every day EXCEPT Sunday, which needs 6. Treating Sunday as
 * `-1` would push the window a day forward instead of back, and the current
 * week would start tomorrow.
 */
export function weekReportWindow(weekCount = 6) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const mondayOffset = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - mondayOffset - 7 * (Math.max(1, weekCount) - 1));
  return {
    since: Math.floor(d.getTime() / 1000),
    until: usageUntilNow(),
    bucket: "week",
  };
}

/**
 * Whole months back, each starting on the 1st.
 *
 * `setDate(1)` runs BEFORE `setMonth`, and the order is the whole trick. On the
 * 31st, `setMonth(month - 1)` targets a month that has no 31st, and JS resolves
 * the overflow by rolling forward — 31 March back one month becomes 3 March.
 * Landing on the 1st first makes every month a date that exists.
 */
export function monthReportWindow(monthCount = 6) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  d.setMonth(d.getMonth() - (Math.max(1, monthCount) - 1));
  return {
    since: Math.floor(d.getTime() / 1000),
    until: usageUntilNow(),
    bucket: "month",
  };
}

// Day is the fallback rather than an error: an unrecognised bucket comes from a
// stale link or a typo in a query string, and the day view is the one a user
// arriving without an opinion wants.
export function windowForBucket(bucket) {
  if (bucket === "week") return weekReportWindow(6);
  if (bucket === "month") return monthReportWindow(6);
  return dayReportWindow(14);
}
