import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { renderArtifacts } from "../core/pipeline/artifacts.js";
import type { PipelineRuntime } from "../core/pipeline/execute.js";
import { PipelineProjectStateSchema } from "../core/pipeline/project-state.js";
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
  };
}

export async function reconcileOrphanedRuns(root: string): Promise<void> {
  for (const { id } of await listProjects(root)) {
    const state = await readProjectState(root, id);
    if (!state?.agents.some(({ status }) => status === "running")) continue;
    const summary = "Server restarted while this role was running";
    await writeProjectState(root, PipelineProjectStateSchema.parse({
      ...state,
      meta: { ...state.meta, updatedAt: new Date().toISOString() },
      agents: state.agents.map((agent) => agent.status === "running"
        ? { ...agent, status: "failed" as const, error: summary }
        : agent),
      chapterRuns: state.chapterRuns.map((chapter) => chapter.status === "generating"
        ? { ...chapter, status: "failed" as const, error: summary }
        : chapter),
    }));
  }
}
