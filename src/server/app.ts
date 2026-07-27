import { Hono } from "hono";
import { z } from "zod";

import {
  executePipeline,
  revisePlan,
  RunConflictError,
} from "../core/pipeline/execute.js";
import { hasChapterCoverage } from "../core/pipeline/chapters.js";
import type { Generate } from "../core/pipeline/mock-llm.js";
import {
  approveChapterOutline,
  InvalidWorkflowTransitionError,
  moveToReachedStage,
  PipelineProjectStateSchema,
} from "../core/pipeline/project-state.js";
import {
  createProject,
  listProjects,
  readProjectState,
  writeProjectState,
} from "../core/store/state-json.js";
import {
  ChapterOutlineOutputSchema,
} from "../shared/agent-schemas.js";
import {
  CreateProjectRequestSchema,
  findLanguagePolicy,
  WorkflowStageSchema,
  type ErrorCode,
  type ErrorEnvelope,
  type SupportedLanguage,
} from "../shared/contracts.js";
import {
  createPipelineRuntime,
  readApprovalArtifact,
  reconcileOrphanedRuns,
  writeApprovalArtifact,
} from "./pipeline-runtime.js";

function error(code: ErrorCode, message: string): ErrorEnvelope {
  return { error: { code, message } };
}

export function createApp({
  projectsRoot,
  generate,
  alternateGenerate,
}: {
  projectsRoot: string;
  generate?: Generate;
  alternateGenerate?: Generate;
}) {
  const app = new Hono();
  const reconciliation = reconcileOrphanedRuns(projectsRoot);
  const pipelineRuntime = createPipelineRuntime(projectsRoot);
  const activeRuns = new Map<string, AbortController>();
  const RunRequestSchema = z.discriminatedUnion("operation", [
    z.object({ operation: z.literal("resume") }),
    z.object({
      operation: z.literal("rerun-final"),
      agent: z.enum(["editor", "continuity", "publisher"]),
    }),
    z.object({
      operation: z.enum(["retry", "regenerate", "expand", "revise"]),
      chapterNumber: z.number().int().positive(),
      instruction: z.string().trim().max(2_000).optional(),
    }),
  ]).default({ operation: "resume" });
  const StageRequestSchema = z.object({
    stage: WorkflowStageSchema,
    confirmed: z.boolean().default(false),
  });
  const PlanRevisionRequestSchema = z.object({
    instruction: z.string().trim().min(1).max(2_000),
  });

  app.use("*", async (_context, next) => {
    await reconciliation;
    await next();
  });

  app.post("/projects", async (context) => {
    let json: unknown;
    try {
      json = await context.req.json();
    } catch {
      return context.json(error("validation-error", "JSON が不正です。"), 400);
    }

    const result = CreateProjectRequestSchema.safeParse(json);
    if (!result.success) {
      return context.json(error("validation-error", "入力内容を確認してください。"), 400);
    }
    if (!findLanguagePolicy(result.data.language)) {
      return context.json(error("unsupported-language", "指定された言語には対応していません。"), 400);
    }
    const state = await createProject(projectsRoot, {
      ...result.data,
      language: result.data.language as SupportedLanguage,
    });
    return context.json(state, 201);
  });

  app.get("/projects", async (context) =>
    context.json(await listProjects(projectsRoot)),
  );

  app.get("/projects/:id/state", async (context) => {
    const state = await readProjectState(projectsRoot, context.req.param("id"));
    return state
      ? context.json(state)
      : context.json(error("project-not-found", "プロジェクトが見つかりません。"), 404);
  });

  app.post("/projects/:id/stage", async (context) => {
    const id = context.req.param("id");
    const state = await readProjectState(projectsRoot, id);
    if (!state) return context.json(error("project-not-found", "プロジェクトが見つかりません。"), 404);
    if (activeRuns.has(id) || state.agents.some(({ status }) => status === "running")) {
      return context.json(error("run-conflict", "パイプラインは実行中です。"), 409);
    }
    const request = StageRequestSchema.safeParse(await context.req.json().catch(() => undefined));
    if (!request.success) {
      return context.json(error("validation-error", "段階遷移を確認してください。"), 400);
    }
    try {
      const next = PipelineProjectStateSchema.parse(moveToReachedStage(
        state,
        request.data.stage,
        request.data.confirmed,
      ));
      await writeProjectState(projectsRoot, next);
      return context.json(next);
    } catch (cause) {
      if (cause instanceof InvalidWorkflowTransitionError) {
        return context.json(error(
          "invalid-transition",
          cause.message === "confirmation-required"
            ? "前の段階へ戻るには確認が必要です。"
            : "未到達の段階へは移動できません。",
        ), 409);
      }
      throw cause;
    }
  });

  app.put("/projects/:id/outline", async (context) => {
    const id = context.req.param("id");
    const state = await readProjectState(projectsRoot, id);
    if (!state) return context.json(error("project-not-found", "プロジェクトが見つかりません。"), 404);
    if (
      !["approval", "planning"].includes(state.workflow.stage)
      || state.agents.find(({ id: agentId }) => agentId === "chapter-outline")?.status !== "completed"
    ) {
      return context.json(error("invalid-transition", "章構成はまだ承認できません。"), 409);
    }
    if (activeRuns.has(id) || state.agents.some(({ status }) => status === "running")) {
      return context.json(error("run-conflict", "パイプラインは実行中です。"), 409);
    }
    const outline = ChapterOutlineOutputSchema.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!outline.success) {
      return context.json(error("validation-error", "章構成を確認してください。"), 400);
    }
    await writeApprovalArtifact(projectsRoot, state, outline.data);
    return context.json(outline.data);
  });

  app.post("/projects/:id/approve", async (context) => {
    const id = context.req.param("id");
    const state = await readProjectState(projectsRoot, id);
    if (!state) return context.json(error("project-not-found", "プロジェクトが見つかりません。"), 404);
    if (
      !["approval", "planning"].includes(state.workflow.stage)
      || state.agents.find(({ id: agentId }) => agentId === "chapter-outline")?.status !== "completed"
    ) {
      return context.json(error("invalid-transition", "章構成はまだ承認できません。"), 409);
    }
    if (activeRuns.has(id) || state.agents.some(({ status }) => status === "running")) {
      return context.json(error("run-conflict", "パイプラインは実行中です。"), 409);
    }
    try {
      const next = PipelineProjectStateSchema.parse(approveChapterOutline(
        state,
        await readApprovalArtifact(projectsRoot, id),
      ));
      await writeProjectState(projectsRoot, next);
      return context.json(next);
    } catch (cause) {
      if (
        cause instanceof InvalidWorkflowTransitionError
        || cause instanceof z.ZodError
        || cause instanceof SyntaxError
        || cause instanceof Error && "code" in cause && cause.code === "ENOENT"
      ) {
        return context.json(error("validation-error", "章構成を確認してください。"), 400);
      }
      throw cause;
    }
  });

  app.post("/projects/:id/plan/revise", async (context) => {
    const id = context.req.param("id");
    if (activeRuns.has(id)) {
      return context.json(error("run-conflict", "パイプラインは実行中です。"), 409);
    }
    const controller = new AbortController();
    activeRuns.set(id, controller);
    try {
      const state = await readProjectState(projectsRoot, id);
      if (!state) return context.json(error("project-not-found", "プロジェクトが見つかりません。"), 404);
      if (state.agents.some(({ status }) => status === "running")) {
        return context.json(error("run-conflict", "パイプラインは実行中です。"), 409);
      }
      if (
        state.workflow.stage !== "planning"
        || state.agents.find(({ id: agentId }) => agentId === "chapter-outline")?.status !== "completed"
      ) {
        return context.json(error("invalid-transition", "計画段階へ戻ってから改稿してください。"), 409);
      }
      const request = PlanRevisionRequestSchema.safeParse(
        await context.req.json().catch(() => undefined),
      );
      if (!request.success) {
        return context.json(error("validation-error", "改稿指示を入力してください。"), 400);
      }
      return context.json(await revisePlan(
        state,
        pipelineRuntime,
        request.data.instruction,
        generate,
        controller.signal,
      ));
    } finally {
      activeRuns.delete(id);
    }
  });

  app.post("/projects/:id/run", async (context) => {
    const id = context.req.param("id");
    if (activeRuns.has(id)) return context.json(error("run-conflict", "パイプラインは実行中です。"), 409);
    const controller = new AbortController();
    activeRuns.set(id, controller);
    try {
      const state = await readProjectState(projectsRoot, id);
      if (!state) return context.json(error("project-not-found", "プロジェクトが見つかりません。"), 404);
      const raw = await context.req.text();
      let json: unknown = undefined;
      try {
        json = raw ? JSON.parse(raw) : undefined;
      } catch {
        return context.json(error("validation-error", "JSON が不正です。"), 400);
      }
      const request = RunRequestSchema.safeParse(json);
      if (!request.success) {
        return context.json(error("validation-error", "実行操作を確認してください。"), 400);
      }
      if (request.data.operation === "rerun-final") {
        const finalAgentId = request.data.agent;
        const finalAgent = state.agents.find(({ id: agentId }) =>
          agentId === finalAgentId);
        if (
          state.workflow.stage !== "final"
          || !hasChapterCoverage(state)
          || finalAgent?.status !== "completed"
        ) {
          return context.json(error(
            "invalid-transition",
            "完了済みの仕上げ工程だけを再実行できます。",
          ), 409);
        }
      }
      return context.json(await executePipeline(state, pipelineRuntime, generate, {
        chapterOperation: request.data.operation === "resume"
          ? { type: "resume" }
          : request.data.operation === "rerun-final"
            ? { type: "resume" }
          : {
            type: request.data.operation,
            chapterNumber: request.data.chapterNumber,
            instruction: request.data.instruction,
          },
        finalAgent: request.data.operation === "rerun-final" ? request.data.agent : undefined,
        signal: controller.signal,
        alternateGenerate,
      }));
    } catch (cause) {
      if (cause instanceof RunConflictError) {
        return context.json(error("run-conflict", "パイプラインは実行中です。"), 409);
      }
      throw cause;
    } finally {
      activeRuns.delete(id);
    }
  });

  app.post("/projects/:id/abort", async (context) => {
    const id = context.req.param("id");
    if (!await readProjectState(projectsRoot, id)) {
      return context.json(error("project-not-found", "プロジェクトが見つかりません。"), 404);
    }
    const controller = activeRuns.get(id);
    if (!controller) {
      return context.json(error("run-conflict", "パイプラインは実行されていません。"), 409);
    }
    controller.abort();
    return context.json({ aborted: true }, 202);
  });

  app.notFound((context) =>
    context.json(error("project-not-found", "プロジェクトが見つかりません。"), 404),
  );
  app.onError((_cause, context) => {
    return context.json(error("validation-error", "状態を処理できませんでした。"), 500);
  });

  return app;
}
