import {
  ChapterRevisionOutputSchema,
  ExpansionOutputSchema,
  PlanRevisionOutputSchema,
  type PlanRevisionOutput,
} from "../../shared/agent-schemas.js";
import {
  agentDefinitions,
  mergeAgentOutput,
  normalizeAgentOutput,
  type AgentId,
} from "../registry/agent-registry.js";
import { createGenerateFromEnv, LlmError, sanitizeErrorMessage } from "../llm/openai-client.js";
import { buildPrompt } from "../prompts/prompts.js";
import { approvalOutline, rebuildManuscript } from "./artifacts.js";
import {
  classifyLength,
  hasChapterCoverage,
  selectChapterNumbers,
  type ChapterOperation,
} from "./chapters.js";
import { extractJson } from "./json-output.js";
import type { Generate } from "./mock-llm.js";
import {
  approveChapterOutline,
  PipelineProjectStateSchema,
  setWorkflowStage,
  type PipelineProjectState,
} from "./project-state.js";
import {
  actionableError,
  classifyRecovery,
  isOutputQualityFailure,
  localFallback,
  logParseFailure,
  shouldClientRetry,
  shouldProviderSwitch,
  type PipelineLog,
} from "./recovery.js";

export class RunConflictError extends Error {}

export type PipelineRuntime = {
  save: (state: PipelineProjectState) => Promise<void>;
  writeArtifacts: (state: PipelineProjectState) => Promise<void>;
  writeApprovalArtifact?: (state: PipelineProjectState) => Promise<void>;
};

export type ExecuteOptions = {
  chapterOperation?: ChapterOperation;
  finalAgent?: Extract<AgentId, "editor" | "continuity" | "publisher">;
  signal?: AbortSignal;
  alternateGenerate?: Generate;
  log?: PipelineLog;
  localDebug?: boolean;
  retryDelayMs?: number;
  timeouts?: { callMs?: number; agentMs?: number; parseMs?: number };
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
const MAX_CLIENT_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1_200;
const DEFAULT_AGENT_TIMEOUT_MS = 300_000;
const DEFAULT_CALL_TIMEOUT_MS = 40_000;
const CHAPTER_CALL_TIMEOUT_MS = 45_000;
const DEFAULT_PARSE_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_CHARACTERS = 100_000;
const defaultLog: PipelineLog = (event, details) => console.info(event, details);
const wasCancelled = (signal?: AbortSignal) =>
  signal?.aborted && signal.reason instanceof Error && signal.reason.name === "AbortError";

const chapterExecutionError = (
  cause: unknown,
  chapterNumber: number,
  operation: "generate" | "retry" | "regenerate" | "expand" | "revise" | "auto-expand",
) => cause instanceof LlmError && cause.kind === "timeout"
  ? `第${chapterNumber}章の${{
      generate: "生成",
      retry: "再試行",
      regenerate: "再生成",
      expand: "拡張",
      revise: "改稿",
      "auto-expand": "自動拡張",
    }[operation]}がタイムアウトしました。章長を減らすか、モデルを変更してください。`
  : operation === "auto-expand" ? `${EXPANSION_ERROR}: ${actionableError(cause)}` : actionableError(cause);

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

function mergeDraftingOutput(
  state: PipelineProjectState,
  output: unknown,
  log: PipelineLog,
  chapterNumber: number,
): PipelineProjectState {
  const started = performance.now();
  const bible = mergeAgentOutput(state.bible, "drafting", output);
  log("pipeline.stage", {
    agentId: "drafting",
    chapterNumber,
    stage: "merge",
    elapsedMs: performance.now() - started,
  });
  return {
    ...state,
    bible,
    completedOutputs: {
      ...state.completedOutputs,
      drafting: [...((state.completedOutputs.drafting as unknown[] | undefined) ?? []), output],
    },
  };
}

type RecoveryRecord = {
  attemptCount: number;
  maxAttempts: number;
  lastRetryError?: string;
  fallbackUsed: boolean;
  autoRecovered: boolean;
};

type InvokeResult = { output: unknown; recovery: RecoveryRecord };

class ProviderRequestError {
  constructor(
    readonly cause: unknown,
    readonly attempts: number,
    readonly lastError?: string,
  ) {}
}

const underlyingCause = (cause: unknown) =>
  cause instanceof ProviderRequestError ? cause.cause : cause;
const attemptedCount = (cause: unknown, maximum: number) =>
  cause instanceof ProviderRequestError ? cause.attempts : shouldClientRetry(cause) ? maximum : 1;

const wait = (milliseconds: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) {
    reject(signal.reason);
    return;
  }
  const timer = setTimeout(resolve, milliseconds);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    reject(signal.reason);
  }, { once: true });
});

