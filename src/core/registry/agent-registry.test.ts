import assert from "node:assert/strict";
import test from "node:test";

import {
  agentDefinitions,
  mergeAgentOutput,
} from "./agent-registry.js";
import { ChapterOutlineOutputSchema } from "../../shared/agent-schemas.js";
import { emptyStoryBible } from "../../shared/story-bible.js";
import { StoryBibleSchema } from "../../shared/story-bible.js";
import {
  canonicalBible,
  canonicalOutputs,
  extractionCases,
} from "../../../test/fixtures/canonical-story.js";

test("agent registry is the single ordered definition of all nine roles", () => {
  const ids = agentDefinitions.map(({ id }) => id);
  assert.deepEqual(ids, [
    "concept",
    "character",
    "worldbuilding",
    "plot",
    "chapter-outline",
    "drafting",
    "editor",
    "continuity",
    "publisher",
  ]);
  assert.equal(new Set(ids).size, ids.length);

  for (const definition of agentDefinitions) {
    const outputs = definition.id === "drafting"
      ? canonicalOutputs.drafting
      : [canonicalOutputs[definition.id]];
    for (const output of outputs) definition.schema.parse(output);
  }
  StoryBibleSchema.parse(canonicalBible);
});

test("continuity advances foreshadowing through planned, unresolved, and paid-off", () => {
  const base = {
    ...canonicalBible,
    foreshadowingTracker: [{
      ...canonicalBible.foreshadowingTracker[0]!,
      status: "planned" as const,
    }],
  };
  const planned = mergeAgentOutput({
    ...base,
    chapters: base.chapters.map((chapter) => ({ ...chapter, draft: undefined })),
  }, "continuity", canonicalOutputs.continuity);
  assert.equal(planned.foreshadowingTracker[0]?.status, "planned");

  const unresolved = mergeAgentOutput(base, "continuity", {
    ...canonicalOutputs.continuity,
    missingPayoffs: [base.foreshadowingTracker[0]!.item],
  });
  assert.equal(unresolved.foreshadowingTracker[0]?.status, "unresolved");

  const paidOff = mergeAgentOutput(base, "continuity", canonicalOutputs.continuity);
  assert.equal(paidOff.foreshadowingTracker[0]?.status, "paid-off");
});

test("chapter outline merge preserves skeleton fields and a user title", () => {
  const bible = emptyStoryBible();
  bible.parts = [{
    id: "part-1",
    number: 1,
    title: "第一部",
    chapters: [{
      id: "chapter-1",
      partNumber: 1,
      number: 1,
      role: "Opening",
      title: "手入力の題名",
      purpose: "仮目的",
      emotionalTurn: "",
      keyEvents: [],
      foreshadowing: [],
      lengthPlan: { target: 1200, unit: "characters", min: 1020, max: 1380 },
    }],
  }];
  bible.chapters = [...bible.parts[0]!.chapters];

  const merged = mergeAgentOutput(bible, "chapter-outline", {
    ...canonicalOutputs["chapter-outline"],
    parts: [{
      ...canonicalOutputs["chapter-outline"].parts[0]!,
      chapters: [{
        ...canonicalOutputs["chapter-outline"].parts[0]!.chapters[0]!,
        number: 9,
        role: "Climax" as const,
        title: "AIの題名",
        lengthPlan: { target: 9999, unit: "characters", min: 1, max: 9999 },
      }],
    }],
  });

  assert.equal(merged.chapters[0]!.id, "chapter-1");
  assert.equal(merged.chapters[0]!.partNumber, 1);
  assert.equal(merged.chapters[0]!.number, 1);
  assert.equal(merged.chapters[0]!.role, "Opening");
  assert.equal(merged.chapters[0]!.title, "手入力の題名");
  assert.deepEqual(merged.chapters[0]!.lengthPlan, {
    target: 1200,
    unit: "characters",
    min: 1020,
    max: 1380,
  });
});

test("chapter outline schema rejects duplicate chapter numbers", () => {
  const definition = agentDefinitions.find(({ id }) => id === "chapter-outline");
  assert.ok(definition);
  const outline = canonicalOutputs["chapter-outline"];
  assert.equal(definition.schema.safeParse({
    ...outline,
    parts: [{
      ...outline.parts[0]!,
      chapters: [outline.parts[0]!.chapters[0]!, {
        ...outline.parts[0]!.chapters[1]!,
        number: outline.parts[0]!.chapters[0]!.number,
      }],
    }],
  }).success, false);
});

test("chapter outline schema normalizes creative arrays to contract limits", () => {
  const outline = canonicalOutputs["chapter-outline"];
  const parsed = ChapterOutlineOutputSchema.parse({
    ...outline,
    parts: [{
      ...outline.parts[0]!,
      chapters: outline.parts[0]!.chapters.map((chapter) => ({
        ...chapter,
        keyEvents: ["出来事1", "出来事2", "出来事3"],
        foreshadowing: ["伏線1", "伏線2"],
      })),
    }],
    foreshadowingTracker: Array.from({ length: 4 }, () =>
      outline.foreshadowingTracker[0]),
  });

  assert.equal(parsed.parts[0]!.chapters[0]!.keyEvents.length, 2);
  assert.equal(parsed.parts[0]!.chapters[0]!.foreshadowing.length, 1);
  assert.equal(parsed.foreshadowingTracker.length, 3);
});

test("malformed extraction fixtures remain separate from canonical outputs", () => {
  assert.deepEqual(extractionCases.map(({ kind }) => kind), [
    "code-fence",
    "preamble",
    "broken-json",
  ]);
  assert.equal(JSON.stringify(canonicalOutputs).includes("```"), false);
});
