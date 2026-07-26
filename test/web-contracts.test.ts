import assert from "node:assert/strict";
import test from "node:test";

import {
  ProjectListResponseSchema,
  WebProjectStateSchema,
} from "../src/shared/contracts.js";

const createdAt = "2026-07-21T00:00:00.000Z";

test("web response schemas validate and project persisted state", () => {
  const project = WebProjectStateSchema.parse({
    id: "project-1",
    prompt: "月面都市の最後の書店",
    language: "ja",
    configuration: {},
    meta: { schemaVersion: 1, createdAt, updatedAt: createdAt },
    agents: [{ id: "concept", status: "completed", completedOutputs: "ignored" }],
    chapterRuns: [{ chapterNumber: 1, status: "completed" }],
    manuscript: null,
    bible: {
      editorReport: null,
      continuityReport: null,
      publisherPackage: null,
      chapters: [],
    },
    completedOutputs: {},
  });

  assert.deepEqual(Object.keys(project), ["id", "prompt", "meta", "warnings", "agents", "chapterRuns", "manuscript", "bible"]);
  assert.deepEqual(project.warnings, []);
  assert.deepEqual(project.agents, [{ id: "concept", status: "completed" }]);
  assert.deepEqual(project.chapterRuns, [{ status: "completed" }]);
  assert.deepEqual(ProjectListResponseSchema.parse([{ id: project.id, createdAt }]), [{ id: "project-1", createdAt }]);
  assert.equal(WebProjectStateSchema.safeParse({ ...project, agents: [{ id: "concept", status: "unknown" }] }).success, false);
});
