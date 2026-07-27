import assert from "node:assert/strict";
import test from "node:test";

import { LlmError } from "../llm/openai-client.js";
import type { ChapterOutlineOutput } from "../../shared/agent-schemas.js";
import { executePipeline, type PipelineRuntime } from "./execute.js";
import { generateMock, type Generate } from "./mock-llm.js";
import { initializePipelineState } from "./project-state.js";
import {
  actionableError,
  classifyRecovery,
  logParseFailure,
  shouldProviderSwitch,
} from "./recovery.js";

const initial = () => initializePipelineState({
  id: "recovery-test",
  prompt: "物語",
  language: "ja",
  configuration: { chapterCount: 2, chapterLength: 100, requireApproval: false },
  meta: {
    schemaVersion: 1,
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
  },
});

const runtime: PipelineRuntime = {
  save: async () => undefined,
  writeArtifacts: async () => undefined,
};
const quiet = () => undefined;

test("recovery classification applies abort, hard, deny, allow, then unknown ordering", () => {
  assert.equal(classifyRecovery(new DOMException("stop", "AbortError")), "abort");
  assert.equal(classifyRecovery(new LlmError("timeout", false)), "hard");
  assert.equal(classifyRecovery(new Error("authentication denied")), "deny");
  assert.equal(classifyRecovery(new Error("rate limit")), "retry");
  assert.equal(classifyRecovery(new Error("unclassified provider failure")), "retry");
  assert.equal(shouldProviderSwitch(new Error("rate limit")), true);
  assert.equal(shouldProviderSwitch(new Error("schema mismatch")), false);
  assert.match(actionableError(new Error("context token limit exceeded")), /章長/);
});

test("client retry recovers transient provider failure but does not retry hard failure", async () => {
  let transientCalls = 0;
  const transient: Generate = async (request) => {
    if (request.agentId === "concept" && transientCalls++ === 0) {
      throw new LlmError("network unavailable", true);
    }
    return generateMock(request);
  };
  const recovered = await executePipeline(initial(), runtime, transient, {
    retryDelayMs: 0,
    log: quiet,
  });
  const concept = recovered.agents[0]!;
  assert.equal(transientCalls, 2);
  assert.equal(concept.attemptCount, 2);
  assert.equal(concept.autoRecovered, true);
  assert.equal(concept.fallbackUsed, false);

  let hardCalls = 0;
  const hard: Generate = async () => {
    hardCalls += 1;
    throw new LlmError("authentication failed", false);
  };
  const failed = await executePipeline(initial(), runtime, hard, {
    retryDelayMs: 0,
    log: quiet,
  });
  assert.equal(hardCalls, 1);
  assert.equal(failed.agents[0]!.status, "failed");
});

test("provider switch handles exhausted transient failures but not hard or output-quality failures", async () => {
  let primaryCalls = 0;
  let alternateCalls = 0;
  const primary: Generate = async (request) => {
    if (request.agentId === "concept" && primaryCalls++ < 3) {
      throw new LlmError("rate limit", true);
    }
    return generateMock(request);
  };
  const alternate: Generate = async (request) => {
    alternateCalls += 1;
    return generateMock(request);
  };
  const switched = await executePipeline(initial(), runtime, primary, {
    alternateGenerate: alternate,
    retryDelayMs: 0,
    log: quiet,
  });
  assert.equal(primaryCalls, 3);
  assert.equal(alternateCalls, 1);
  assert.equal(switched.agents[0]!.fallbackUsed, true);
  assert.equal(switched.agents[0]!.autoRecovered, true);
  assert.ok(switched.agents[0]!.attemptCount! <= switched.agents[0]!.maxAttempts!);

  alternateCalls = 0;
  const malformed: Generate = async (request) =>
    request.agentId === "concept" ? "invalid-output-marker" : generateMock(request);
  const local = await executePipeline(initial(), runtime, malformed, {
    alternateGenerate: alternate,
    retryDelayMs: 0,
    log: quiet,
  });
  assert.equal(alternateCalls, 0);
  assert.equal(local.agents[0]!.fallbackUsed, true);

  alternateCalls = 0;
  const thrownQuality = await executePipeline(initial(), runtime, async (request) => {
    if (request.agentId === "concept") {
      throw new LlmError("OpenAI response was not valid JSON", true);
    }
    return generateMock(request);
  }, {
    alternateGenerate: alternate,
    retryDelayMs: 0,
    log: quiet,
  });
  assert.equal(alternateCalls, 0);
  assert.equal(thrownQuality.agents[0]!.fallbackUsed, true);

  alternateCalls = 0;
  await executePipeline(initial(), runtime, async () => {
    throw new LlmError("billing failed", false);
  }, {
    alternateGenerate: alternate,
    retryDelayMs: 0,
    log: quiet,
  });
  assert.equal(alternateCalls, 0);

  const hardQuality = await executePipeline(initial(), runtime, async () => {
    throw new LlmError("schema mismatch", false);
  }, {
    alternateGenerate: alternate,
    retryDelayMs: 0,
    log: quiet,
  });
  assert.equal(hardQuality.agents[0]!.status, "failed");
  assert.equal(hardQuality.agents[0]!.fallbackUsed, undefined);
});