async function clientRetry(
  generate: Generate,
  request: Parameters<Generate>[0],
  delayMs: number,
  callTimeoutMs: number,
): Promise<{ raw: string; attempts: number; lastError?: string }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_CLIENT_ATTEMPTS; attempt += 1) {
    const attemptSignal = AbortSignal.any([
      ...(request.signal ? [request.signal] : []),
      AbortSignal.timeout(callTimeoutMs),
    ]);
    try {
      return {
        raw: await generate({
          ...request,
          signal: attemptSignal,
        }),
        attempts: attempt,
        lastError: attempt > 1 ? sanitizeErrorMessage(lastError) : undefined,
      };
    } catch (caught) {
      const cause = caught instanceof Error
        && caught.name === "AbortError"
        && attemptSignal.reason instanceof Error
        && attemptSignal.reason.name === "TimeoutError"
        ? new LlmError("LLM call timed out", true, "timeout")
        : caught;
      lastError = cause;
      if (classifyRecovery(cause) === "abort" || !shouldClientRetry(cause) || attempt === MAX_CLIENT_ATTEMPTS) {
        throw new ProviderRequestError(cause, attempt, sanitizeErrorMessage(lastError));
      }
      if (delayMs > 0) {
        try {
          await wait(delayMs, request.signal);
        } catch (delayCause) {
          throw new ProviderRequestError(delayCause, attempt, sanitizeErrorMessage(cause));
        }
      }
    }
  }
  throw lastError;
}

async function providerRequest(
  primary: Generate,
  alternate: Generate | undefined,
  request: Parameters<Generate>[0],
  delayMs: number,
  callTimeoutMs: number,
): Promise<{ raw: string; attempts: number; lastError?: string; switched: boolean; provider: string }> {
  try {
    const result = await clientRetry(primary, request, delayMs, callTimeoutMs);
    return { ...result, switched: false, provider: "primary" };
  } catch (failure) {
    const primaryFailure = failure as ProviderRequestError;
    if (!alternate || !shouldProviderSwitch(primaryFailure.cause)) throw failure;
    try {
      const result = await clientRetry(alternate, request, delayMs, callTimeoutMs);
      return {
        ...result,
        attempts: primaryFailure.attempts + result.attempts,
        lastError: sanitizeErrorMessage(primaryFailure.cause),
        switched: true,
        provider: "alternate",
      };
    } catch (alternateFailure) {
      const failed = alternateFailure as ProviderRequestError;
      throw new ProviderRequestError(
        failed.cause,
        primaryFailure.attempts + failed.attempts,
        sanitizeErrorMessage(failed.cause),
      );
    }
  }
}

