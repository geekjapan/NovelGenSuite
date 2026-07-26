import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateMock, type Generate } from "../core/pipeline/mock-llm.js";
import type { PipelineProjectState } from "../core/pipeline/project-state.js";
import { readProjectState, writeProjectState } from "../core/store/state-json.js";
import { LlmError } from "../core/llm/openai-client.js";
import { createApp } from "./app.js";

const project = async (
  app: ReturnType<typeof createApp>,
  configuration?: {
    chapterCount?: number;
    chapterLength?: number;
    requireApproval?: boolean;
  },
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

test("drafting output failure falls back and can be retried without replacing completed chapters", async () => {
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
  assert.equal(failed.agents.find(({ id }: any) => id === "drafting").status, "completed");
  assert.equal(failed.chapterRuns[1].fallbackUsed, true);
  assert.equal(failed.chapterRuns[1].autoRecovered, true);
  const firstDraft = failed.bible.chapters[0].draft;
  assert.ok(failed.bible.chapters[1].draft);
  assert.deepEqual(
    seen.filter(({ chapter }) => chapter === 2).map(({ compact }) => compact),
    [false, true, false],
  );

  failChapterTwo = false;
  const resumed = await (await app.request(`/projects/${created.id}/run`, {
    method: "POST",
    body: JSON.stringify({ operation: "retry", chapterNumber: 2 }),
  })).json();
  assert.equal(resumed.bible.chapters[0].draft, firstDraft);
  assert.deepEqual(resumed.agents.map(({ status }: any) => status), Array(9).fill("completed"));
  assert.ok(seen.some(({ chapter, prior }) => chapter === 2 && prior === 1));
});

test("batch drafting records a fallback chapter and continues to the next chapter", async () => {
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

  assert.equal(failed.chapterRuns[1].status, "completed");
  assert.equal(failed.chapterRuns[1].fallbackUsed, true);
  assert.equal(failed.chapterRuns[2].status, "completed");
  assert.ok(attempted.includes(3));
  assert.equal(failed.bible.chapters.filter(({ draft }: any) => draft).length, 3);
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
  let cancelled = false;
  const generate: Generate = async (request) => {
    if (request.agentId !== "drafting") return generateMock(request);
    if (cancelled) return generateMock(request);
    draftingStarted();
    await new Promise<void>((_resolve, reject) => {
      request.signal?.addEventListener("abort", () =>
        {
          cancelled = true;
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
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

  const resumed = await (await app.request(`/projects/${created.id}/run`, {
    method: "POST",
  })).json();
  assert.ok(resumed.agents.every(
    ({ status }: PipelineProjectState["agents"][number]) => status === "completed",
  ));
});

test("approval gate stops cleanly, writes an editable outline, and resumes after approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-gen-suite-"));
  const app = createApp({ projectsRoot: root });
  const created = await project(app, {
    chapterCount: 2,
    chapterLength: 100,
    requireApproval: true,
  });

  const waiting = await (await app.request(`/projects/${created.id}/run`, {
    method: "POST",
  })).json();
  assert.equal(waiting.workflow.stage, "approval");
  assert.equal(waiting.workflow.awaitingApproval, true);
  assert.deepEqual(
    waiting.agents.map(
      ({ status }: PipelineProjectState["agents"][number]) => status,
    ),
    [...Array(5).fill("completed"), ...Array(4).fill("pending")],
  );
  const stillWaiting = await (await app.request(`/projects/${created.id}/run`, {
    method: "POST",
  })).json();
  assert.equal(stillWaiting.workflow.awaitingApproval, true);
  assert.ok(stillWaiting.agents.slice(5).every(
    ({ status }: PipelineProjectState["agents"][number]) => status === "pending",
  ));
  const outline = JSON.parse(
    await readFile(join(root, created.id, "chapter-outline.json"), "utf8"),
  );
  outline.parts[0].chapters[0].title = "ユーザーが編集した題名";
  outline.parts[0].chapters[0].lengthPlan = {
    target: 120,
    unit: "characters",
    min: 100,
    max: 140,
  };
  const saved = await app.request(`/projects/${created.id}/outline`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(outline),
  });
  assert.equal(saved.status, 200);
  const approved = await (await app.request(`/projects/${created.id}/approve`, {
    method: "POST",
  })).json();
  assert.equal(approved.workflow.stage, "drafting");
  assert.equal(approved.workflow.awaitingApproval, false);
  assert.equal(approved.bible.chapters[0].title, "ユーザーが編集した題名");
  assert.equal(approved.bible.chapters[0].lengthPlan.target, 120);

  const completed = await (await app.request(`/projects/${created.id}/run`, {
    method: "POST",
  })).json();
  assert.equal(completed.workflow.stage, "final");
  assert.ok(completed.agents.every(
    ({ status }: PipelineProjectState["agents"][number]) => status === "completed",
  ));
  assert.equal((await app.request(`/projects/${created.id}/approve`, {
    method: "POST",
  })).status, 409);
  await app.request(`/projects/${created.id}/stage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stage: "planning", confirmed: true }),
  });
  const revisedPlan = await (await app.request(`/projects/${created.id}/plan/revise`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instruction: "緊張感を高める" }),
  })).json();
  assert.equal(revisedPlan.workflow.stage, "approval");
  assert.equal(revisedPlan.workflow.awaitingApproval, true);
});

test("stage navigation requires confirmation for backtracking and rejects unreached jumps", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-gen-suite-"));
  const app = createApp({ projectsRoot: root });
  const created = await project(app, {
    chapterCount: 1,
    chapterLength: 100,
    requireApproval: true,
  });

  const jump = await app.request(`/projects/${created.id}/stage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stage: "final" }),
  });
  assert.equal(jump.status, 409);
  assert.equal((await jump.json()).error.code, "invalid-transition");

  await app.request(`/projects/${created.id}/run`, { method: "POST" });
  const unconfirmed = await app.request(`/projects/${created.id}/stage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stage: "planning" }),
  });
  assert.equal(unconfirmed.status, 409);

  const confirmed = await app.request(`/projects/${created.id}/stage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stage: "planning", confirmed: true }),
  });
  assert.equal(confirmed.status, 200);
  const moved = await confirmed.json();
  assert.equal(moved.workflow.stage, "planning");
  assert.notEqual(moved.meta.updatedAt, created.meta.updatedAt);
});

