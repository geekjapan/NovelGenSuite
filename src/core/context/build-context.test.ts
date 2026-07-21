import assert from "node:assert/strict";
import test from "node:test";

import { agentDefinitions } from "../registry/agent-registry.js";
import { canonicalBible, canonicalOutputs } from "../../../test/fixtures/canonical-story.js";

const definition = (id: string) => {
  const found = agentDefinitions.find((candidate) => candidate.id === id);
  assert.ok(found);
  return found;
};

test("contexts prefer completed output, fall back to Bible, and apply limits", () => {
  const context = definition("worldbuilding").buildContext({
    prompt: `${"前".repeat(700)}中間${"後".repeat(400)}`,
    language: "ja",
    bible: canonicalBible,
    completedOutputs: {
      concept: { ...canonicalOutputs.concept, logline: "完了済み企画" },
      character: {
        ...canonicalOutputs.character,
        supporting: Array.from({ length: 10 }, (_, index) => ({
          ...canonicalOutputs.character.supporting[0]!,
          name: `脇役${index}`,
        })),
      },
    },
  });

  assert.equal(context.concept?.logline, "完了済み企画");
  assert.equal(context.characters?.supporting.length, 8);
  assert.match(context.prompt, /^前+/);
  assert.match(context.prompt, /\n…省略…\n/);
  assert.match(context.prompt, /後+$/);

  const fallback = definition("character").buildContext({
    prompt: "短い依頼",
    language: "ja",
    bible: canonicalBible,
    completedOutputs: { concept: "invalid" },
  });
  assert.equal(fallback.concept?.logline, canonicalBible.concept?.logline);
});

test("drafting chapter two receives compressed outline and prior chapter bridge", () => {
  const context = definition("drafting").buildContext({
    prompt: "雨の夜の郵便局を舞台にした物語",
    language: "ja",
    bible: canonicalBible,
    completedOutputs: {},
    chapterNumber: 2,
  });

  assert.equal(context.targetChapter?.number, 2);
  assert.equal(context.outline?.length, 2);
  assert.deepEqual(context.priorChapterSummaries, [{
    chapterNumber: 1,
    summary: canonicalOutputs.drafting[0]!.chapterSummary,
  }]);
  assert.equal(
    context.previousChapterEnding,
    canonicalOutputs.drafting[0]!.draft.slice(-300),
  );
});
