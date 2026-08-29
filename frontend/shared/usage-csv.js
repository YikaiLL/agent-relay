// CSV export for the usage report.
//
// Client-side, from the JSON the screen already has, so there is one code path
// rather than two: a server-rendered CSV would be a second query that could
// disagree with the numbers on screen at the moment the user clicked.

/**
 * One CSV cell, escaped.
 *
 * The leading-quote prefix is not cosmetic. A cell whose first character is
 * `=`, `+`, `-` or `@` is a FORMULA to Excel, Sheets and LibreOffice, and it
 * runs on open — `=1+1` is the harmless demonstration, and the rest of that
 * family reaches the filesystem and the network. Model names and task titles
 * reach this function unfiltered, so the export is an injection sink unless
 * every value is neutralised on the way out.
 *
 * The prefix forces quoting too: an apostrophe added outside quotes would be
 * read back as part of the value by anything parsing the file as data rather
 * than opening it as a spreadsheet.
 */
function csvEscape(value) {
  let text = value == null ? "" : String(value);
  let forceQuote = false;
  if (/^[=+\-@]/.test(text)) {
    text = `'${text}`;
    forceQuote = true;
  }
  // Doubling the quote is RFC 4180's escape — a backslash would be read
  // literally by every spreadsheet that opens this.
  if (forceQuote || /[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * Flatten a report into CSV rows: one line per bucket × provider group.
 *
 * The grain is deliberately the group, not the bucket: rolling providers up
 * before export would throw away the split the user opened the report to see,
 * and a spreadsheet can always sum a column back.
 *
 * `?? 0` rather than `|| 0` on the token counts, because a real zero is a fact
 * worth exporting and `||` would erase it the same way it erases undefined.
 * `cost_usd` falls back to empty instead: a missing price is not a free turn,
 * and a 0 in that column would read as one. `cost_source` says which it is.
 */
export function usageReportToCsv(report) {
  const headers = [
    "bucket",
    "provider",
    "model",
    "input",
    "cached_input",
    "cache_write",
    "output",
    "total",
    "cost_usd",
    "cost_source",
    "turns",
  ];
  const lines = [headers.join(",")];
  for (const bucket of report?.buckets || []) {
    for (const group of bucket.groups || []) {
      lines.push(
        [
          bucket.key,
          group.provider,
          group.model || "",
          group.input ?? 0,
          group.cached_input ?? 0,
          group.cache_write ?? 0,
          group.output ?? 0,
          group.total ?? 0,
          group.cost_usd ?? "",
          group.cost_source || "",
          group.turns ?? 0,
        ]
          .map(csvEscape)
          .join(",")
      );
    }
  }
  // Trailing newline: POSIX-shaped, and some parsers drop a final line without it.
  return lines.join("\n") + "\n";
}

/**
 * Trigger a download in the browser. No-op when `document` is absent (tests).
 *
 * Returns the CSV either way, which is what lets a test drive the real export
 * path instead of a stand-in that could drift from it.
 */
export function downloadUsageCsv(report, filename = "usage.csv") {
  const csv = usageReportToCsv(report);
  if (typeof document === "undefined") return csv;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // Revoked immediately: the click has already handed the blob to the download,
  // and an un-revoked object URL pins its data for the lifetime of the document.
  URL.revokeObjectURL(url);
  return csv;
}