test("reapproval preserves only completed and edited chapters", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-gen-suite-"));
  const app = createApp({ projectsRoot: root });
  const created = await project(app, {
    chapterCount: 4,
    chapterLength: 100,
    requireApproval: true,
  });
  await app.request(`/projects/${created.id}/run`, { method: "POST" });
  const state = (await readProjectState(root, created.id))!;
  for (const [index, status] of ([
    "completed",
    "edited",
    "failed",
    "generating",
  ] as const).entries()) {
    state.chapterRuns[index] = {
      ...state.chapterRuns[index]!,
      status,
    };
    state.bible.chapters[index]!.draft = `本文${index + 1}`;
    state.bible.parts[0]!.chapters[index]!.draft = `本文${index + 1}`;
  }
  await writeProjectState(root, state);
  const outline = JSON.parse(
    await readFile(join(root, created.id, "chapter-outline.json"), "utf8"),
  );
  outline.parts[0].chapters[2].id = "client-controlled";
  outline.parts[0].chapters[2].role = "Resolution";
  outline.parts[0].chapters[2].draft = "注入された本文";
  await writeFile(
    join(root, created.id, "chapter-outline.json"),
    JSON.stringify(outline),
    "utf8",
  );

  const approved = await (await app.request(`/projects/${created.id}/approve`, {
    method: "POST",
  })).json();
  assert.deepEqual(
    approved.chapterRuns.map(
      ({ status }: PipelineProjectState["chapterRuns"][number]) => status,
    ),
    ["completed", "edited", "pending", "pending"],
  );
  assert.deepEqual(
    approved.bible.chapters.map(
      ({ draft }: PipelineProjectState["bible"]["chapters"][number]) => draft ?? null,
    ),
    ["本文1", "本文2", null, null],
  );
  assert.equal(approved.bible.chapters[2].id, "chapter-3");
  assert.equal(approved.bible.chapters[2].role, "Development");
});

