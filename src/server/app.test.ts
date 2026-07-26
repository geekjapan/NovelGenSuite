import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateMock, type Generate } from "../core/pipeline/mock-llm.js";
import { readProjectState, writeProjectState } from "../core/store/state-json.js";
import { createApp } from "./app.js";

const project = async (
  app: ReturnType<typeof createApp>,
  configuration?: { chapterCount: number; chapterLength?: number },
) => {
  const response = await app.request("/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "月面都市の最後の書店", configuration }),
  });
  assert.equal(response.status, 201);
  return response.json() as Promise<any>;
};

test("mock run completes nine roles and persists manuscript and three Markdown reports", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-gen-suite-"));
  const app = createApp({ projectsRoot: root });
  const created = await project(app);
  assert.equal(created.configuration.chapterCount, 2);

  const response = await app.request(`/projects/${created.id}/run`, { method: "POST" });
  assert.equal(response.status, 200);
  const completed = await response.json();
  assert.deepEqual(completed.agents.map(({ status }: any) => status), Array(9).fill("completed"));
  assert.ok(completed.agents.every(({ startedAt }: any) => startedAt));
  assert.equal(completed.bible.chapters.length, 2);
  assert.ok(completed.bible.chapters.every(({ draft, chapterSummary, continuityNotes }: any) =>
    draft && chapterSummary && continuityNotes.length));
  assert.ok(completed.chapterRuns.every(({ status, lengthStatus }: any) =>
    status === "completed" && lengthStatus));
  assert.match(completed.manuscript, /消印のない夜/);
  assert.ok(completed.bible.editorReport);
  assert.ok(completed.bible.continuityReport);
  assert.ok(completed.bible.publisherPackage);

  for (const file of ["manuscript.md", "editor-report.md", "continuity-report.md", "publisher-report.md"]) {
    assert.ok((await readFile(join(root, created.id, file), "utf8")).startsWith("#"));
  }
  const persisted = JSON.parse(await readFile(join(root, created.id, "state.json"), "utf8"));
  assert.deepEqual(persisted, completed);

  const noOp = await app.request(`/projects/${created.id}/run`, { method: "POST" });
  assert.deepEqual(await noOp.json(), completed);
  assert.ok((await readdir(join(root, created.id))).every((name) => !name.endsWith(".tmp")));
});

test("projects five canonical chapters and keeps length status informational", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-gen-suite-"));
  const app = createApp({ projectsRoot: root });
  const created = await project(app, { chapterCount: 5, chapterLength: 50_000 });
  const response = await app.request(`/projects/${created.id}/run`, { method: "POST" });
  const completed = await response.json();

  assert.equal(completed.bible.chapters.filter(({ draft }: any) => draft).length, 5);
  assert.deepEqual(completed.agents.map(({ status }: any) => status), Array(9).fill("completed"));
  assert.ok(completed.chapterRuns.every(({ lengthStatus }: any) => lengthStatus === "too-short"));
});

test("failed drafting resumes without replacing completed chapters", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-gen-suite-"));
  let failChapterTwo = true;
  const seen: Array<{ chapter?: number; compact: boolean; prior: number }> = [];
  const generate: Generate = async (request) => {
    seen.push({
      chapter: request.chapterNumber,
      compact: request.compact,
      prior: request.context.priorChapterSummaries?.length ?? 0,
    });
    if (failChapterTwo && request.agentId === "drafting" && request.chapterNumber === 2) return "broken";
    return generateMock(request);
  };
  const app = createApp({ projectsRoot: root, generate });
  const created = await project(app);

  const failed = await (await app.request(`/projects/${created.id}/run`, { method: "POST" })).json();
  assert.equal(failed.agents.find(({ id }: any) => id === "drafting").status, "failed");
  const firstDraft = failed.bible.chapters[0].draft;
  assert.equal(failed.bible.chapters[1].draft, undefined);
  assert.deepEqual(seen.filter(({ chapter }) => chapter === 2).map(({ compact }) => compact), [false, true]);

  failChapterTwo = false;
  const resumed = await (await app.request(`/projects/${created.id}/run`, {
    method: "POST",
    body: JSON.stringify({ operation: "retry", chapterNumber: 2 }),
  })).json();
  assert.equal(resumed.bible.chapters[0].draft, firstDraft);
  assert.deepEqual(resumed.agents.map(({ status }: any) => status), Array(9).fill("completed"));
  assert.ok(seen.some(({ chapter, prior }) => chapter === 2 && prior === 1));
});

