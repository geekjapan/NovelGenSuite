import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { approvalOutline, renderArtifacts } from "../core/pipeline/artifacts.js";
import type { PipelineRuntime } from "../core/pipeline/execute.js";
import {
  PipelineProjectStateSchema,
  type PipelineProjectState,
} from "../core/pipeline/project-state.js";
import {
  listProjects,
  readProjectState,
  writeProjectState,
} from "../core/store/state-json.js";

export function createPipelineRuntime(root: string): PipelineRuntime {
  return {
    save: (state) => writeProjectState(root, state),
    writeArtifacts: async (state) => {
      await Promise.all(Object.entries(renderArtifacts(state)).map(([name, contents]) =>
        writeFile(join(root, state.id, name), contents, "utf8")));
    },
    writeApprovalArtifact: (state) =>
      writeFile(
        join(root, state.id, "chapter-outline.json"),
        `${JSON.stringify(approvalOutline(state), null, 2)}\n`,
        "utf8",
      ),
  };
}

export async function readApprovalArtifact(root: string, id: string): Promise<unknown> {
  return JSON.parse(await readFile(join(root, id, "chapter-outline.json"), "utf8"));
}

export async function writeApprovalArtifact(
  root: string,
  state: PipelineProjectState,
  outline: unknown,
): Promise<void> {
  await writeFile(
    join(root, state.id, "chapter-outline.json"),
    `${JSON.stringify(outline, null, 2)}\n`,
    "utf8",
  );
}

export async function reconcileOrphanedRuns(root: string): Promise<void> {
  let projects;
  try {
    projects = await listProjects(root);
  } catch (error) {
    console.error("Failed to list projects for reconciliation:", error);
    return;
  }
  for (const { id } of projects) {
    try {
      const state = await readProjectState(root, id);
      if (!state?.agents.some(({ status }) => status === "running")) continue;
      const attempt = {
        type: "cancellation" as const,
        operation: "resume" as const,
        attemptedAt: new Date().toISOString(),
      };
      await writeProjectState(root, PipelineProjectStateSchema.parse({
        ...state,
        meta: { ...state.meta, updatedAt: new Date().toISOString() },
        agents: state.agents.map((agent) => agent.status === "running"
          ? {
              ...agent,
              status: "pending" as const,
              startedAt: undefined,
              completedAt: undefined,
              error: undefined,
              attempts: [...(agent.attempts ?? []), attempt],
            }
          : agent),
        chapterRuns: state.chapterRuns.map((chapter) => chapter.status === "generating"
          ? {
              ...chapter,
              status: "pending" as const,
              error: undefined,
              attempts: [...(chapter.attempts ?? []), attempt],
            }
          : chapter),
      }));
    } catch (error) {
      console.error(`Failed to reconcile project ${id}:`, error);
    }
  }
}
