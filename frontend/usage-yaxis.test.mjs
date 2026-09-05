// y-axis ticks must track the chart scale. Hard-coded 2–10M ticks on a ~750M
// chart pile every label into the bottom few pixels (and into the date row).

import test from "node:test";
import assert from "node:assert/strict";

import { yAxisTicks } from "./shared/usage-model.js";

test("y-axis ticks spread across a hundreds-of-millions scale", () => {
  const ticks = yAxisTicks(750_000_000, null);
  assert.ok(ticks.length >= 2, `expected several ticks, got ${ticks}`);
  assert.ok(
    ticks.every((v) => v / 750_000_000 >= 0.08),
    `ticks must clear the x-label band: ${ticks}`
  );
  assert.ok(
    !ticks.includes(2_000_000) && !ticks.includes(10_000_000),
    `must not keep 2–10M ticks on a 750M scale: ${ticks}`
  );
  const top = ticks[ticks.length - 1];
  assert.ok(top >= 200_000_000, `top tick should be in the hundreds of M: ${ticks}`);
});

test("y-axis ticks stay round on a small day scale", () => {
  const ticks = yAxisTicks(5_000_000, 5_000_000);
  assert.ok(ticks.includes(5_000_000), "daily cap remains on the axis");
  assert.ok(ticks.every((v) => v > 0 && v <= 5_000_000));
});

test("y-axis always keeps a near-round user-set cap label", () => {
  // 4.1M sits next to the ordinary 4M step; omitting the cap leaves a dashed
  // quota line next to a 4M label that reads as the wrong number.
  const ticks = yAxisTicks(5_000_000, 4_100_000);
  assert.ok(ticks.includes(4_100_000), `cap must stay on the axis, got ${ticks}`);
  assert.ok(
    !ticks.includes(4_000_000),
    `nearby ordinary tick must yield to the cap label, got ${ticks}`
  );
});

test("y-axis keeps a user-set cap even when it sits below the ordinary-tick floor", () => {
  // Historical spend can dwarf a newly lowered quota. Ordinary ticks still skip
  // the bottom 8%, but the dashed quota line must keep its own label.
  const ticks = yAxisTicks(100_000_000, 5_000_000);
  assert.ok(ticks.includes(5_000_000), `low relative cap must stay labeled, got ${ticks}`);
});