test("chapter-outline transport exhaustion reuses its skeleton", async () => {
  let outlineCalls = 0;
  const completed = await executePipeline(initial(), runtime, async (request) => {
    if (request.agentId === "chapter-outline") {
      outlineCalls += 1;
      throw new LlmError("network unavailable", true);
    }
    return generateMock(request);
  }, {
    retryDelayMs: 0,
    log: quiet,
  });
  assert.equal(outlineCalls, 3);
  const run = completed.agents.find(({ id }) => id === "chapter-outline")!;
  assert.equal(run.status, "completed");
  assert.equal(run.fallbackUsed, true);
});

test("call timeout retries with fresh signals and can switch provider", async () => {
  let primaryCalls = 0;
  let alternateCalls = 0;
  const timeout: Generate = async (request) => {
    if (request.agentId !== "concept") return generateMock(request);
    primaryCalls += 1;
    request.signal?.throwIfAborted();
    await new Promise<void>((_resolve, reject) => {
      request.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("timed out", "AbortError")),
        { once: true },
      );
    });
    throw new Error("unreachable");
  };
  const completed = await executePipeline(initial(), runtime, timeout, {
    alternateGenerate: async (request) => {
      alternateCalls += 1;
      return generateMock(request);
    },
    retryDelayMs: 0,
    log: quiet,
    timeouts: { callMs: 5, agentMs: 100 },
  });
  assert.equal(primaryCalls, 3);
  assert.equal(alternateCalls, 1);
  assert.equal(completed.agents[0]!.fallbackUsed, true);
});

test("agent timeout still applies chapter-outline skeleton fallback", async () => {
  const completed = await executePipeline(initial(), runtime, async (request) => {
    if (request.agentId !== "chapter-outline") return generateMock(request);
    request.signal?.throwIfAborted();
    await new Promise<void>((_resolve, reject) => {
      request.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("timed out", "AbortError")),
        { once: true },
      );
    });
    throw new Error("unreachable");
  }, {
    retryDelayMs: 100,
    log: quiet,
    timeouts: { callMs: 100, agentMs: 5 },
  });
  const outline = completed.agents.find(({ id }) => id === "chapter-outline")!;
  assert.equal(outline.status, "completed");
  assert.equal(outline.fallbackUsed, true);
});

test("AbortError without a caller signal is restored to pending with cancellation metadata", async () => {
  const cancelled = await executePipeline(initial(), runtime, async () => {
    throw new DOMException("stop", "AbortError");
  }, {
    retryDelayMs: 0,
    log: quiet,
  });
  assert.equal(cancelled.agents[0]!.status, "pending");
  assert.equal(cancelled.agents[0]!.attempts?.at(-1)?.type, "cancellation");
});

test("attempt count includes a prior malformed response before a hard compact failure", async () => {
  let calls = 0;
  const failed = await executePipeline(initial(), runtime, async (request) => {
    if (request.agentId !== "concept") return generateMock(request);
    calls += 1;
    if (calls === 1) return "broken";
    throw new LlmError("authentication failed", false);
  }, {
    retryDelayMs: 0,
    log: quiet,
  });
  assert.equal(calls, 2);
  assert.equal(failed.agents[0]!.attemptCount, 2);
});

test("hard drafting and auto-expansion errors stop immediately", async () => {
  const draftingCalls: number[] = [];
  const hardDraft = await executePipeline(initial(), runtime, async (request) => {
    if (request.agentId === "drafting") {
      draftingCalls.push(request.chapterNumber!);
      throw new LlmError("authentication failed", false);
    }
    return generateMock(request);
  }, {
    retryDelayMs: 0,
    log: quiet,
  });
  assert.deepEqual(draftingCalls, [1]);
  assert.equal(hardDraft.agents.find(({ id }) => id === "drafting")!.status, "failed");
  assert.equal(hardDraft.chapterRuns[1]!.status, "pending");
  assert.equal(
    hardDraft.agents.find(({ id }) => id === "drafting")!.lastRetryError,
    hardDraft.chapterRuns[0]!.lastRetryError,
  );

  const hardExpansion = await executePipeline(initial(), runtime, async (request) => {
    if (request.agentId !== "drafting") return generateMock(request);
    if (request.operation === "auto-expand") {
      throw new LlmError("billing failed", false);
    }
    return JSON.stringify({
      chapterNumber: request.chapterNumber,
      draft: "短",
      chapterSummary: "要約",
      continuityNotes: [],
    });
  }, {
    retryDelayMs: 0,
    log: quiet,
  });
  assert.equal(hardExpansion.agents.find(({ id }) => id === "drafting")!.status, "failed");
  assert.equal(hardExpansion.chapterRuns[0]!.status, "failed");
  assert.ok(hardExpansion.chapterRuns[0]!.attemptCount! > 1);
  assert.ok(
    hardExpansion.chapterRuns[0]!.attemptCount! <= hardExpansion.chapterRuns[0]!.maxAttempts!,
  );
  const failedDrafting = hardExpansion.agents.find(({ id }) => id === "drafting")!;
  assert.ok(failedDrafting.attemptCount! <= failedDrafting.maxAttempts!);
});

