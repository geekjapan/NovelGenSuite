import { agentDefinitions, mergeAgentOutput, type AgentId } from "../registry/agent-registry.js";
import { createGenerateFromEnv, LlmError, shouldCompactRetry } from "../llm/openai-client.js";
import { rebuildManuscript } from "./artifacts.js";
import {
  classifyLength,
  hasChapterCoverage,
  selectChapterNumbers,
  type ChapterOperation,
} from "./chapters.js";
import { parseAgentOutput } from "./json-output.js";
import type { Generate } from "./mock-llm.js";
import { PipelineProjectStateSchema, type PipelineProjectState } from "./project-state.js";

export class RunConflictError extends Error {}

export type PipelineRuntime = {
  save: (state: PipelineProjectState) => Promise<void>;
  writeArtifacts: (state: PipelineProjectState) => Promise<void>;
};

export type ExecuteOptions = {
  chapterOperation?: ChapterOperation;
  signal?: AbortSignal;
};

class PipelineStepError extends Error {
  constructor(
    readonly state: PipelineProjectState,
    readonly cancelled = false,
    readonly summary = EXECUTION_ERROR,
  ) {
    super("Pipeline step failed");
  }
}

const EXECUTION_ERROR = "Agent execution failed";
const EXPANSION_ERROR = "Automatic expansion failed";

const chapterExecutionError = (
  cause: unknown,
  chapterNumber: number,
  operation: "generate" | "retry" | "regenerate" | "auto-expand",
) => cause instanceof LlmError && cause.kind === "timeout"
  ? `第${chapterNumber}章の${operation === "auto-expand" ? "自動拡張" : "生成"}がタイムアウトしました。章長を減らすか、モデルを変更してください。`
  : operation === "auto-expand" ? EXPANSION_ERROR : EXECUTION_ERROR;

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

async function invoke(
  state: PipelineProjectState,
  id: AgentId,
  generate: Generate,
  options: {
    chapterNumber?: number;
    operation?: "generate" | "retry" | "regenerate" | "auto-expand";
    currentDraft?: string;
    signal?: AbortSignal;
  } = {},
) {
  const definition = agentDefinitions.find((candidate) => candidate.id === id)!;
  const context = definition.buildContext({
    prompt: state.prompt,
    language: state.language,
    bible: state.bible,
    completedOutputs: state.completedOutputs,
    chapterNumber: options.chapterNumber,
    manuscript: state.manuscript ?? undefined,
    currentDraft: options.currentDraft,
  });
  let lastError: unknown;
  for (const compact of options.operation === "auto-expand" ? [false] : [false, true]) {
    try {
      options.signal?.throwIfAborted();
      const raw = await generate({
        agentId: id,
        context,
        chapterCount: state.configuration.chapterCount,
        chapterNumber: options.chapterNumber,
        operation: options.operation,
        compact,
        signal: options.signal,
      });
      const output = parseAgentOutput(raw, definition.schema);
      if (
        id === "drafting"
        && (output as { chapterNumber?: number }).chapterNumber !== options.chapterNumber
      ) {
        throw new Error("Drafting output chapter number mismatch");
      }
      return output;
    } catch (cause) {
      lastError = cause;
      if (options.signal?.aborted || !shouldCompactRetry(cause)) throw cause;
    }
  }
  throw lastError;
}

