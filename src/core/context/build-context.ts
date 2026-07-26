import type { z } from "zod";

import {
  CharacterOutputSchema,
  ChapterOutlineOutputSchema,
  ConceptOutputSchema,
  PlotOutputSchema,
  WorldbuildingOutputSchema,
  type Chapter,
  type Part,
  type CharacterOutput,
  type ConceptOutput,
  type PlotOutput,
  type WorldbuildingOutput,
} from "../../shared/agent-schemas.js";
import {
  findLanguagePolicy,
  type SupportedLanguage,
} from "../../shared/contracts.js";
import type { StoryBible } from "../../shared/story-bible.js";

export type BuildContextInput = {
  prompt: string;
  language: SupportedLanguage;
  bible: StoryBible;
  completedOutputs: Partial<Record<string, unknown>>;
  chapterNumber?: number;
  manuscript?: string;
  currentDraft?: string;
};

export type AgentContext = {
  language: SupportedLanguage;
  prompt: string;
  concept?: ConceptOutput;
  characters?: CharacterOutput;
  worldbuilding?: WorldbuildingOutput;
  plot?: PlotOutput;
  chapterSkeleton?: Array<Pick<Part, "id" | "number" | "title"> & {
    chapters: Array<Pick<Chapter, "id" | "partNumber" | "number" | "role" | "lengthPlan">>;
  }>;
  outline?: Array<Pick<Chapter, "number" | "title" | "purpose" | "keyEvents" | "foreshadowing">>;
  targetChapter?: Pick<Chapter, "number" | "title" | "purpose" | "emotionalTurn" | "keyEvents" | "foreshadowing" | "lengthPlan">;
  priorChapterSummaries?: Array<{ chapterNumber: number; summary: string }>;
  previousChapterEnding?: string;
  currentDraft?: string;
  manuscript?: string;
  chapterSummaries?: Array<{ chapterNumber: number; summary: string }>;
  foreshadowingTracker?: StoryBible["foreshadowingTracker"];
  priorReports?: Array<string>;
  title?: string;
  shortSynopsis?: string;
};

const clip = (value: string, maximum: number) => value.slice(0, maximum);

const completedOr = <T extends z.ZodType>(
  input: BuildContextInput,
  id: string,
  schema: T,
  fallback: z.infer<T> | null,
): z.infer<T> | undefined => {
  const parsed = schema.safeParse(input.completedOutputs[id]);
  return parsed.success ? parsed.data : (fallback ?? undefined);
};

const common = (input: BuildContextInput) => {
  const policy = findLanguagePolicy(input.language);
  if (!policy) throw new Error(`Unsupported language: ${input.language}`);
  const maximum = policy.promptHeadCharacters + policy.promptTailCharacters;
  const prompt = input.prompt.length <= maximum
    ? input.prompt
    : `${input.prompt.slice(0, policy.promptHeadCharacters)}\n${policy.omissionMarker}\n${input.prompt.slice(-policy.promptTailCharacters)}`;
  return { policy, prompt };
};

const concept = (input: BuildContextInput) => {
  const source = completedOr(input, "concept", ConceptOutputSchema, input.bible.concept);
  return source && {
    logline: clip(source.logline, 280),
    coreTheme: clip(source.coreTheme, 280),
    centralConflict: clip(source.centralConflict, 280),
    emotionalPromise: clip(source.emotionalPromise, 280),
    uniqueHook: clip(source.uniqueHook, 280),
  };
};

const characters = (input: BuildContextInput) => {
  const source = completedOr(input, "character", CharacterOutputSchema, input.bible.characters);
  if (!source) return undefined;
  const compress = (character: CharacterOutput["protagonist"]) => ({
    ...character,
    name: clip(character.name, 80),
    role: clip(character.role, 80),
    desire: clip(character.desire, 280),
    fear: clip(character.fear, 280),
    flaw: clip(character.flaw, 280),
    secret: clip(character.secret, 280),
    arc: clip(character.arc, 280),
    speechStyle: clip(character.speechStyle, 280),
  });
  return {
    protagonist: compress(source.protagonist),
    antagonist: compress(source.antagonist),
    supporting: source.supporting.slice(0, 8).map(compress),
  };
};

const worldbuilding = (input: BuildContextInput) => {
  const source = completedOr(
    input,
    "worldbuilding",
    WorldbuildingOutputSchema,
    input.bible.worldbuilding,
  );
  return source && {
    ...source,
    rules: source.rules.slice(0, 8),
    locations: source.locations.slice(0, 6),
    symbols: source.symbols.slice(0, 6),
  };
};

const plot = (input: BuildContextInput) => {
  const source = completedOr(input, "plot", PlotOutputSchema, input.bible.plot);
  return source && {
    ...source,
    beginning: clip(source.beginning, 200),
    middle: clip(source.middle, 200),
    climax: clip(source.climax, 200),
    ending: clip(source.ending, 200),
    twists: source.twists.slice(0, 3).map((item) => clip(item, 120)),
    foreshadowingPlan: source.foreshadowingPlan.slice(0, 8),
  };
};

const planningContext = (input: BuildContextInput): AgentContext => ({
  language: input.language,
  prompt: common(input).prompt,
  concept: concept(input),
  characters: characters(input),
  worldbuilding: worldbuilding(input),
  plot: plot(input),
});

export const buildConceptContext = (input: BuildContextInput): AgentContext => ({
  language: input.language,
  prompt: common(input).prompt,
});