test("batch drafting records a failed chapter and continues to the next chapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-gen-suite-"));
  const attempted: number[] = [];
  const generate: Generate = async (request) => {
    if (request.agentId === "drafting") {
      attempted.push(request.chapterNumber!);
      if (request.chapterNumber === 2) return "broken";
    }
    return generateMock(request);
  };
  const app = createApp({ projectsRoot: root, generate });
  const created = await project(app, { chapterCount: 3, chapterLength: 100 });
  const failed = await (await app.request(`/projects/${created.id}/run`, { method: "POST" })).json();

  assert.equal(failed.chapterRuns[1].status, "failed");
  assert.equal(failed.chapterRuns[2].status, "completed");
  assert.ok(attempted.includes(3));
  assert.equal(failed.bible.chapters.filter(({ draft }: any) => draft).length, 2);
});

test("failed auto-expansion keeps the generated chapter body and marks manual follow-up", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-gen-suite-"));
  const generate: Generate = async (request) => {
    if (request.agentId === "drafting" && request.operation === "auto-expand") return "broken";
    if (request.agentId === "drafting") {
      return JSON.stringify({
        chapterNumber: request.chapterNumber,
        draft: "短",
        chapterSummary: "要約",
        continuityNotes: ["継続"],
      });
    }
    return generateMock(request);
  };
  const app = createApp({ projectsRoot: root, generate });
  const created = await project(app, { chapterCount: 1, chapterLength: 100 });
  const completed = await (await app.request(`/projects/${created.id}/run`, { method: "POST" })).json();

  assert.equal(completed.chapterRuns[0].status, "completed");
  assert.equal(completed.chapterRuns[0].lengthStatus, "too-short");
  assert.equal(completed.chapterRuns[0].needsExpansion, true);
  assert.equal(completed.bible.chapters.filter(({ draft }: any) => draft).length, 1);
});

test("a sub-75% chapter is auto-expanded once and atomically replaced on success", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-gen-suite-"));
  const draftingOperations: string[] = [];
  const generate: Generate = async (request) => {
    if (request.agentId !== "drafting") return generateMock(request);
    draftingOperations.push(request.operation!);
    return JSON.stringify({
      chapterNumber: request.chapterNumber,
      draft: request.operation === "auto-expand" ? "字".repeat(85) : "短",
      chapterSummary: "要約",
      continuityNotes: ["継続"],
    });
  };
  const app = createApp({ projectsRoot: root, generate });
  const created = await project(app, { chapterCount: 1, chapterLength: 100 });
  const completed = await (await app.request(`/projects/${created.id}/run`, { method: "POST" })).json();

  assert.deepEqual(draftingOperations, ["generate", "auto-expand"]);
  assert.equal(completed.chapterRuns[0].lengthStatus, "near");
  assert.equal(completed.chapterRuns[0].needsExpansion, false);
  assert.equal((await readProjectState(root, created.id))?.chapterRuns[0]?.lengthStatus, "near");
});

test("abort returns running agent and generating chapter to pending with typed attempts", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-gen-suite-"));
  let draftingStarted!: () => void;
  const started = new Promise<void>((resolve) => { draftingStarted = resolve; });
  const generate: Generate = async (request) => {
    if (request.agentId !== "drafting") return generateMock(request);
    draftingStarted();
    await new Promise<void>((_resolve, reject) => {
      request.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")), { once: true });
    });
    throw new Error("unreachable");
  };
  const app = createApp({ projectsRoot: root, generate });
  const created = await project(app, { chapterCount: 1, chapterLength: 100 });
  const running = app.request(`/projects/${created.id}/run`, { method: "POST" });
  await started;

  const aborted = await app.request(`/projects/${created.id}/abort`, { method: "POST" });
  assert.equal(aborted.status, 202);
  await running;

  const persisted = await readProjectState(root, created.id);
  const drafting = persisted?.agents.find(({ id }) => id === "drafting");
  assert.equal(drafting?.status, "pending");
  assert.equal(drafting?.attempts?.at(-1)?.type, "cancellation");
  assert.equal(persisted?.chapterRuns[0]?.status, "pending");
  assert.equal(persisted?.chapterRuns[0]?.attempts?.at(-1)?.type, "cancellation");
});

