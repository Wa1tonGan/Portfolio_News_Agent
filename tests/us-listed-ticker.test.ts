import assert from "node:assert/strict";
import test from "node:test";
import { isSupportedUsListedTicker, normalizeUsListedTicker } from "../lib/us-listed-ticker.ts";

test("US-listed ticker scope accepts common symbols, ADRs, and share classes", () => {
  ["AAPL", "GOOGL", "BABA", "BRK.B", "BF-B"].forEach((ticker) => assert.equal(isSupportedUsListedTicker(ticker), true));
  assert.equal(normalizeUsListedTicker(" brk.b "), "BRK.B");
});

test("US-listed ticker scope rejects obvious non-US exchange symbols", () => {
  ["0700.HK", "AIR.PA", "9988.HK", "7203.T", "", "AAPL US"].forEach((ticker) => assert.equal(isSupportedUsListedTicker(ticker), false));
});
