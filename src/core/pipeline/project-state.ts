import { z } from "zod";

import { StoryBibleSchema, emptyStoryBible } from "../../shared/story-bible.js";
import {
  findLanguagePolicy,
  ProjectStateSchema,
  WorkflowStageSchema,
  type WorkflowStage,
} from "../../shared/contracts.js";
import {
  ChapterOutlineOutputSchema,
  type Chapter,
} from "../../shared/agent-schemas.js";
import { agentDefinitions, type AgentId } from "../registry/agent-registry.js";

const CancellationAttemptSchema = z.object({
  type: z.literal("cancellation"),
  operation: z.enum([
    "resume",
    "retry",
    "regenerate",
    "expand",
    "revise",
    "plan-revise",
    "auto-expand",
  ]),
  attemptedAt: z.iso.datetime(),
});

const AgentRunSchema = z.object({
  id: z.enum(agentDefinitions.map(({ id }) => id) as [AgentId, ...AgentId[]]),
  status: z.enum(["pending", "running", "completed", "failed"]),
  startedAt: z.iso.datetime().optional(),
  completedAt: z.iso.datetime().optional(),
  error: z.string().optional(),
  attemptCount: z.number().int().nonnegative().optional(),
  maxAttempts: z.number().int().positive().optional(),
  lastRetryError: z.string().optional(),
  fallbackUsed: z.boolean().optional(),
  autoRecovered: z.boolean().optional(),
  attempts: z.array(CancellationAttemptSchema).optional(),
});

const ChapterRunSchema = z.object({
  chapterNumber: z.number().int().positive(),
  status: z.enum(["pending", "generating", "completed", "failed", "edited"]),
  lengthStatus: z.enum(["too-short", "under", "near", "over"]).optional(),
  needsExpansion: z.boolean().optional(),
  error: z.string().optional(),
  attemptCount: z.number().int().nonnegative().optional(),
  maxAttempts: z.number().int().positive().optional(),
  lastRetryError: z.string().optional(),
  fallbackUsed: z.boolean().optional(),
  autoRecovered: z.boolean().optional(),
  attempts: z.array(CancellationAttemptSchema).optional(),
});

export const PipelineProjectStateSchema = ProjectStateSchema.extend({
  workflow: z.object({
    stage: WorkflowStageSchema,
    reached: z.array(WorkflowStageSchema),
    awaitingApproval: z.boolean(),
    approvedAt: z.iso.datetime().optional(),
  }).default({
    stage: "launcher",
    reached: ["launcher"],
    awaitingApproval: false,
  }),
  bible: StoryBibleSchema,
  agents: z.array(AgentRunSchema),
  chapterRuns: z.array(ChapterRunSchema),
  completedOutputs: z.record(z.string(), z.unknown()),
  manuscript: z.string().nullable(),
});

export type PipelineProjectState = z.infer<typeof PipelineProjectStateSchema>;

export class InvalidWorkflowTransitionError extends Error {}

const stages: WorkflowStage[] = ["launcher", "planning", "approval", "drafting", "final"];
const touched = (state: PipelineProjectState): PipelineProjectState => ({
  ...state,
  meta: { ...state.meta, updatedAt: new Date().toISOString() },
});

export function setWorkflowStage(
  state: PipelineProjectState,
  stage: WorkflowStage,
): PipelineProjectState {
  return touched({
    ...state,
    workflow: {
      ...state.workflow,
      stage,
      reached: state.workflow.reached.includes(stage)
        ? state.workflow.reached
        : [...state.workflow.reached, stage],
    },
  });
}

export function moveToReachedStage(
  state: PipelineProjectState,
  stage: WorkflowStage,
  confirmed: boolean,
): PipelineProjectState {
  if (!state.workflow.reached.includes(stage)) {
    throw new InvalidWorkflowTransitionError("unreached-stage");
  }
  if (stages.indexOf(stage) < stages.indexOf(state.workflow.stage) && !confirmed) {
    throw new InvalidWorkflowTransitionError("confirmation-required");
  }
  return setWorkflowStage(state, stage);
}