test("chapter-outline local fallback reuses the existing skeleton and records recovery metadata", async () => {
  const state = initial();
  const original = structuredClone(state.bible.parts);
  const generate: Generate = async (request) =>
    request.agentId === "chapter-outline" ? "broken" : generateMock(request);
  const completed = await executePipeline(state, runtime, generate, {
    retryDelayMs: 0,
    log: quiet,
  });
  const outline = completed.completedOutputs["chapter-outline"] as ChapterOutlineOutput;

  assert.deepEqual(
    outline.parts.flatMap(({ chapters }) => chapters).map((chapter) => ({
      id: chapter.id,
      partNumber: chapter.partNumber,
      number: chapter.number,
      role: chapter.role,
      lengthPlan: chapter.lengthPlan,
    })),
    original.flatMap(({ chapters }) => chapters).map((chapter) => ({
      id: chapter.id,
      partNumber: chapter.partNumber,
      number: chapter.number,
      role: chapter.role,
      lengthPlan: chapter.lengthPlan,
    })),
  );
  const run = completed.agents.find(({ id }) => id === "chapter-outline")!;
  assert.equal(run.fallbackUsed, true);
  assert.equal(run.autoRecovered, true);
  assert.ok(run.lastRetryError);
  assert.equal(new Set(outline.parts.flatMap(({ chapters }) =>
    chapters.map(({ title }) => title))).size, 2);
});

test("parse failure logs omit raw output by default", () => {
  const events: Array<{ event: string; details: Record<string, unknown> }> = [];
  logParseFailure(
    (event, details) => events.push({ event, details }),
    "RAW-SECRET-MARKER",
    "primary",
    "invalid-output",
  );
  assert.equal(events[0]!.event, "pipeline.parse.failure");
  assert.equal(events[0]!.details.length, 17);
  assert.equal(typeof events[0]!.details.correlationId, "string");
  assert.equal(typeof events[0]!.details.fingerprint, "string");
  assert.equal(JSON.stringify(events[0]).includes("RAW-SECRET-MARKER"), false);
  assert.equal("rawExcerpt" in events[0]!.details, false);
});

test("call and agent wall-clock timeouts are independently enforced", async () => {
  for (const timeouts of [
    { callMs: 5, agentMs: 100 },
    { callMs: 100, agentMs: 5 },
  ]) {
    const hanging: Generate = async (request) => {
      request.signal?.throwIfAborted();
      await new Promise<void>((_resolve, reject) => {
        request.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("timed out", "AbortError")),
          { once: true },
        );
      });
      throw new Error("unreachable");
    };
    const failed = await executePipeline(initial(), runtime, hanging, {
      retryDelayMs: 0,
      log: quiet,
      timeouts,
    });
    assert.equal(failed.agents[0]!.status, "failed");
    assert.equal(failed.agents[0]!.attemptCount, 3);
  }
});

test("parse timeout applies local fallback within the timeout hierarchy", async () => {
  const completed = await executePipeline(initial(), runtime, generateMock, {
    retryDelayMs: 0,
    log: quiet,
    timeouts: { parseMs: 0 },
  });
  assert.equal(completed.agents[0]!.fallbackUsed, true);
  assert.equal(completed.agents[0]!.autoRecovered, true);
});

test("drafting agent recovery limits include compact and provider layers", async () => {
  let primaryDraftCalls = 0;
  const completed = await executePipeline(initial(), runtime, async (request) => {
    if (request.agentId === "drafting" && request.chapterNumber === 1 && primaryDraftCalls++ < 3) {
      throw new LlmError("rate limit", true);
    }
    return generateMock(request);
  }, {
    alternateGenerate: generateMock,
    retryDelayMs: 0,
    log: quiet,
  });
  const drafting = completed.agents.find(({ id }) => id === "drafting")!;
  assert.ok(drafting.attemptCount! <= drafting.maxAttempts!);
  assert.ok(completed.chapterRuns.every(({ attemptCount, maxAttempts }) =>
    (attemptCount ?? 0) <= (maxAttempts ?? 0)));
});

test("observability logs prompt size, chapter order, and stage durations", async () => {
  const events: Array<{ event: string; details: Record<string, unknown> }> = [];
  await executePipeline(initial(), runtime, generateMock, {
    log: (event, details) => events.push({ event, details }),
  });
  const stages = new Set(
    events.filter(({ event }) => event === "pipeline.stage")
      .map(({ details }) => details.stage),
  );
  assert.deepEqual(stages, new Set(["llm", "parse", "normalize", "merge"]));
  assert.ok(events.some(({ event, details }) =>
    event === "pipeline.prompt"
    && typeof details.characters === "number"
    && typeof details.estimatedTokens === "number"));
  assert.ok(events.some(({ event, details }) =>
    event === "pipeline.prompt" && details.chapterOrder === 1));
  assert.ok(events.filter(({ event }) => event === "pipeline.stage")
    .every(({ details }) => typeof details.elapsedMs === "number"));
});