test("expand, chapter revise, and plan revise accept their typed output contracts", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-gen-suite-"));
  const app = createApp({ projectsRoot: root });
  const created = await project(app, { chapterCount: 1, chapterLength: 100 });
  await app.request(`/projects/${created.id}/run`, { method: "POST" });

  const expanded = await (await app.request(`/projects/${created.id}/run`, {
    method: "POST",
    body: JSON.stringify({ operation: "expand", chapterNumber: 1 }),
  })).json();
  assert.ok(expanded.completedOutputs.drafting.at(-1).expansionSummary);

  const revised = await (await app.request(`/projects/${created.id}/run`, {
    method: "POST",
    body: JSON.stringify({ operation: "revise", chapterNumber: 1 }),
  })).json();
  assert.equal(revised.chapterRuns[0].status, "completed");

  await app.request(`/projects/${created.id}/stage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stage: "planning", confirmed: true }),
  });
  const plan = await (await app.request(`/projects/${created.id}/plan/revise`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instruction: "中盤の緊張感を高める" }),
  })).json();
  assert.equal(plan.workflow.stage, "drafting");
  assert.equal(plan.completedOutputs["plan-revise"].at(-1).structureChanged, false);
});

test("aborting plan revision records typed cancellation and returns its agent to pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-gen-suite-"));
  let revisionStarted!: () => void;
  const started = new Promise<void>((resolve) => { revisionStarted = resolve; });
  const generate: Generate = async (request) => {
    if (request.operation !== "plan-revise") return generateMock(request);
    revisionStarted();
    await new Promise<void>((_resolve, reject) => {
      request.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")), { once: true });
    });
    throw new Error("unreachable");
  };
  const app = createApp({ projectsRoot: root, generate });
  const created = await project(app, { chapterCount: 1, chapterLength: 100 });
  await app.request(`/projects/${created.id}/run`, { method: "POST" });
  await app.request(`/projects/${created.id}/stage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stage: "planning", confirmed: true }),
  });

  const revising = app.request(`/projects/${created.id}/plan/revise`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instruction: "緊張感を高める" }),
  });
  await started;
  assert.equal((await app.request(`/projects/${created.id}/abort`, {
    method: "POST",
  })).status, 202);
  const cancelled = await (await revising).json();
  const outline = cancelled.agents.find(
    ({ id }: PipelineProjectState["agents"][number]) => id === "chapter-outline",
  );
  assert.equal(outline.status, "pending");
  assert.equal(outline.attempts.at(-1).operation, "plan-revise");
});

test("malformed auxiliary output is recorded instead of replaced by a generic fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-gen-suite-"));
  const generate: Generate = async (request) =>
    request.operation === "expand" || request.operation === "plan-revise"
      ? "broken"
      : generateMock(request);
  const app = createApp({ projectsRoot: root, generate });
  const created = await project(app, { chapterCount: 1, chapterLength: 100 });
  const completed = await (await app.request(`/projects/${created.id}/run`, {
    method: "POST",
  })).json();
  const originalDraft = completed.bible.chapters[0].draft;

  const expansion = await (await app.request(`/projects/${created.id}/run`, {
    method: "POST",
    body: JSON.stringify({ operation: "expand", chapterNumber: 1 }),
  })).json();
  assert.equal(expansion.chapterRuns[0].status, "failed");
  assert.equal(expansion.bible.chapters[0].draft, originalDraft);

  await app.request(`/projects/${created.id}/stage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stage: "planning", confirmed: true }),
  });
  const plan = await (await app.request(`/projects/${created.id}/plan/revise`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instruction: "緊張感を高める" }),
  })).json();
  const outline = plan.agents.find(
    ({ id }: PipelineProjectState["agents"][number]) => id === "chapter-outline",
  );
  assert.equal(outline.status, "failed");
  assert.ok(outline.attemptCount);
  assert.ok(outline.lastRetryError);
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
  const stageConflict = await app.request(`/projects/${created.id}/stage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stage: "launcher", confirmed: true }),
  });
  assert.equal(stageConflict.status, 409);
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