async function runDrafting(
  runtime: PipelineRuntime,
  initial: PipelineProjectState,
  generate: Generate,
  operation: ChapterOperation,
  signal?: AbortSignal,
) {
  let state = initial;
  const stopOnFailure = operation.type !== "resume";
  const attemptedChapters = new Set<number>();

  for (const chapterNumber of selectChapterNumbers(state, operation)) {
    if (attemptedChapters.has(chapterNumber)) continue;
    attemptedChapters.add(chapterNumber);
    state = setChapter(state, chapterNumber, {
      status: "generating",
      needsExpansion: undefined,
      error: undefined,
    });
    state = await save(runtime, state);

    let output: unknown;
    try {
      output = await invoke(state, "drafting", generate, {
        chapterNumber,
        operation: operation.type === "resume" ? "generate" : operation.type,
        signal,
      });
    } catch (cause) {
      if (signal?.aborted) throw new PipelineStepError(state, true);
      state = setChapter(state, chapterNumber, {
        status: "failed",
        error: chapterExecutionError(
          cause,
          chapterNumber,
          operation.type === "resume" ? "generate" : operation.type,
        ),
      });
      state = await save(runtime, state);
      if (stopOnFailure) break;
      continue;
    }

    state = {
      ...state,
      bible: mergeAgentOutput(state.bible, "drafting", output),
      completedOutputs: {
        ...state.completedOutputs,
        drafting: [...((state.completedOutputs.drafting as unknown[] | undefined) ?? []), output],
      },
    };
    const chapter = state.bible.chapters.find(({ number }) => number === chapterNumber)!;
    let status = classifyLength(chapter.lengthPlan, chapter.draft!);

    if (status === "too-short") {
      state = await save(runtime, setChapter(state, chapterNumber, {
        status: "generating",
        lengthStatus: status,
      }));
      try {
        const expanded = await invoke(state, "drafting", generate, {
          chapterNumber,
          operation: "auto-expand",
          currentDraft: chapter.draft,
          signal,
        });
        state = {
          ...state,
          bible: mergeAgentOutput(state.bible, "drafting", expanded),
          completedOutputs: {
            ...state.completedOutputs,
            drafting: [
              ...((state.completedOutputs.drafting as unknown[] | undefined) ?? []),
              expanded,
            ],
          },
        };
        const expandedChapter = state.bible.chapters.find(({ number }) => number === chapterNumber)!;
        status = classifyLength(expandedChapter.lengthPlan, expandedChapter.draft!);
        state = setChapter(state, chapterNumber, {
          status: "completed",
          lengthStatus: status,
          needsExpansion: status === "too-short" || status === "under",
          error: undefined,
        });
      } catch (cause) {
        if (signal?.aborted) throw new PipelineStepError(state, true);
        state = setChapter(state, chapterNumber, {
          status: "completed",
          lengthStatus: status,
          needsExpansion: true,
          error: chapterExecutionError(cause, chapterNumber, "auto-expand"),
        });
      }
    } else {
      state = setChapter(state, chapterNumber, {
        status: "completed",
        lengthStatus: status,
        needsExpansion: false,
        error: undefined,
      });
    }
    state = await save(runtime, state);
  }

  if (hasChapterCoverage(state)) {
    state = await save(runtime, { ...state, manuscript: rebuildManuscript(state) });
  }
  return state;
}

function cancelRunning(
  state: PipelineProjectState,
  id: AgentId,
  operation: ChapterOperation,
): PipelineProjectState {
  const generating = state.chapterRuns.find(({ status }) => status === "generating");
  const wasExpanding = generating?.lengthStatus === "too-short"
    && Boolean(state.bible.chapters.find(({ number }) => number === generating.chapterNumber)?.draft);
  const attempt = {
    type: "cancellation" as const,
    operation: wasExpanding ? "auto-expand" as const : operation.type,
    attemptedAt: new Date().toISOString(),
  };
  let next = setAgent(state, id, {
    status: "pending",
    error: undefined,
    attempts: [...(state.agents.find((agent) => agent.id === id)?.attempts ?? []), attempt],
  });
  if (generating) {
    next = setChapter(next, generating.chapterNumber, {
      status: "pending",
      error: undefined,
      attempts: [...(generating.attempts ?? []), attempt],
    });
  }
  return next;
}

export async function executePipeline(
  initial: PipelineProjectState,
  runtime: PipelineRuntime,
  generate?: Generate,
  options: ExecuteOptions = {},
): Promise<PipelineProjectState> {
  const operation = options.chapterOperation ?? { type: "resume" };
  if (
    operation.type === "resume"
    && initial.agents.every(({ status }) => status === "completed")
  ) {
    await runtime.writeArtifacts(initial);
    return initial;
  }
  if (initial.agents.some(({ status }) => status === "running")) {
    throw new RunConflictError("run-conflict");
  }

  let state = initial;
  let resolvedGenerate = generate;
  for (const definition of agentDefinitions) {
    const agent = state.agents.find(({ id }) => id === definition.id)!;
    const explicitDraftOperation = definition.id === "drafting" && operation.type !== "resume";
    if (agent.status === "completed" && !explicitDraftOperation) continue;
    state = setAgent(state, definition.id, {
      status: "running",
      startedAt: new Date().toISOString(),
      completedAt: undefined,
      error: undefined,
    });
    state = await save(runtime, state);
    try {
      options.signal?.throwIfAborted();
      resolvedGenerate ??= createGenerateFromEnv();
      if (definition.id === "drafting") {
        state = await runDrafting(runtime, state, resolvedGenerate, operation, options.signal);
        if (!hasChapterCoverage(state)) {
          throw new PipelineStepError(
            state,
            false,
            state.chapterRuns.find(({ status }) => status === "failed")?.error ?? EXECUTION_ERROR,
          );
        }
      } else {
        const output = await invoke(state, definition.id, resolvedGenerate, {
          signal: options.signal,
        });
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
      if (options.signal?.aborted || cause instanceof PipelineStepError && cause.cancelled) {
        return save(runtime, cancelRunning(state, definition.id, operation));
      }
      state = setAgent(state, definition.id, {
        status: "failed",
        error: cause instanceof PipelineStepError ? cause.summary : EXECUTION_ERROR,
      });
      return save(runtime, state);
    }
  }
  await runtime.writeArtifacts(state);
  return state;
}
