import assert from "node:assert/strict";
import test from "node:test";

import { chapterProgress, elapsedSeconds } from "./model.js";

test("progress and elapsed time are derived from persisted state", () => {
  assert.equal(chapterProgress([
    { status: "completed" },
    { status: "generating" },
    { status: "pending" },
  ]), "1/3");
  assert.equal(elapsedSeconds("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:03.900Z"), 3);
  assert.equal(elapsedSeconds(undefined, undefined), undefined);
});
