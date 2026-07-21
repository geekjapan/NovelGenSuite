import { agentDefinitions, mergeAgentOutput, type AgentId } from "../registry/agent-registry.js";
import { createGenerateFromEnv, shouldCompactRetry } from "../llm/openai-client.js";
import { rebuildManuscript } from "./artifacts.js";
import { parseAgentOutput } from "./json-output.js";
import type { Generate } from "./mock-llm.js";
import { PipelineProjectStateSchema, type PipelineProjectState } from "./project-state.js";

export class RunConflictError extends Error {}

export type PipelineRuntime = {
  save: (state: PipelineProjectState) => Promise<void>;
  writeArtifacts: (state: PipelineProjectState) => Promise<void>;
};

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

async function save(runtime: PipelineRuntime, state: PipelineProjectState) {
  const next = PipelineProjectStateSchema.parse(changed(state));
  await runtime.save(next);
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
      if (!shouldCompactRetry(cause)) throw cause;
    }
  }
  throw lastError;
}

async function runDrafting(runtime: PipelineRuntime, initial: PipelineProjectState, generate: Generate) {
  let state = initial;
  const chapters = state.bible.chapters.slice().sort((left, right) => left.number - right.number);
  for (const chapter of chapters) {
    if (chapter.draft) continue;
    state = setChapter(state, chapter.number, { status: "generating", error: undefined });
    state = await save(runtime, state);
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
    state = await save(runtime, state);
  }
  if (state.bible.chapters.every(({ draft }) => Boolean(draft))) {
    state = await save(runtime, { ...state, manuscript: rebuildManuscript(state) });
  }
  return state;
}

export async function executePipeline(
  initial: PipelineProjectState,
  runtime: PipelineRuntime,
  generate?: Generate,
): Promise<PipelineProjectState> {
  if (initial.agents.every(({ status }) => status === "completed")) {
    await runtime.writeArtifacts(initial);
    return initial;
  }
  if (initial.agents.some(({ status }) => status === "running")) throw new RunConflictError("run-conflict");

  let state = initial;
  let resolvedGenerate = generate;
  for (const definition of agentDefinitions) {
    const agent = state.agents.find(({ id }) => id === definition.id)!;
    if (agent.status === "completed") continue;
    state = setAgent(state, definition.id, {
      status: "running",
      startedAt: new Date().toISOString(),
      completedAt: undefined,
      error: undefined,
    });
    state = await save(runtime, state);
    try {
      resolvedGenerate ??= createGenerateFromEnv();
      if (definition.id === "drafting") {
        state = await runDrafting(runtime, state, resolvedGenerate);
      } else {
        const output = await invoke(state, definition.id, resolvedGenerate);
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
      state = await save(runtime, state);
    } catch (cause) {
      if (cause instanceof PipelineStepError) state = cause.state;
      const summary = EXECUTION_ERROR;
      state = setAgent(state, definition.id, { status: "failed", error: summary });
      if (definition.id === "drafting") {
        const generating = state.chapterRuns.find(({ status }) => status === "generating");
        if (generating) state = setChapter(state, generating.chapterNumber, { status: "failed", error: summary });
      }
      return save(runtime, state);
    }
  }
  await runtime.writeArtifacts(state);
  return state;
}
