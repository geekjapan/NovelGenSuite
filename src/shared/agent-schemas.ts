import { z } from "zod";

const text = (maximum = 2_000) => z.string().trim().min(1).transform((value) => value.slice(0, maximum));
const list = <T extends z.ZodType>(schema: T, maximum: number) =>
  z.array(schema).transform((values) => values.slice(0, maximum));
const shortText = text(280);

export const ConceptOutputSchema = z.object({
  logline: shortText,
  coreTheme: shortText,
  centralConflict: shortText,
  emotionalPromise: shortText,
  uniqueHook: shortText,
});

export const CharacterSchema = z.object({
  name: text(80),
  role: text(80),
  desire: shortText,
  fear: shortText,
  flaw: shortText,
  secret: shortText,
  arc: shortText,
  speechStyle: shortText,
});

export const CharacterOutputSchema = z.object({
  protagonist: CharacterSchema,
  antagonist: CharacterSchema,
  supporting: list(CharacterSchema, 8),
});

export const WorldbuildingOutputSchema = z.object({
  setting: shortText,
  rules: list(shortText, 8),
  socialContext: shortText,
  atmosphere: shortText,
  locations: list(shortText, 6),
  symbols: list(shortText, 6),
});

export const ForeshadowingPlanSchema = z.object({
  item: text(120),
  introduction: text(200),
  payoff: text(200),
});

export const PlotOutputSchema = z.object({
  beginning: text(500),
  middle: text(500),
  climax: text(500),
  ending: text(500),
  twists: list(text(120), 8),
  foreshadowingPlan: list(ForeshadowingPlanSchema, 8),
});

export const LengthPlanSchema = z.object({
  target: z.number().int().positive(),
  unit: z.enum(["characters", "words"]),
  min: z.number().int().positive(),
  max: z.number().int().positive(),
}).refine(({ min, target, max }) => min <= target && target <= max, {
  message: "length plan must satisfy min <= target <= max",
});

export const ChapterRoleSchema = z.enum([
  "Opening",
  "Development",
  "Climax",
  "Resolution",
]);

export const ChapterSchema = z.object({
  id: z.string().min(1),
  partNumber: z.number().int().positive(),
  number: z.number().int().positive(),
  role: ChapterRoleSchema,
  title: text(120),
  purpose: text(120),
  emotionalTurn: z.string().trim().transform((value) => value.slice(0, 120)),
  keyEvents: list(text(120), 5),
  foreshadowing: list(text(120), 3),
  lengthPlan: LengthPlanSchema,
  draft: z.string().optional(),
  chapterSummary: z.string().trim().max(500).optional(),
  continuityNotes: list(text(280), 8).optional(),
  needsRevision: z.boolean().optional(),
});

export const PartSchema = z.object({
  id: z.string().min(1),
  number: z.number().int().positive(),
  title: text(120),
  chapters: z.array(ChapterSchema).min(1).transform((values) => values.slice(0, 64)),
});

const ChapterOutlinePartSchema = PartSchema.extend({
  chapters: z.array(ChapterSchema.extend({
    keyEvents: list(text(120), 2),
    foreshadowing: list(text(120), 1),
  })).min(1).transform((values) => values.slice(0, 64)),
});

export const StyleGuideSchema = z.object({
  pov: text(80),
  tense: text(80),
  proseStyle: shortText,
  dialogueNotes: shortText,
  taboos: list(text(120), 8),
});

export const ForeshadowingTrackerItemSchema = z.object({
  item: text(120),
  introducedIn: z.number().int().positive(),
  status: z.enum(["planned", "unresolved", "paid-off"]),
  suggestedPayoff: text(200),
  payoffChapter: z.number().int().positive().nullable(),
  emotionalPurpose: text(200),
});