test("compact retry accepts fenced JSON and duplicate run returns run-conflict", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-gen-suite-"));
  let release!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const releasePromise = new Promise<void>((resolve) => { release = resolve; });
  let first = true;
  const generate: Generate = async (request) => {
    if (request.agentId === "concept" && first) {
      if (!request.compact) return "not json";
      first = false;
      started();
      await releasePromise;
      return `\`\`\`json\n${await generateMock(request)}\n\`\`\``;
    }
    return generateMock(request);
  };
  const app = createApp({ projectsRoot: root, generate });
  const created = await project(app);
  const running = app.request(`/projects/${created.id}/run`, { method: "POST" });
  await startedPromise;
  const conflict = await app.request(`/projects/${created.id}/run`, { method: "POST" });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, "run-conflict");
  release();
  const completed = await running;
  assert.equal(completed.status, 200);
  assert.ok((await completed.json()).agents.every(({ status }: any) => status === "completed"));
});

test("a new server returns an orphaned running role to pending with cancellation metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-gen-suite-"));
  const created = await project(createApp({ projectsRoot: root }));
  const state = (await readProjectState(root, created.id))!;
  state.agents[0] = {
    ...state.agents[0]!,
    status: "running",
    startedAt: new Date().toISOString(),
  };
  await writeProjectState(root, state);

  const restarted = createApp({ projectsRoot: root });
  const recovered = await (await restarted.request(`/projects/${created.id}/state`)).json();
  assert.equal(recovered.agents[0].status, "pending");
  const persisted = await readProjectState(root, created.id);
  assert.equal(persisted?.agents[0]?.attempts?.at(-1)?.type, "cancellation");

  const resumed = await (await restarted.request(`/projects/${created.id}/run`, { method: "POST" })).json();
  assert.ok(resumed.agents.every(({ status }: any) => status === "completed"));
});

test("a corrupted project neither blocks other requests after restart nor appears in the list", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-gen-suite-"));
  const created = await project(createApp({ projectsRoot: root }));
  await mkdir(join(root, "corrupted"));
  await writeFile(join(root, "corrupted", "state.json"), "{ broken", "utf8");

  const restarted = createApp({ projectsRoot: root });
  const state = await restarted.request(`/projects/${created.id}/state`);
  assert.equal(state.status, 200);
  assert.equal((await state.json()).id, created.id);

  const listed = await (await restarted.request("/projects")).json();
  assert.deepEqual(listed.map(({ id }: any) => id), [created.id]);
});

test("zod failure retries compact once, records the role failure, and stops", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-gen-suite-"));
  const attempts: boolean[] = [];
  const generate: Generate = async (request) => {
    attempts.push(request.compact);
    return JSON.stringify({ logline: "incomplete concept" });
  };
  const app = createApp({ projectsRoot: root, generate });
  const created = await project(app);
  const failed = await (await app.request(`/projects/${created.id}/run`, { method: "POST" })).json();

  assert.deepEqual(attempts, [false, true]);
  assert.equal(failed.agents[0].status, "failed");
  assert.equal(failed.agents[0].error, "Agent execution failed");
  assert.ok(failed.agents.slice(1).every(({ status }: any) => status === "pending"));
});

test("persisted agent errors never contain provider secrets or internal paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-gen-suite-"));
  const generate: Generate = async () => {
    throw new Error("/Users/private/client.ts token_xyz_UNRECOGNIZED_SECRET_FORMAT");
  };
  const app = createApp({ projectsRoot: root, generate });
  const created = await project(app);
  const failed = await (await app.request(`/projects/${created.id}/run`, { method: "POST" })).json();

  assert.equal(failed.agents[0].error, "Agent execution failed");
  assert.equal(JSON.stringify(failed).includes("UNRECOGNIZED_SECRET_FORMAT"), false);
  assert.equal(JSON.stringify(failed).includes("/Users/private"), false);
});

test("HTTP API returns stable input and not-found error codes", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-gen-suite-"));
  const app = createApp({ projectsRoot: root });
  const cases = [
    [{ prompt: "story", language: "fr" }, "unsupported-language"],
    [{ prompt: "物語", configuration: { requireApproval: true } }, "unsupported-setting"],
    [{ prompt: "物語", configuration: { chapterCount: 0 } }, "validation-error"],
  ] as const;
  for (const [body, code] of cases) {
    const response = await app.request("/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, code);
  }
  assert.equal((await app.request("/projects/missing/state")).status, 404);
});
