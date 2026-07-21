import { z } from "zod";

import {
  ContinuityOutputSchema,
  EditorOutputSchema,
  PublisherOutputSchema,
} from "./agent-schemas.js";

export const DEFAULT_CONFIGURATION = {
  chapterCount: 2,
  chapterLength: 2000,
  requireApproval: false,
} as const;

export const ConfigurationSchema = z.object({
  chapterCount: z.number().int().min(1).max(64).default(DEFAULT_CONFIGURATION.chapterCount),
  chapterLength: z.number().int().positive().default(DEFAULT_CONFIGURATION.chapterLength),
  requireApproval: z.boolean().default(DEFAULT_CONFIGURATION.requireApproval),
});
export type Configuration = z.infer<typeof ConfigurationSchema>;

export const languagePolicies = {
  ja: {
    locale: "ja-JP",
    lengthUnit: "characters",
    promptHeadCharacters: 600,
    promptTailCharacters: 300,
    previousChapterTailCharacters: 300,
    omissionMarker: "…省略…",
    excerptMarker: "…抜粋…",
  },
} as const;

export const SupportedLanguageSchema = z.enum(["ja"]);
export type SupportedLanguage = z.infer<typeof SupportedLanguageSchema>;

export function findLanguagePolicy(language: string) {
  const result = SupportedLanguageSchema.safeParse(language);
  return result.success ? languagePolicies[result.data] : undefined;
}

export const CreateProjectRequestSchema = z.object({
  prompt: z.string().trim().min(1),
  language: z.string().default("ja"),
  configuration: ConfigurationSchema.default(DEFAULT_CONFIGURATION),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

export const ProjectStateSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/),
  prompt: z.string().min(1),
  language: SupportedLanguageSchema,
  configuration: ConfigurationSchema,
  meta: z.object({
    schemaVersion: z.literal(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  }),
});
export type ProjectState = z.infer<typeof ProjectStateSchema>;

export const WebProjectStateSchema = ProjectStateSchema.pick({
  id: true,
  prompt: true,
  meta: true,
}).extend({
  agents: z.array(z.object({
    id: z.string(),
    status: z.enum(["pending", "running", "completed", "failed"]),
    startedAt: z.iso.datetime().optional(),
    completedAt: z.iso.datetime().optional(),
    error: z.string().optional(),
  })),
  chapterRuns: z.array(z.object({
    status: z.enum(["pending", "generating", "completed", "failed", "edited"]),
  })),
  manuscript: z.string().nullable(),
  bible: z.object({
    editorReport: EditorOutputSchema.nullable(),
    continuityReport: ContinuityOutputSchema.nullable(),
    publisherPackage: PublisherOutputSchema.nullable(),
  }),
});
export type WebProjectState = z.infer<typeof WebProjectStateSchema>;

export const ProjectSummarySchema = z.object({
  id: ProjectStateSchema.shape.id,
  createdAt: ProjectStateSchema.shape.meta.shape.createdAt,
});
export const ProjectListResponseSchema = z.array(ProjectSummarySchema);
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export const ErrorCodeSchema = z.enum([
  "unsupported-language",
  "unsupported-setting",
  "validation-error",
  "project-not-found",
  "run-conflict",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
