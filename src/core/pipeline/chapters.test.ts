import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyLength,
  hasChapterCoverage,
  measuredLength,
  selectChapterNumbers,
} from "./chapters.js";
import { initializePipelineState } from "./project-state.js";

const state = () => initializePipelineState({
  id: "chapter-rules",
  prompt: "story",
  language: "ja",
  configuration: { chapterCount: 4, chapterLength: 100, requireApproval: false },
  meta: {
    schemaVersion: 1,
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
  },
});

test("75%, 85%, and 85-115% boundaries are deterministic", () => {
  const plan = { target: 100, min: 85, max: 115, unit: "characters" as const };
  assert.equal(classifyLength(plan, "字".repeat(74)), "too-short");
  assert.equal(classifyLength(plan, "字".repeat(75)), "under");
  assert.equal(classifyLength(plan, "字".repeat(84)), "under");
  assert.equal(classifyLength(plan, "字".repeat(85)), "near");
  assert.equal(classifyLength(plan, "字".repeat(115)), "near");
  assert.equal(classifyLength(plan, "字".repeat(116)), "over");

  assert.equal(measuredLength("one two\nthree", "words"), 3);
  assert.equal(measuredLength(" 一 二\n三 ", "characters"), 3);
});

test("language policy assigns word plans to English projects", () => {
  const project = initializePipelineState({
    id: "english-length",
    prompt: "story",
    language: "en",
    configuration: { chapterCount: 1, chapterLength: 100, requireApproval: false },
    meta: {
      schemaVersion: 1,
      createdAt: "2026-07-26T00:00:00.000Z",
      updatedAt: "2026-07-26T00:00:00.000Z",
    },
  });
  assert.equal(project.bible.chapters[0]?.lengthPlan.unit, "words");
  assert.equal(classifyLength(project.bible.chapters[0]!.lengthPlan, "word ".repeat(85)), "near");
});

test("chapter selection applies one operation-aware priority rule", () => {
  const project = state();
  project.bible.chapters[0]!.draft = "字".repeat(85);
  project.bible.chapters[2]!.draft = "字".repeat(80);
  project.bible.chapters[3]!.draft = "字".repeat(74);
  project.chapterRuns[0]!.status = "completed";
  project.chapterRuns[2]!.status = "failed";
  project.chapterRuns[3]!.status = "completed";
  project.chapterRuns[3]!.needsExpansion = true;

  assert.deepEqual(selectChapterNumbers(project, { type: "resume" }), [2]);
  assert.deepEqual(selectChapterNumbers(project, { type: "retry", chapterNumber: 1 }), []);
  assert.deepEqual(selectChapterNumbers(project, { type: "retry", chapterNumber: 3 }), [3]);
  assert.deepEqual(selectChapterNumbers(project, { type: "retry", chapterNumber: 4 }), [4]);
  assert.deepEqual(selectChapterNumbers(project, { type: "regenerate", chapterNumber: 1 }), [1]);
});

test("coverage counts chapters with bodies rather than successful responses or statuses", () => {
  const project = state();
  project.bible.chapters.forEach((chapter) => { chapter.draft = "本文"; });
  project.chapterRuns.forEach((run) => { run.status = "failed"; });
  assert.equal(hasChapterCoverage(project), true);

  delete project.bible.chapters[3]!.draft;
  assert.equal(hasChapterCoverage(project), false);
});