export const ChapterOutlineOutputSchema = z.object({
  parts: z.array(ChapterOutlinePartSchema).min(1).transform((values) => values.slice(0, 16)),
  styleGuide: StyleGuideSchema,
  foreshadowingTracker: list(ForeshadowingTrackerItemSchema, 3),
}).superRefine(({ parts }, context) => {
  const chapters = parts.flatMap((part) => part.chapters);
  if (new Set(parts.map(({ number }) => number)).size !== parts.length) {
    context.addIssue({
      code: "custom",
      path: ["parts"],
      message: "part numbers must be unique",
    });
  }
  if (new Set(chapters.map(({ number }) => number)).size !== chapters.length) {
    context.addIssue({
      code: "custom",
      path: ["parts"],
      message: "chapter numbers must be unique",
    });
  }
  for (const [partIndex, part] of parts.entries()) {
    for (const [chapterIndex, chapter] of part.chapters.entries()) {
      if (chapter.partNumber !== part.number) {
        context.addIssue({
          code: "custom",
          path: ["parts", partIndex, "chapters", chapterIndex, "partNumber"],
          message: "chapter partNumber must match its part",
        });
      }
    }
  }
});

export const DraftingOutputSchema = z.object({
  chapterNumber: z.number().int().positive(),
  draft: text(50_000),
  chapterSummary: text(500),
  continuityNotes: list(text(280), 8),
});

export const ExpansionOutputSchema = z.object({
  draft: text(50_000),
  expansionSummary: text(500),
});

export const ChapterRevisionOutputSchema = z.object({
  chapterNumber: z.number().int().positive(),
  draft: text(50_000),
  chapterSummary: text(500),
});

export const PlanRevisionOutputSchema = z.object({
  patch: z.object({
    parts: z.array(ChapterOutlinePartSchema).min(1).max(16).optional(),
    styleGuide: StyleGuideSchema.optional(),
    foreshadowingTracker: z.array(ForeshadowingTrackerItemSchema).max(3).optional(),
  }),
  explanation: text(500),
  structureChanged: z.boolean(),
});

export const EditorOutputSchema = z.object({
  strengths: list(shortText, 12),
  weakPoints: list(shortText, 12),
  pacing: list(shortText, 12),
  dialogue: list(shortText, 12),
  emotionalClarity: list(shortText, 12),
  revisionSuggestions: list(shortText, 12),
});

export const ContinuityIssueSchema = z.object({
  category: z.enum(["character", "world", "plot", "time", "foreshadowing"]),
  severity: z.enum(["low", "medium", "high"]),
  chapterNumber: z.number().int().positive().nullable(),
  description: shortText,
  suggestion: shortText,
});

export const ContinuityOutputSchema = z.object({
  issues: list(ContinuityIssueSchema, 24),
  unresolvedForeshadowing: list(shortText, 12),
  missingPayoffs: list(shortText, 12),
  overallAssessment: text(500),
});

export const PublisherOutputSchema = z.object({
  titleIdeas: z.array(text(120)).min(1).transform((values) => values.slice(0, 8)),
  shortSynopsis: text(500),
  longSynopsis: text(2_000),
  logline: shortText,
  tagline: text(120),
  socialPosts: list(text(280), 6),
  submissionDescription: text(1_000),
}).transform((output) => ({ ...output, promotedTitle: output.titleIdeas[0]! }));

export type ConceptOutput = z.infer<typeof ConceptOutputSchema>;
export type CharacterOutput = z.infer<typeof CharacterOutputSchema>;
export type WorldbuildingOutput = z.infer<typeof WorldbuildingOutputSchema>;
export type PlotOutput = z.infer<typeof PlotOutputSchema>;
export type ChapterOutlineOutput = z.infer<typeof ChapterOutlineOutputSchema>;
export type DraftingOutput = z.infer<typeof DraftingOutputSchema>;
export type PlanRevisionOutput = z.infer<typeof PlanRevisionOutputSchema>;
export type EditorOutput = z.infer<typeof EditorOutputSchema>;
export type ContinuityOutput = z.infer<typeof ContinuityOutputSchema>;
export type PublisherOutput = z.infer<typeof PublisherOutputSchema>;
export type Chapter = z.infer<typeof ChapterSchema>;
export type Part = z.infer<typeof PartSchema>;