export function approveChapterOutline(
  state: PipelineProjectState,
  rawOutline: unknown,
): PipelineProjectState {
  const outline = ChapterOutlineOutputSchema.parse(rawOutline);
  const proposed = outline.parts.flatMap(({ chapters }) => chapters);
  const existingPartNumbers = new Set(state.bible.parts.map(({ number }) => number));
  if (
    proposed.length !== state.configuration.chapterCount
    || proposed.some(({ number }) =>
      !state.chapterRuns.some(({ chapterNumber }) => chapterNumber === number))
    || outline.parts.length !== state.bible.parts.length
    || outline.parts.some(({ number }) => !existingPartNumbers.has(number))
  ) {
    throw new InvalidWorkflowTransitionError("outline-structure-mismatch");
  }

  const proposedChapters = new Map(proposed.map((chapter) => [chapter.number, chapter]));
  const oldRuns = new Map(state.chapterRuns.map((run) => [run.chapterNumber, run]));
  const keep = (number: number) => {
    const status = oldRuns.get(number)?.status;
    return status === "completed" || status === "edited";
  };
  const mergeChapter = (existing: Chapter): Chapter => {
    const chapter = proposedChapters.get(existing.number)!;
    const {
      draft: _draft,
      chapterSummary: _chapterSummary,
      continuityNotes: _continuityNotes,
      needsRevision: _needsRevision,
      ...editable
    } = chapter;
    const merged = {
      ...editable,
      id: existing.id,
      partNumber: existing.partNumber,
      number: existing.number,
      role: existing.role,
      lengthPlan: {
        ...chapter.lengthPlan,
        unit: existing.lengthPlan.unit,
      },
    };
    return keep(existing.number)
      ? {
          ...merged,
          draft: existing.draft,
          chapterSummary: existing.chapterSummary,
          continuityNotes: existing.continuityNotes,
          needsRevision: existing.needsRevision,
        }
      : merged;
  };
  const parts = state.bible.parts.map((existing) => ({
    ...outline.parts.find(({ number }) => number === existing.number)!,
    id: existing.id,
    number: existing.number,
    chapters: existing.chapters.map(mergeChapter),
  }));
  const chapterRuns = proposed.map(({ number }) => {
    const run = oldRuns.get(number)!;
    return keep(number)
      ? run
      : {
          ...run,
          status: "pending" as const,
          lengthStatus: undefined,
          needsExpansion: undefined,
          error: undefined,
        };
  });
  const draftingComplete = chapterRuns.every(({ status }) =>
    status === "completed" || status === "edited");
  const draftingIndex = agentDefinitions.findIndex(({ id }) => id === "drafting");
  return setWorkflowStage({
    ...state,
    bible: {
      ...state.bible,
      parts,
      chapters: parts.flatMap(({ chapters }) => chapters)
        .sort((left, right) => left.number - right.number),
      styleGuide: outline.styleGuide,
      foreshadowingTracker: outline.foreshadowingTracker,
    },
    completedOutputs: { ...state.completedOutputs, "chapter-outline": outline },
    chapterRuns,
    manuscript: draftingComplete ? state.manuscript : null,
    agents: state.agents.map((agent, index) => {
      if (index < draftingIndex) return agent;
      if (index === draftingIndex && draftingComplete) return agent;
      return {
        id: agent.id,
        status: "pending" as const,
      };
    }),
    workflow: {
      ...state.workflow,
      awaitingApproval: false,
      approvedAt: new Date().toISOString(),
    },
  }, "drafting");
}

const chapterRole = (number: number, count: number) => {
  if (number === 1) return "Opening" as const;
  if (number === count) return "Resolution" as const;
  if (number === Math.ceil(count / 2)) return "Climax" as const;
  return "Development" as const;
};

export function initializePipelineState(
  input: z.input<typeof ProjectStateSchema>,
): PipelineProjectState {
  const state = ProjectStateSchema.parse(input);
  const { chapterCount, chapterLength } = state.configuration;
  const unit = findLanguagePolicy(state.language)!.lengthUnit;
  const chapters = Array.from({ length: chapterCount }, (_, index) => {
    const number = index + 1;
    return {
      id: `chapter-${number}`,
      partNumber: 1,
      number,
      role: chapterRole(number, chapterCount),
      title: `第${number}章`,
      purpose: `第${number}章の目的`,
      emotionalTurn: "",
      keyEvents: [],
      foreshadowing: [],
      lengthPlan: {
        target: chapterLength,
        unit,
        min: Math.max(1, Math.floor(chapterLength * 0.85)),
        max: Math.ceil(chapterLength * 1.15),
      },
    };
  });
  const bible = emptyStoryBible();
  bible.parts = [{ id: "part-1", number: 1, title: "第一部", chapters }];
  bible.chapters = chapters;

  return PipelineProjectStateSchema.parse({
    ...state,
    workflow: {
      stage: "launcher",
      reached: ["launcher"],
      awaitingApproval: false,
    },
    bible,
    agents: agentDefinitions.map(({ id }) => ({ id, status: "pending" })),
    chapterRuns: chapters.map(({ number }) => ({ chapterNumber: number, status: "pending" })),
    completedOutputs: {},
    manuscript: null,
  });
}
