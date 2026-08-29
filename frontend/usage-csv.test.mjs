import assert from "node:assert/strict";
import test from "node:test";
import { usageReportToCsv } from "./shared/usage-csv.js";
import { windowForBucket } from "./shared/usage-windows.js";

test("CSV has one row per group and escapes commas", () => {
  const csv = usageReportToCsv({
    buckets: [
      {
        key: "2026-08-20",
        groups: [
          {
            provider: "claude_code",
            model: "opus,4",
            input: 1,
            cached_input: 2,
            cache_write: 0,
            output: 3,
            total: 6,
            cost_usd: 1.5,
            cost_source: "estimated",
            turns: 2,
          },
        ],
      },
    ],
  });
  assert.match(csv, /^bucket,provider,/);
  assert.match(csv, /"opus,4"/);
  assert.match(csv, /claude_code/);
});

// Spreadsheet apps treat a leading =/+/-/@ as a formula. A model name or
// provider string that starts with one would execute on open — neutralize it.
test("CSV neutralizes spreadsheet formula injection in text cells", () => {
  const csv = usageReportToCsv({
    buckets: [
      {
        key: "2026-08-20",
        groups: [
          {
            provider: "=cmd|'/c calc'!A0",
            model: "+Profit",
            input: 1,
            cached_input: 0,
            cache_write: 0,
            output: 0,
            total: 1,
            cost_usd: null,
            cost_source: "unavailable",
            turns: 1,
          },
        ],
      },
    ],
  });
  const dataLine = csv.trim().split("\n")[1];
  assert.match(dataLine, /^2026-08-20,"'=cmd\|'\/c calc'!A0","'\+Profit"/);
  assert.doesNotMatch(dataLine, /(?<=^|,)=/);
});

test("month window uses bucket=month", () => {
  const w = windowForBucket("month");
  assert.equal(w.bucket, "month");
  assert.ok(w.until > w.since);
});
