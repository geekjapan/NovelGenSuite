import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  ProjectStateSchema,
  type Configuration,
  type SupportedLanguage,
} from "../../shared/contracts.js";
import {
  initializePipelineState,
  PipelineProjectStateSchema,
  type PipelineProjectState,
} from "../pipeline/project-state.js";

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export function projectsRoot(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return env.NOVELGEN_PROJECTS_ROOT ?? join(home, "NovelGenSuite", "projects");
}

export async function createProject(
  root: string,
  input: {
    prompt: string;
    language: SupportedLanguage;
    configuration: Configuration;
  },
): Promise<PipelineProjectState> {
  await mkdir(root, { recursive: true });

  for (;;) {
    const id = randomUUID();
    const directory = join(root, id);
    try {
      await mkdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }

    const now = new Date().toISOString();
    const state = initializePipelineState(ProjectStateSchema.parse({
      id,
      ...input,
      meta: { schemaVersion: 1, createdAt: now, updatedAt: now },
    }));
    try {
      await writeProjectState(root, state);
      return state;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
}

export async function writeProjectState(
  root: string,
  state: PipelineProjectState,
): Promise<void> {
  const parsed = PipelineProjectStateSchema.parse(state);
  const directory = join(root, parsed.id);
  const temporary = join(directory, `.state-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, join(directory, "state.json"));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function readProjectState(
  root: string,
  id: string,
): Promise<PipelineProjectState | undefined> {
  if (!SAFE_ID.test(id)) return undefined;
  try {
    return PipelineProjectStateSchema.parse(
      JSON.parse(await readFile(join(root, id, "state.json"), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function listProjects(
  root: string,
): Promise<Array<{ id: string; createdAt: string }>> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const states = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && SAFE_ID.test(entry.name))
      .map(async (entry) => {
        try {
          return await readProjectState(root, entry.name);
        } catch (error) {
          console.error(`Failed to read project state for ${entry.name}:`, error);
          return undefined;
        }
      }),
  );
  return states
    .filter((state): state is PipelineProjectState => state !== undefined)
    .map(({ id, meta }) => ({ id, createdAt: meta.createdAt }))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
