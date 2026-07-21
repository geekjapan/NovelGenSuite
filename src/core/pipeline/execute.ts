import { agentDefinitions, mergeAgentOutput, type AgentId } from "../registry/agent-registry.js";
import { listProjects, readProjectState, writeProjectState } from "../store/state-json.js";
import { rebuildManuscript, writeArtifacts } from "./artifacts.js";
import { parseAgentOutput } from "./json-output.js";
import { generateMock, type Generate } from "./mock-llm.js";
import { PipelineProjectStateSchema, type PipelineProjectState } from "./project-state.js";

export class RunConflictError extends Error {}

class PipelineStepError extends Error {
  constructor(readonly state: PipelineProjectState) {
    super("Pipeline step failed");
  }
}

const EXECUTION_ERROR = "Agent execution failed";

const changed = (state: PipelineProjectState): PipelineProjectState => ({
  ...state,
  meta: { ...state.meta, updatedAt: new Date().toISOString() },
});

async function save(root: string, state: PipelineProjectState) {
  const next = PipelineProjectStateSchema.parse(changed(state));
  await writeProjectState(root, next);
  return next;
}

function setAgent(
  state: PipelineProjectState,
  id: AgentId,
  update: Partial<PipelineProjectState["agents"][number]>,
): PipelineProjectState {
  return {
    ...state,
    agents: state.agents.map((agent) => agent.id === id ? { ...agent, ...update } : agent),
  };
}

function setChapter(
  state: PipelineProjectState,
  chapterNumber: number,
  update: Partial<PipelineProjectState["chapterRuns"][number]>,
): PipelineProjectState {
  return {
    ...state,
    chapterRuns: state.chapterRuns.map((chapter) =>
      chapter.chapterNumber === chapterNumber ? { ...chapter, ...update } : chapter),
  };
}

function lengthStatus(state: PipelineProjectState, chapterNumber: number, draft: string) {
  const plan = state.bible.chapters.find(({ number }) => number === chapterNumber)!.lengthPlan;
  const length = draft.replace(/\s/g, "").length;
  if (length < plan.target * 0.75) return "too-short" as const;
  if (length < plan.min) return "under" as const;
  if (length <= plan.max) return "near" as const;
  return "over" as const;
}

async function invoke(
  state: PipelineProjectState,
  id: AgentId,
  generate: Generate,
  chapterNumber?: number,
) {
  const definition = agentDefinitions.find((candidate) => candidate.id === id)!;
  const context = definition.buildContext({
    prompt: state.prompt,
    language: state.language,
    bible: state.bible,
    completedOutputs: state.completedOutputs,
    chapterNumber,
    manuscript: state.manuscript ?? undefined,
  });
  let lastError: unknown;
  for (const compact of [false, true]) {
    try {
      const raw = await generate({
        agentId: id,
        context,
        chapterCount: state.configuration.chapterCount,
        chapterNumber,
        compact,
      });
      return parseAgentOutput(raw, definition.schema);
    } catch (cause) {
      lastError = cause;
    }
  }
  throw lastError;
}

async function runDrafting(root: string, initial: PipelineProjectState, generate: Generate) {
  let state = initial;
  const chapters = state.bible.chapters.slice().sort((left, right) => left.number - right.number);
  for (const chapter of chapters) {
    if (chapter.draft) continue;
    state = setChapter(state, chapter.number, { status: "generating", error: undefined });
    state = await save(root, state);
    let output: unknown;
    try {
      output = await invoke(state, "drafting", generate, chapter.number);
    } catch {
      throw new PipelineStepError(state);
    }
    state = {
      ...state,
      bible: mergeAgentOutput(state.bible, "drafting", output),
      completedOutputs: {
        ...state.completedOutputs,
        drafting: [...((state.completedOutputs.drafting as unknown[] | undefined) ?? []), output],
      },
    };
    const draft = state.bible.chapters.find(({ number }) => number === chapter.number)!.draft!;
    state = setChapter(state, chapter.number, {
      status: "completed",
      lengthStatus: lengthStatus(state, chapter.number, draft),
      error: undefined,
    });
    state = await save(root, state);
  }
  if (state.bible.chapters.every(({ draft }) => Boolean(draft))) {
    state = await save(root, { ...state, manuscript: rebuildManuscript(state) });
  }
  return state;
}

export async function executePipeline(
  root: string,
  initial: PipelineProjectState,
  generate: Generate = generateMock,
): Promise<PipelineProjectState> {
  if (initial.agents.every(({ status }) => status === "completed")) {
    await writeArtifacts(root, initial);
    return initial;
  }
  if (initial.agents.some(({ status }) => status === "running")) throw new RunConflictError("run-conflict");

  let state = initial;
  for (const definition of agentDefinitions) {
    const agent = state.agents.find(({ id }) => id === definition.id)!;
    if (agent.status === "completed") continue;
    state = setAgent(state, definition.id, {
      status: "running",
      startedAt: new Date().toISOString(),
      completedAt: undefined,
      error: undefined,
    });
    state = await save(root, state);
    try {
      if (definition.id === "drafting") {
        state = await runDrafting(root, state, generate);
      } else {
        const output = await invoke(state, definition.id, generate);
        state = {
          ...state,
          bible: mergeAgentOutput(state.bible, definition.id, output),
          completedOutputs: { ...state.completedOutputs, [definition.id]: output },
        };
      }
      state = setAgent(state, definition.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
        error: undefined,
      });
      state = await save(root, state);
    } catch (cause) {
      if (cause instanceof PipelineStepError) state = cause.state;
      const summary = EXECUTION_ERROR;
      state = setAgent(state, definition.id, { status: "failed", error: summary });
      if (definition.id === "drafting") {
        const generating = state.chapterRuns.find(({ status }) => status === "generating");
        if (generating) state = setChapter(state, generating.chapterNumber, { status: "failed", error: summary });
      }
      return save(root, state);
    }
  }
  await writeArtifacts(root, state);
  return state;
}

export async function reconcileOrphanedRuns(root: string): Promise<void> {
  for (const { id } of await listProjects(root)) {
    const state = await readProjectState(root, id);
    if (!state?.agents.some(({ status }) => status === "running")) continue;
    const summary = "Server restarted while this role was running";
    let recovered = {
      ...state,
      agents: state.agents.map((agent) => agent.status === "running"
        ? { ...agent, status: "failed" as const, error: summary }
        : agent),
      chapterRuns: state.chapterRuns.map((chapter) => chapter.status === "generating"
        ? { ...chapter, status: "failed" as const, error: summary }
        : chapter),
    };
    recovered = changed(recovered);
    await writeProjectState(root, PipelineProjectStateSchema.parse(recovered));
  }
}
