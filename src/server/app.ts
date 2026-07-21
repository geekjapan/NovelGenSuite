import { Hono } from "hono";

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

function error(code: ErrorCode, message: string): ErrorEnvelope {
  return { error: { code, message } };
}

export function createApp({ projectsRoot }: { projectsRoot: string }) {
  const app = new Hono();

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
    const state = await readProjectState(projectsRoot, context.req.param("id"));
    return state
      ? context.json(state)
      : context.json(error("project-not-found", "プロジェクトが見つかりません。"), 404);
  });

  app.notFound((context) =>
    context.json(error("project-not-found", "プロジェクトが見つかりません。"), 404),
  );
  app.onError((cause, context) => {
    console.error(cause);
    return context.json(error("validation-error", "状態を処理できませんでした。"), 500);
  });

  return app;
}