async function invoke(
  state: PipelineProjectState,
  id: AgentId,
  generate: Generate,
  options: {
    chapterNumber?: number;
    operation?: "generate" | "retry" | "regenerate" | "expand" | "revise" | "plan-revise" | "auto-expand";
    instruction?: string;
    currentDraft?: string;
    signal?: AbortSignal;
    alternateGenerate?: Generate;
    log: PipelineLog;
    localDebug: boolean;
    retryDelayMs: number;
    callTimeoutMs: number;
    parseTimeoutMs: number;
  },
): Promise<InvokeResult> {
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
  let attempts = 0;
  let lastRetryError: string | undefined;
  let providerSwitched = false;
  for (const compact of options.operation === "auto-expand" ? [false] : [false, true]) {
    let raw = "";
    let provider = "primary";
    let responseReceived = false;
    let callStarted = 0;
    let failedStage: "parse" | "normalize" | undefined;
    let stageStarted = 0;
    try {
      options.signal?.throwIfAborted();
      callStarted = performance.now();
      const request = {
        agentId: id,
        context,
        chapterCount: state.configuration.chapterCount,
        chapterNumber: options.chapterNumber,
        operation: options.operation,
        instruction: options.instruction,
        compact,
        signal: options.signal,
      };
      const prompt = buildPrompt(request);
      options.log("pipeline.prompt", {
        agentId: id,
        chapterNumber: options.chapterNumber,
        chapterOrder: options.chapterNumber,
        characters: prompt.system.length + prompt.user.length,
        estimatedTokens: Math.ceil((prompt.system.length + prompt.user.length) / 4),
      });
      const generated = await providerRequest(
        generate,
        options.alternateGenerate,
        request,
        options.retryDelayMs,
        options.callTimeoutMs,
      );
      raw = generated.raw;
      responseReceived = true;
      provider = generated.provider;
      attempts += generated.attempts;
      lastRetryError = generated.lastError ?? lastRetryError;
      providerSwitched ||= generated.switched;
      options.log("pipeline.stage", {
        agentId: id,
        chapterNumber: options.chapterNumber,
        stage: "llm",
        elapsedMs: performance.now() - callStarted,
        provider,
      });
      if (raw.length > MAX_RESPONSE_CHARACTERS) throw new RangeError("response-size-limit");

      failedStage = "parse";
      stageStarted = performance.now();
      const extracted = extractJson(raw, options.parseTimeoutMs);
      options.log("pipeline.stage", {
        agentId: id,
        chapterNumber: options.chapterNumber,
        stage: "parse",
        elapsedMs: performance.now() - stageStarted,
      });
      failedStage = "normalize";
      stageStarted = performance.now();
      const chapter = options.chapterNumber
        ? state.bible.chapters.find(({ number }) => number === options.chapterNumber)
        : undefined;
      let output: unknown;
      if (options.operation === "expand") {
        const expanded = ExpansionOutputSchema.parse(extracted);
        output = {
          chapterNumber: options.chapterNumber,
          draft: expanded.draft,
          chapterSummary: chapter?.chapterSummary ?? expanded.expansionSummary,
          continuityNotes: chapter?.continuityNotes ?? [],
          expansionSummary: expanded.expansionSummary,
        };
      } else if (options.operation === "revise") {
        const revised = ChapterRevisionOutputSchema.parse(extracted);
        output = {
          ...revised,
          continuityNotes: chapter?.continuityNotes ?? [],
        };
      } else if (options.operation === "plan-revise") {
        output = PlanRevisionOutputSchema.parse(extracted);
      } else {
        output = normalizeAgentOutput(id, extracted);
      }
      options.log("pipeline.stage", {
        agentId: id,
        chapterNumber: options.chapterNumber,
        stage: "normalize",
        elapsedMs: performance.now() - stageStarted,
      });
      failedStage = undefined;
      if (
        id === "drafting"
        && (output as { chapterNumber?: number }).chapterNumber !== options.chapterNumber
      ) {
        throw new Error("Drafting output chapter number mismatch");
      }
      return {
        output,
        recovery: {
          attemptCount: attempts,
          maxAttempts: MAX_CLIENT_ATTEMPTS
            * (options.alternateGenerate ? 2 : 1)
            * (options.operation === "auto-expand" ? 1 : 2),
          lastRetryError,
          fallbackUsed: providerSwitched,
          autoRecovered: providerSwitched || attempts > 1 || compact,
        },
      };
    } catch (cause) {
      const rootCause = underlyingCause(cause);
      const combinedFailure = cause instanceof ProviderRequestError && attempts > 0
        ? new ProviderRequestError(
            rootCause,
            attempts + cause.attempts,
            sanitizeErrorMessage(rootCause),
          )
        : cause;
      if (wasCancelled(options.signal) || classifyRecovery(rootCause) === "abort") {
        throw combinedFailure;
      }
      if (!responseReceived) {
        if (callStarted) {
          options.log("pipeline.stage", {
            agentId: id,
            chapterNumber: options.chapterNumber,
            stage: "llm",
            elapsedMs: performance.now() - callStarted,
            provider,
            failed: true,
          });
        }
        if (
          classifyRecovery(rootCause) === "hard"
          || classifyRecovery(rootCause) === "deny"
        ) {
          throw combinedFailure;
        }
        if (
          (id === "chapter-outline"
            && options.operation !== "plan-revise"
            && classifyRecovery(rootCause) === "retry")
          || isOutputQualityFailure(rootCause)
        ) {
          const fallback = normalizeAgentOutput(id, localFallback(id, context, options.chapterNumber));
          return {
            output: fallback,
            recovery: {
              attemptCount: attemptedCount(combinedFailure, MAX_CLIENT_ATTEMPTS),
              maxAttempts: MAX_CLIENT_ATTEMPTS
                * (options.alternateGenerate ? 2 : 1)
                * (options.operation === "auto-expand" ? 1 : 2),
              lastRetryError: sanitizeErrorMessage(rootCause),
              fallbackUsed: true,
              autoRecovered: true,
            },
          };
        }
        throw combinedFailure;
      }
      if (failedStage) {
        options.log("pipeline.stage", {
          agentId: id,
          chapterNumber: options.chapterNumber,
          stage: failedStage,
          elapsedMs: performance.now() - stageStarted,
          failed: true,
        });
      }
      if (rootCause instanceof LlmError || classifyRecovery(rootCause) === "hard" || classifyRecovery(rootCause) === "deny") {
        throw combinedFailure;
      }
      lastRetryError = sanitizeErrorMessage(rootCause);
      logParseFailure(options.log, raw, provider, rootCause instanceof RangeError ? rootCause.message : "invalid-output", options.localDebug);
      if (!compact && !(rootCause instanceof RangeError) && options.operation !== "auto-expand") continue;
      if (
        options.operation === "auto-expand"
        || options.operation === "expand"
        || options.operation === "revise"
        || options.operation === "plan-revise"
      ) {
        throw combinedFailure;
      }
      const fallback = normalizeAgentOutput(id, localFallback(id, context, options.chapterNumber));
      return {
        output: fallback,
        recovery: {
          attemptCount: attempts,
          maxAttempts: MAX_CLIENT_ATTEMPTS
            * (options.alternateGenerate ? 2 : 1)
            * 2,
          lastRetryError,
          fallbackUsed: true,
          autoRecovered: true,
        },
      };
    }
  }
  throw new Error("unreachable");
}

