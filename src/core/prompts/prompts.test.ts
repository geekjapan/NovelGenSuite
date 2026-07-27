import assert from "node:assert/strict";
import test from "node:test";

import { canonicalBible } from "../../../test/fixtures/canonical-story.js";
import { agentDefinitions, type AgentId } from "../registry/agent-registry.js";
import { buildPrompt, promptAgentIds } from "./prompts.js";

const input = {
  prompt: "雨の夜の郵便局を舞台にした物語",
  language: "ja" as const,
  bible: canonicalBible,
  completedOutputs: {},
};

test("all nine prompts share the JSON and language contract", () => {
  assert.deepEqual(promptAgentIds, agentDefinitions.map(({ id }) => id));

  for (const definition of agentDefinitions) {
    const context = definition.buildContext({
      ...input,
      chapterNumber: definition.id === "drafting" ? 1 : undefined,
    });
    const prompt = buildPrompt({
      agentId: definition.id,
      context,
      chapterCount: 2,
      chapterNumber: definition.id === "drafting" ? 1 : undefined,
      compact: false,
    });

    assert.match(prompt.system, /valid JSON only/);
    assert.match(prompt.system, /JSON keys.*English/);
    assert.match(prompt.system, /values.*Japanese/);
    assert.match(prompt.system, /markdown/i);
    assert.match(prompt.user, new RegExp(`ROLE=${definition.id}`));
    assert.match(prompt.user, /CONTEXT=/);
  }
});

test("chapter outline sends the deterministic skeleton and compact retry is smaller", () => {
  const definition = agentDefinitions.find(({ id }) => id === "chapter-outline")!;
  const context = definition.buildContext(input);
  const regular = buildPrompt({
    agentId: "chapter-outline",
    context,
    chapterCount: 2,
    compact: false,
  });
  const compact = buildPrompt({
    agentId: "chapter-outline",
    context,
    chapterCount: 2,
    compact: true,
  });

  for (const chapter of canonicalBible.chapters) {
    assert.match(regular.user, new RegExp(`"number":${chapter.number}`));
    assert.match(regular.user, new RegExp(`"target":${chapter.lengthPlan.target}`));
  }
  assert.match(regular.user, /must not change id, partNumber, number, role, or lengthPlan/);
  assert.match(regular.user, /keyEvents と foreshadowing は配列/);
  assert.match(regular.user, /styleGuide は必須オブジェクト/);
  assert.match(regular.user, /foreshadowingTracker は配列/);
  assert.match(regular.user, /status は planned, unresolved, paid-off/);
  assert.match(compact.user, /COMPACT RETRY/);
  assert.ok(compact.user.length < regular.user.length);
});

test("character prompt requires supporting characters as an array", () => {
  const definition = agentDefinitions.find(({ id }) => id === "character")!;
  const prompt = buildPrompt({
    agentId: "character",
    context: definition.buildContext(input),
    chapterCount: 2,
    compact: false,
  });

  assert.match(prompt.user, /supporting は人物の配列/);
});

test("drafting prompt requires continuity notes as an array", () => {
  const definition = agentDefinitions.find(({ id }) => id === "drafting")!;
  const prompt = buildPrompt({
    agentId: "drafting",
    context: definition.buildContext({ ...input, chapterNumber: 1 }),
    chapterCount: 2,
    chapterNumber: 1,
    compact: false,
  });

  assert.match(prompt.user, /continuityNotes は文字列の配列/);
});

test("continuity prompt states issue enums and array fields", () => {
  const definition = agentDefinitions.find(({ id }) => id === "continuity")!;
  const prompt = buildPrompt({
    agentId: "continuity",
    context: definition.buildContext({ ...input, manuscript: "本文" }),
    chapterCount: 2,
    compact: false,
  });

  assert.match(prompt.user, /category は character, world, plot, time, foreshadowing/);
  assert.match(prompt.user, /severity は low, medium, high/);
  assert.match(prompt.user, /unresolvedForeshadowing と missingPayoffs は文字列の配列/);
});

test("each role asks only for its declared English JSON keys", () => {
  const expected: Record<AgentId, string[]> = {
    concept: ["logline", "coreTheme", "centralConflict", "emotionalPromise", "uniqueHook"],
    character: ["protagonist", "antagonist", "supporting"],
    worldbuilding: ["setting", "rules", "socialContext", "atmosphere", "locations", "symbols"],
    plot: ["beginning", "middle", "climax", "ending", "twists", "foreshadowingPlan"],
    "chapter-outline": ["parts", "styleGuide", "foreshadowingTracker"],
    drafting: ["chapterNumber", "draft", "chapterSummary", "continuityNotes"],
    editor: ["strengths", "weakPoints", "pacing", "dialogue", "emotionalClarity", "revisionSuggestions"],
    continuity: ["issues", "unresolvedForeshadowing", "missingPayoffs", "overallAssessment"],
    publisher: ["titleIdeas", "shortSynopsis", "longSynopsis", "logline", "tagline", "socialPosts", "submissionDescription"],
  };

  for (const id of promptAgentIds) {
    const definition = agentDefinitions.find(({ id: candidate }) => candidate === id)!;
    const prompt = buildPrompt({
      agentId: id,
      context: definition.buildContext({ ...input, chapterNumber: id === "drafting" ? 1 : undefined }),
      chapterCount: 2,
      chapterNumber: id === "drafting" ? 1 : undefined,
      compact: false,
    });
    for (const key of expected[id]) assert.match(prompt.user, new RegExp(`\\b${key}\\b`));
  }
});

test("creative output language follows the project language", () => {
  const context = agentDefinitions[0].buildContext({ ...input, language: "en" });
  const prompt = buildPrompt({
    agentId: "concept",
    context,
    chapterCount: 1,
    compact: false,
  });
  assert.match(prompt.system, /creative text values must be English/);
});

test("drafting guidance derives the 90% minimum and 120% preferred maximum in each unit", () => {
  for (const [language, unit] of [["ja", "characters"], ["en", "words"]] as const) {
    const bible = structuredClone(canonicalBible);
    bible.chapters[0]!.lengthPlan = { target: 1_000, min: 850, max: 1_150, unit };
    const context = agentDefinitions[5].buildContext({
      ...input,
      language,
      bible,
      chapterNumber: 1,
    });
    const prompt = buildPrompt({
      agentId: "drafting",
      context,
      chapterCount: 2,
      chapterNumber: 1,
      operation: "generate",
      compact: false,
    });

    assert.match(prompt.user, new RegExp(`LENGTH GUIDANCE: minimum=900 ${unit}`));
    assert.match(prompt.user, new RegExp(`preferredMaximum=1200 ${unit}`));
  }
});