test("zod failure retries compact once, applies local fallback, and continues", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-gen-suite-"));
  const attempts: boolean[] = [];
  const generate: Generate = async (request) => {
    if (request.agentId === "concept") {
      attempts.push(request.compact);
      return JSON.stringify({ logline: "incomplete concept" });
    }
    return generateMock(request);
  };
  const app = createApp({ projectsRoot: root, generate });
  const created = await project(app);
  const failed = await (await app.request(`/projects/${created.id}/run`, { method: "POST" })).json();

  assert.deepEqual(attempts, [false, true]);
  assert.equal(failed.agents[0].status, "completed");
  assert.equal(failed.agents[0].fallbackUsed, true);
  assert.equal(failed.agents[0].autoRecovered, true);
  assert.ok(failed.agents.slice(1).every(({ status }: any) => status === "completed"));
});

test("persisted agent errors never contain provider secrets or internal paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-gen-suite-"));
  const generate: Generate = async () => {
    throw new Error("/Users/private/client.ts token_xyz_UNRECOGNIZED_SECRET_FORMAT");
  };
  const app = createApp({ projectsRoot: root, generate });
  const created = await project(app);
  const failed = await (await app.request(`/projects/${created.id}/run`, { method: "POST" })).json();

  assert.match(failed.agents[0].error, /もう一度実行/);
  assert.equal(JSON.stringify(failed).includes("UNRECOGNIZED_SECRET_FORMAT"), false);
  assert.equal(JSON.stringify(failed).includes("/Users/private"), false);
});

test("HTTP API returns stable input and not-found error codes", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-gen-suite-"));
  const app = createApp({ projectsRoot: root });
  const cases = [
    [{ prompt: "story", language: "fr" }, "unsupported-language"],
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

test("chapter length warning thresholds are non-blocking at Japanese and English boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-gen-suite-"));
  const app = createApp({ projectsRoot: root });
  for (const [language, threshold, unit] of [
    ["ja", 8_000, "characters"],
    ["en", 3_000, "words"],
  ] as const) {
    for (const [chapterLength, warningCount] of [[threshold, 0], [threshold + 1, 1]] as const) {
      const response = await app.request("/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "story",
          language,
          configuration: { chapterCount: 1, chapterLength },
        }),
      });
      assert.equal(response.status, 201);
      const created = await response.json();
      assert.equal(created.warnings.length, warningCount);
      if (warningCount) {
        assert.equal(created.warnings[0].code, "chapter-length-high");
        assert.equal(created.warnings[0].threshold, threshold);
        assert.equal(created.warnings[0].unit, unit);
      }
    }
  }
});

test("draft generation timeout keeps chapter number and actionable advice in the error contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-gen-suite-"));
  const generate: Generate = async (request) => {
    if (request.agentId === "drafting") {
      throw new LlmError("OpenAI request timed out", true, "timeout");
    }
    return generateMock(request);
  };
  const app = createApp({ projectsRoot: root, generate });
  const created = await project(app, { chapterCount: 1, chapterLength: 100 });
  const failed = await (await app.request(`/projects/${created.id}/run`, { method: "POST" })).json();

  assert.match(failed.chapterRuns[0].error, /第1章/);
  assert.match(failed.chapterRuns[0].error, /章長を減らす/);
  assert.match(failed.chapterRuns[0].error, /モデルを変更/);
  assert.equal(failed.agents.find(({ id }: any) => id === "drafting").error, failed.chapterRuns[0].error);
});

test("auto-expansion timeout keeps its operation and advice while preserving coverage", async () => {
  const root = await mkdtemp(join(tmpdir(), "novel-gen-suite-"));
  const generate: Generate = async (request) => {
    if (request.agentId === "drafting" && request.operation === "auto-expand") {
      throw new LlmError("OpenAI request timed out", true, "timeout");
    }
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
  assert.match(completed.chapterRuns[0].error, /第1章の自動拡張/);
  assert.match(completed.chapterRuns[0].error, /章長を減らす/);
  assert.match(completed.chapterRuns[0].error, /モデルを変更/);
  assert.equal(completed.bible.chapters.filter(({ draft }: any) => draft).length, 1);
});