async function runDrafting(
  runtime: PipelineRuntime,
  initial: PipelineProjectState,
  generate: Generate,
  operation: ChapterOperation,
  signal: AbortSignal | undefined,
  recoveryOptions: {
    alternateGenerate?: Generate;
    log: PipelineLog;
    localDebug: boolean;
    retryDelayMs: number;
    callTimeoutMs: number;
    parseTimeoutMs: number;
  },
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
      const result = await invoke(state, "drafting", generate, {
        chapterNumber,
        operation: operation.type === "resume" ? "generate" : operation.type,
        instruction: operation.type === "resume" ? undefined : operation.instruction,
        currentDraft: operation.type === "expand" || operation.type === "revise"
          ? state.bible.chapters.find(({ number }) => number === chapterNumber)?.draft
          : undefined,
        signal,
        ...recoveryOptions,
      });
      output = result.output;
      state = setChapter(state, chapterNumber, result.recovery);
    } catch (cause) {
      const rootCause = underlyingCause(cause);
      if (wasCancelled(signal) || classifyRecovery(rootCause) === "abort") {
        throw new PipelineStepError(state, true);
      }
      state = setChapter(state, chapterNumber, {
        status: "failed",
        error: chapterExecutionError(
          rootCause,
          chapterNumber,
          operation.type === "resume" ? "generate" : operation.type,
        ),
        attemptCount: attemptedCount(
          cause,
          MAX_CLIENT_ATTEMPTS * (recoveryOptions.alternateGenerate ? 2 : 1),
        ),
        maxAttempts: MAX_CLIENT_ATTEMPTS * (recoveryOptions.alternateGenerate ? 2 : 1),
        lastRetryError: sanitizeErrorMessage(rootCause),
      });
      state = await save(runtime, state);
      if (
        classifyRecovery(rootCause) === "hard"
        || classifyRecovery(rootCause) === "deny"
      ) {
        throw new PipelineStepError(state, false, chapterExecutionError(
          rootCause,
          chapterNumber,
          operation.type === "resume" ? "generate" : operation.type,
        ));
      }
      if (stopOnFailure) break;
      continue;
    }

    state = mergeDraftingOutput(state, output, recoveryOptions.log, chapterNumber);
    const chapter = state.bible.chapters.find(({ number }) => number === chapterNumber)!;
    let status = classifyLength(chapter.lengthPlan, chapter.draft!);

    if (
      status === "too-short"
      && operation.type !== "expand"
      && operation.type !== "revise"
    ) {
      state = await save(runtime, setChapter(state, chapterNumber, {
        status: "generating",
        lengthStatus: status,
      }));
      try {
        const result = await invoke(state, "drafting", generate, {
          chapterNumber,
          operation: "auto-expand",
          currentDraft: chapter.draft,
          signal,
          ...recoveryOptions,
        });
        const expanded = result.output;
        const previousRecovery = state.chapterRuns.find(
          (chapterRun) => chapterRun.chapterNumber === chapterNumber,
        )!;
        state = setChapter(state, chapterNumber, {
          attemptCount: (previousRecovery.attemptCount ?? 0) + result.recovery.attemptCount,
          maxAttempts: (previousRecovery.maxAttempts ?? 0) + result.recovery.maxAttempts,
          lastRetryError: result.recovery.lastRetryError ?? previousRecovery.lastRetryError,
          fallbackUsed: Boolean(previousRecovery.fallbackUsed || result.recovery.fallbackUsed),
          autoRecovered: Boolean(previousRecovery.autoRecovered || result.recovery.autoRecovered),
        });
        state = mergeDraftingOutput(state, expanded, recoveryOptions.log, chapterNumber);
        const expandedChapter = state.bible.chapters.find(({ number }) => number === chapterNumber)!;
        status = classifyLength(expandedChapter.lengthPlan, expandedChapter.draft!);
        state = setChapter(state, chapterNumber, {
          status: "completed",
          lengthStatus: status,
          needsExpansion: status === "too-short" || status === "under",
          error: undefined,
        });
      } catch (cause) {
        const rootCause = underlyingCause(cause);
        const previousRecovery = state.chapterRuns.find(
          (chapterRun) => chapterRun.chapterNumber === chapterNumber,
        )!;
        const expansionAttempts = attemptedCount(
          cause,
          MAX_CLIENT_ATTEMPTS * (recoveryOptions.alternateGenerate ? 2 : 1),
        );
        const expansionMaximum = MAX_CLIENT_ATTEMPTS
          * (recoveryOptions.alternateGenerate ? 2 : 1);
        if (wasCancelled(signal) || classifyRecovery(rootCause) === "abort") {
          throw new PipelineStepError(state, true);
        }
        if (
          classifyRecovery(rootCause) === "hard"
          || classifyRecovery(rootCause) === "deny"
        ) {
          state = await save(runtime, setChapter(state, chapterNumber, {
            status: "failed",
            lengthStatus: status,
            needsExpansion: true,
            error: chapterExecutionError(rootCause, chapterNumber, "auto-expand"),
            attemptCount: (previousRecovery.attemptCount ?? 0) + expansionAttempts,
            maxAttempts: (previousRecovery.maxAttempts ?? 0) + expansionMaximum,
            lastRetryError: sanitizeErrorMessage(rootCause),
          }));
          throw new PipelineStepError(
            state,
            false,
            chapterExecutionError(rootCause, chapterNumber, "auto-expand"),
          );
        }
        state = setChapter(state, chapterNumber, {
          status: "completed",
          lengthStatus: status,
          needsExpansion: true,
          error: chapterExecutionError(rootCause, chapterNumber, "auto-expand"),
          attemptCount: (previousRecovery.attemptCount ?? 0) + expansionAttempts,
          maxAttempts: (previousRecovery.maxAttempts ?? 0) + expansionMaximum,
          lastRetryError: sanitizeErrorMessage(rootCause),
        });
      }
    } else {
      state = setChapter(state, chapterNumber, {
        status: "completed",
        lengthStatus: status,
        needsExpansion: status === "too-short" || status === "under",
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
  operation: ChapterOperation | { type: "plan-revise" },
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
    startedAt: undefined,
    completedAt: undefined,
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
  let state = options.finalAgent
    ? {
        ...initial,
        manuscript: rebuildManuscript(initial),
        agents: initial.agents.map((agent) => agent.id === options.finalAgent
          ? { id: agent.id, status: "pending" as const }
          : agent),
      }
    : initial;
  if (
    !options.finalAgent
    &&
    operation.type === "resume"
    && initial.agents.every(({ status }) => status === "completed")
  ) {
    await runtime.writeArtifacts(initial);
    return initial;
  }
  if (initial.agents.some(({ status }) => status === "running")) {
    throw new RunConflictError("run-conflict");
  }
  if (initial.workflow.awaitingApproval) {
    return initial;
  }

  if (state.workflow.stage === "launcher") {
    state = setWorkflowStage(state, "planning");
  }
  let resolvedGenerate = generate;
  const log = options.log ?? defaultLog;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const localDebug = options.localDebug ?? process.env.NOVELGEN_LOCAL_DEBUG === "1";
  for (const definition of agentDefinitions) {
    if (options.finalAgent && definition.id !== options.finalAgent) continue;
    if (
      definition.id === "editor"
      && state.workflow.stage === "drafting"
      && hasChapterCoverage(state)
    ) {
      state = await save(runtime, setWorkflowStage(state, "final"));
    }
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
    if (definition.id === "drafting" && state.workflow.stage !== "drafting") {
      state = await save(runtime, setWorkflowStage(state, "drafting"));
    }
    try {
      options.signal?.throwIfAborted();
      const agentSignal = AbortSignal.any([
        ...(options.signal ? [options.signal] : []),
        AbortSignal.timeout(options.timeouts?.agentMs ?? DEFAULT_AGENT_TIMEOUT_MS),
      ]);
      resolvedGenerate ??= createGenerateFromEnv();
      if (definition.id === "drafting") {
        state = await runDrafting(runtime, state, resolvedGenerate, operation, agentSignal, {
          alternateGenerate: options.alternateGenerate,
          log,
          localDebug,
          retryDelayMs,
          callTimeoutMs: options.timeouts?.callMs ?? CHAPTER_CALL_TIMEOUT_MS,
          parseTimeoutMs: options.timeouts?.parseMs ?? DEFAULT_PARSE_TIMEOUT_MS,
        });
        if (!hasChapterCoverage(state)) {
          throw new PipelineStepError(
            state,
            false,
            state.chapterRuns.find(({ status }) => status === "failed")?.error ?? EXECUTION_ERROR,
          );
        }
      } else {
        const result = await invoke(state, definition.id, resolvedGenerate, {
          signal: agentSignal,
          alternateGenerate: options.alternateGenerate,
          log,
          localDebug,
          retryDelayMs,
          callTimeoutMs: options.timeouts?.callMs
            ?? DEFAULT_CALL_TIMEOUT_MS,
          parseTimeoutMs: options.timeouts?.parseMs ?? DEFAULT_PARSE_TIMEOUT_MS,
        });
        const mergeStarted = performance.now();
        state = {
          ...state,
          bible: mergeAgentOutput(state.bible, definition.id, result.output),
          completedOutputs: { ...state.completedOutputs, [definition.id]: result.output },
        };
        log("pipeline.stage", {
          agentId: definition.id,
          stage: "merge",
          elapsedMs: performance.now() - mergeStarted,
        });
        state = setAgent(state, definition.id, result.recovery);
      }
      if (definition.id === "drafting") {
        const recovered = state.chapterRuns.some(({ autoRecovered }) => autoRecovered);
        const fallback = state.chapterRuns.some(({ fallbackUsed }) => fallbackUsed);
        state = setAgent(state, definition.id, {
          autoRecovered: recovered,
          fallbackUsed: fallback,
          attemptCount: Math.max(...state.chapterRuns.map(({ attemptCount }) => attemptCount ?? 0)),
          maxAttempts: Math.max(...state.chapterRuns.map(({ maxAttempts }) => maxAttempts ?? 0)),
          lastRetryError: state.chapterRuns.slice().reverse()
            .find(({ lastRetryError }) => lastRetryError)?.lastRetryError,
        });
      }
      state = setAgent(state, definition.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
        error: undefined,
      });
      state = await save(runtime, state);
      if (definition.id === "chapter-outline") {
        if (state.configuration.requireApproval && !state.workflow.approvedAt) {
          state = await save(runtime, {
            ...setWorkflowStage(state, "approval"),
            workflow: {
              ...setWorkflowStage(state, "approval").workflow,
              awaitingApproval: true,
            },
          });
          await runtime.writeApprovalArtifact?.(state);
          return state;
        }
        state = await save(runtime, setWorkflowStage(state, "drafting"));
      } else if (definition.id === "drafting") {
        state = await save(runtime, setWorkflowStage(state, "final"));
      }
    } catch (cause) {
      const rootCause = underlyingCause(cause);
      if (cause instanceof PipelineStepError) state = cause.state;
      if (
        options.signal?.aborted
        || classifyRecovery(rootCause) === "abort"
        || cause instanceof PipelineStepError && cause.cancelled
      ) {
        return save(runtime, cancelRunning(state, definition.id, operation));
      }
      state = setAgent(state, definition.id, {
        status: "failed",
        error: cause instanceof PipelineStepError ? cause.summary : actionableError(rootCause),
        attemptCount: cause instanceof PipelineStepError
          ? state.chapterRuns.find(({ status }) => status === "failed")?.attemptCount
            ?? MAX_CLIENT_ATTEMPTS * (options.alternateGenerate ? 2 : 1)
          : attemptedCount(
              cause,
              MAX_CLIENT_ATTEMPTS * (options.alternateGenerate ? 2 : 1),
            ),
        maxAttempts: cause instanceof PipelineStepError
          ? state.chapterRuns.find(({ status }) => status === "failed")?.maxAttempts
            ?? MAX_CLIENT_ATTEMPTS * (options.alternateGenerate ? 2 : 1)
          : MAX_CLIENT_ATTEMPTS * (options.alternateGenerate ? 2 : 1),
        lastRetryError: cause instanceof PipelineStepError
          ? state.chapterRuns.find(({ status }) => status === "failed")?.lastRetryError
            ?? sanitizeErrorMessage(rootCause)
          : sanitizeErrorMessage(rootCause),
      });
      return save(runtime, state);
    }
  }
  await runtime.writeArtifacts(state);
  return state;
}

export async function revisePlan(
  initial: PipelineProjectState,
  runtime: PipelineRuntime,
  instruction: string,
  generate?: Generate,
  signal?: AbortSignal,
): Promise<PipelineProjectState> {
  let working = await save(runtime, setAgent(initial, "chapter-outline", {
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: undefined,
    error: undefined,
  }));
  let result: InvokeResult;
  try {
    result = await invoke(
      working,
      "chapter-outline",
      generate ?? createGenerateFromEnv(),
      {
        operation: "plan-revise",
        instruction,
        signal,
        log: defaultLog,
        localDebug: process.env.NOVELGEN_LOCAL_DEBUG === "1",
        retryDelayMs: DEFAULT_RETRY_DELAY_MS,
        callTimeoutMs: DEFAULT_CALL_TIMEOUT_MS,
        parseTimeoutMs: DEFAULT_PARSE_TIMEOUT_MS,
      },
    );
  } catch (cause) {
    if (wasCancelled(signal) || classifyRecovery(underlyingCause(cause)) === "abort") {
      return save(runtime, cancelRunning(working, "chapter-outline", { type: "plan-revise" }));
    }
    working = await save(runtime, setAgent(working, "chapter-outline", {
      status: "failed",
      completedAt: undefined,
      error: actionableError(underlyingCause(cause)),
      attemptCount: attemptedCount(cause, MAX_CLIENT_ATTEMPTS),
      maxAttempts: MAX_CLIENT_ATTEMPTS * 2,
      lastRetryError: sanitizeErrorMessage(underlyingCause(cause)),
    }));
    return working;
  }
  try {
    working = setAgent(working, "chapter-outline", {
      ...result.recovery,
      status: "completed",
      completedAt: new Date().toISOString(),
      error: undefined,
    });
    const revision = result.output as PlanRevisionOutput;
    const current = approvalOutline(working);
    const protectedBible = mergeAgentOutput(working.bible, "chapter-outline", {
      ...current,
      ...revision.patch,
    });
    let next = approveChapterOutline(working, approvalOutline({
      ...working,
      bible: protectedBible,
    }));
    if (revision.structureChanged) {
      const mark = <T extends { needsRevision?: boolean }>(chapter: T): T => ({
        ...chapter,
        needsRevision: true,
      });
      next = {
        ...next,
        bible: {
          ...next.bible,
          parts: next.bible.parts.map((part) => ({
            ...part,
            chapters: part.chapters.map(mark),
          })),
          chapters: next.bible.chapters.map(mark),
        },
      };
    }
    next = {
      ...next,
      completedOutputs: {
        ...next.completedOutputs,
        "plan-revise": [
          ...((next.completedOutputs["plan-revise"] as PlanRevisionOutput[] | undefined) ?? []),
          revision,
        ],
      },
    };
    if (working.configuration.requireApproval) {
      next = {
        ...setWorkflowStage(next, "approval"),
        workflow: {
          ...setWorkflowStage(next, "approval").workflow,
          awaitingApproval: true,
          approvedAt: undefined,
        },
      };
    }
    await runtime.writeApprovalArtifact?.(next);
    return save(runtime, next);
  } catch (cause) {
    return save(runtime, setAgent(working, "chapter-outline", {
      ...result.recovery,
      status: "failed",
      completedAt: undefined,
      error: `章構成の更新内容を確認して、もう一度改稿してください。 (${sanitizeErrorMessage(cause)})`,
      lastRetryError: sanitizeErrorMessage(cause),
    }));
  }
}
