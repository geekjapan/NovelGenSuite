import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "./app.js";

test("HTTP API creates, persists, lists, reads, and runs a project", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-gen-suite-"));
  const app = createApp({ projectsRoot: root });

  const createdResponse = await app.request("/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "月面都市の最後の書店" }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.language, "ja");
  assert.deepEqual(created.configuration, {
    chapterCount: 1,
    chapterLength: 2000,
    requireApproval: false,
  });
  assert.equal(created.meta.schemaVersion, 1);

  const persisted = JSON.parse(
    await readFile(join(root, created.id, "state.json"), "utf8"),
  );
  assert.deepEqual(persisted, created);

  const stateResponse = await app.request(`/projects/${created.id}/state`);
  assert.equal(stateResponse.status, 200);
  assert.deepEqual(await stateResponse.json(), created);

  const listResponse = await app.request("/projects");
  assert.equal(listResponse.status, 200);
  assert.deepEqual(await listResponse.json(), [
    { id: created.id, createdAt: created.meta.createdAt },
  ]);

  const runResponse = await app.request(`/projects/${created.id}/run`, {
    method: "POST",
  });
  assert.equal(runResponse.status, 200);
  assert.deepEqual(await runResponse.json(), created);
});

test("HTTP API returns stable error codes", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-gen-suite-"));
  const app = createApp({ projectsRoot: root });

  const cases = [
    {
      body: { prompt: "story", language: "en" },
      status: 400,
      code: "unsupported-language",
    },
    {
      body: { prompt: "物語", configuration: { requireApproval: true } },
      status: 400,
      code: "unsupported-setting",
    },
    {
      body: { prompt: "物語", configuration: { chapterCount: 0 } },
      status: 400,
      code: "validation-error",
    },
  ] as const;

  for (const expected of cases) {
    const response = await app.request("/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(expected.body),
    });
    assert.equal(response.status, expected.status);
    assert.equal((await response.json()).error.code, expected.code);
  }

  const missing = await app.request("/projects/missing/state");
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "project-not-found");
});