export const buildCharacterContext = (input: BuildContextInput): AgentContext => ({
  language: input.language,
  prompt: common(input).prompt,
  concept: concept(input),
});

export const buildWorldbuildingContext = (input: BuildContextInput): AgentContext => ({
  language: input.language,
  prompt: common(input).prompt,
  concept: concept(input),
  characters: characters(input),
});

export const buildPlotContext = planningContext;
export const buildChapterOutlineContext = (input: BuildContextInput): AgentContext => ({
  ...planningContext(input),
  chapterSkeleton: input.bible.parts.map(({ id, number, title, chapters }) => ({
    id,
    number,
    title,
    chapters: chapters.map(({ id: chapterId, partNumber, number: chapterNumber, role, lengthPlan }) => ({
      id: chapterId,
      partNumber,
      number: chapterNumber,
      role,
      lengthPlan,
    })),
  })),
});

const outline = (bible: StoryBible): AgentContext["outline"] => bible.chapters
  .slice()
  .sort((left, right) => left.number - right.number)
  .slice(0, 64)
  .map(({ number, title, purpose, keyEvents, foreshadowing }) => ({
    number,
    title: clip(title, 120),
    purpose: clip(purpose, 120),
    keyEvents: keyEvents.slice(0, 2),
    foreshadowing: foreshadowing.slice(0, 1),
  }));

const selectedOutline = (input: BuildContextInput) => {
  const completed = ChapterOutlineOutputSchema.safeParse(input.completedOutputs["chapter-outline"]);
  return completed.success
    ? completed.data.parts.flatMap(({ chapters }) => chapters)
    : input.bible.chapters;
};

export const buildDraftingContext = (input: BuildContextInput): AgentContext => {
  const { policy, prompt } = common(input);
  if (!input.chapterNumber) throw new Error("drafting context requires chapterNumber");
  const ordered = selectedOutline(input).slice().sort((left, right) => left.number - right.number);
  const target = ordered.find(({ number }) => number === input.chapterNumber);
  if (!target) throw new Error(`Unknown chapter: ${input.chapterNumber}`);
  const previous = input.bible.chapters.find(({ number }) => number === input.chapterNumber! - 1);
  return {
    ...planningContext(input),
    prompt,
    outline: outline({ ...input.bible, chapters: ordered }),
    targetChapter: {
      number: target.number,
      title: target.title,
      purpose: target.purpose,
      emotionalTurn: target.emotionalTurn,
      keyEvents: target.keyEvents.slice(0, 5),
      foreshadowing: target.foreshadowing.slice(0, 3),
      lengthPlan: target.lengthPlan,
    },
    priorChapterSummaries: input.bible.chapters
      .slice()
      .sort((left, right) => left.number - right.number)
      .filter(({ number, chapterSummary }) => number < target.number && chapterSummary)
      .map(({ number, chapterSummary }) => ({ chapterNumber: number, summary: chapterSummary! })),
    previousChapterEnding: previous?.draft && (policy.lengthUnit === "words"
      ? previous.draft.trim().split(/\s+/).slice(-100).join(" ")
      : previous.draft.slice(-policy.previousChapterTailCharacters)),
    currentDraft: input.currentDraft,
  };
};

const manuscript = (input: BuildContextInput) => input.manuscript ?? input.bible.chapters
  .slice()
  .sort((left, right) => left.number - right.number)
  .map(({ draft }) => draft ?? "")
  .join("\n\n");

const manuscriptContext = (input: BuildContextInput): AgentContext => {
  const { policy } = common(input);
  const text = manuscript(input);
  return {
    ...planningContext(input),
    manuscript: text.length <= 8_000
      ? text
      : `${text.slice(0, 4_000)}\n${policy.omissionMarker}\n${text.slice(-4_000)}`,
  };
};

export const buildEditorContext = (input: BuildContextInput): AgentContext => ({
  ...manuscriptContext(input),
  priorReports: input.bible.editorReport?.revisionSuggestions.slice(0, 4),
});

export const buildContinuityContext = (input: BuildContextInput): AgentContext => {
  const { policy } = common(input);
  const text = manuscript(input);
  return {
    ...planningContext(input),
    manuscript: [
      text.slice(0, 1_500),
      text.slice(Math.max(0, Math.floor(text.length / 2) - 750), Math.floor(text.length / 2) + 750),
      text.slice(-1_500),
    ].join(`\n${policy.excerptMarker}\n`),
    chapterSummaries: input.bible.chapters
      .filter(({ chapterSummary }) => chapterSummary)
      .map(({ number, chapterSummary }) => ({ chapterNumber: number, summary: chapterSummary! })),
    foreshadowingTracker: input.bible.foreshadowingTracker.slice(0, 8),
  };
};

export const buildPublisherContext = (input: BuildContextInput): AgentContext => ({
  language: input.language,
  prompt: common(input).prompt,
  title: input.bible.parts[0]?.title,
  concept: concept(input),
  characters: characters(input),
  plot: plot(input),
  manuscript: manuscript(input).slice(-2_000),
  shortSynopsis: input.bible.publisherPackage?.shortSynopsis
    ?? input.bible.concept?.logline,
  chapterSummaries: input.bible.chapters
    .filter(({ chapterSummary }) => chapterSummary)
    .map(({ number, chapterSummary }) => ({ chapterNumber: number, summary: chapterSummary! })),
});
