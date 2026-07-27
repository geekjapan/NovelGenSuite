import assert from "node:assert/strict";
import test from "node:test";

import { canonicalOutputs } from "../../../test/fixtures/canonical-story.js";
import { generateMock } from "./mock-llm.js";

const request = {
  context: { language: "ja" as const, prompt: "物語" },
  compact: false,
};

test("two-chapter mock returns the canonical fixture unchanged", async () => {
  const outline = JSON.parse(await generateMock({
    ...request,
    agentId: "chapter-outline",
    chapterCount: 2,
  }));
  assert.deepEqual(outline, canonicalOutputs["chapter-outline"]);
});

test("larger mock projection varies only chapter number, role, title, and summary", async () => {
  const outline = JSON.parse(await generateMock({
    ...request,
    agentId: "chapter-outline",
    chapterCount: 5,
  }));
  const templates = canonicalOutputs["chapter-outline"].parts[0]!.chapters;
  for (const [index, chapter] of outline.parts[0].chapters.entries()) {
    const template = templates[index % templates.length]!;
    const { number, role, title, ...stable } = chapter;
    const {
      number: _templateNumber,
      role: _templateRole,
      title: _templateTitle,
      ...expected
    } = template;
    assert.deepEqual(stable, expected);
    assert.equal(number, index + 1);
    assert.ok(role);
    assert.ok(title);
  }

  const draft = JSON.parse(await generateMock({
    ...request,
    agentId: "drafting",
    chapterCount: 5,
    chapterNumber: 3,
  }));
  const template = canonicalOutputs.drafting[0]!;
  const { chapterNumber, chapterSummary, ...stable } = draft;
  const {
    chapterNumber: _templateNumber,
    chapterSummary: _templateSummary,
    ...expected
  } = template;
  assert.deepEqual(stable, expected);
  assert.equal(chapterNumber, 3);
  assert.notEqual(chapterSummary, template.chapterSummary);
});
