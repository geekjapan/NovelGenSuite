import { Hono } from "hono";
import { z } from "zod";

import {
  executePipeline,
  RunConflictError,
} from "../core/pipeline/execute.js";
import type { Generate } from "../core/pipeline/mock-llm.js";
import {
  createProject,
  listProjects,
  readProjectState,
} from "../core/store/state-json.js";
import {
  CreateProjectRequestSchema,
  findLanguagePolicy,
  type ErrorCode,
  type ErrorEnvelope,
  type SupportedLanguage,
} from "../shared/contracts.js";
import { createPipelineRuntime, reconcileOrphanedRuns } from "./pipeline-runtime.js";

function error(code: ErrorCode, message: string): ErrorEnvelope {
  return { error: { code, message } };
}

export function createApp({ projectsRoot, generate }: { projectsRoot: string; generate?: Generate }) {
  const app = new Hono();
  const reconciliation = reconcileOrphanedRuns(projectsRoot);
  const pipelineRuntime = createPipelineRuntime(projectsRoot);
  const activeRuns = new Map<string, AbortController>();
  const RunRequestSchema = z.discriminatedUnion("operation", [
    z.object({ operation: z.literal("resume") }),
    z.object({
      operation: z.enum(["retry", "regenerate"]),
      chapterNumber: z.number().int().positive(),
    }),
  ]).default({ operation: "resume" });

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
    if (result.data.configuration.requireApproval) {
      return context.json(error("unsupported-setting", "承認ゲートにはまだ対応していません。"), 400);
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

  app.post("/projects/:id/run", async (context) => {
    const id = context.req.param("id");
    const state = await readProjectState(projectsRoot, id);
    if (!state) return context.json(error("project-not-found", "プロジェクトが見つかりません。"), 404);
    if (activeRuns.has(id)) return context.json(error("run-conflict", "パイプラインは実行中です。"), 409);
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
    const controller = new AbortController();
    activeRuns.set(id, controller);
    try {
      return context.json(await executePipeline(state, pipelineRuntime, generate, {
        chapterOperation: request.data.operation === "resume"
          ? { type: "resume" }
          : {
              type: request.data.operation,
              chapterNumber: request.data.chapterNumber,
            },
        signal: controller.signal,
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
