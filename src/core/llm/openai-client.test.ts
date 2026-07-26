import assert from "node:assert/strict";
import { createServer, type RequestListener, type Server } from "node:http";
import test from "node:test";

import { canonicalOutputs } from "../../../test/fixtures/canonical-story.js";
import { executePipeline, type PipelineRuntime } from "../pipeline/execute.js";
import { generateMock } from "../pipeline/mock-llm.js";
import { initializePipelineState } from "../pipeline/project-state.js";
import { agentDefinitions } from "../registry/agent-registry.js";
import {
  createGenerateFromEnv,
  createOpenAIGenerate,
  LlmError,
  sanitizeErrorMessage,
} from "./openai-client.js";

const initial = () => initializePipelineState({
  id: "contract-test",
  prompt: "雨の夜の郵便局を舞台にした物語",
  language: "ja",
  configuration: { chapterCount: 2, chapterLength: 1200, requireApproval: false },
  meta: {
    schemaVersion: 1,
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
  },
});

const runtime = (): PipelineRuntime => ({
  save: async () => undefined,
  writeArtifacts: async () => undefined,
});

async function listen(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
  };
}

const close = (server: Server) => new Promise<void>((resolve, reject) =>
  server.close((error) => error ? reject(error) : resolve()));

test("fake OpenAI server completes the pipeline after compact fenced-JSON recovery", async () => {
  const requests: Array<{ authorization?: string; body: any }> = [];
  let conceptAttempts = 0;
  const { server, baseUrl } = await listen((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { raw += chunk; });
    request.on("end", () => {
      const body = JSON.parse(raw);
      requests.push({ authorization: request.headers.authorization, body });
      const user = body.messages[1].content as string;
      const id = /ROLE=([^\n]+)/.exec(user)?.[1] as keyof typeof canonicalOutputs;
      const chapterNumber = Number(/"targetChapter":\{"number":(\d+)/.exec(user)?.[1] ?? 1);
      const output = id === "drafting"
        ? canonicalOutputs.drafting[chapterNumber - 1]
        : canonicalOutputs[id];
      let content = JSON.stringify(output);
      if (id === "concept" && conceptAttempts++ === 0) content = '{"logline":"broken"';
      else if (id === "concept") content = `\`\`\`json\n${content}\n\`\`\``;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });

  try {
    const generate = createOpenAIGenerate({ baseUrl, apiKey: "test-secret", model: "test-model" });
    const completed = await executePipeline(initial(), runtime(), generate);

    assert.ok(completed.agents.every(({ status }) => status === "completed"));
    assert.equal(conceptAttempts, 2);
    assert.match(requests[1]!.body.messages[1].content, /COMPACT RETRY/);
    assert.equal(requests[0]!.authorization, "Bearer test-secret");
    assert.equal(requests[0]!.body.model, "test-model");
    assert.equal(requests[0]!.body.messages[0].role, "system");
    assert.equal(requests[0]!.body.messages[1].role, "user");
  } finally {
    await close(server);
  }
});

for (const status of [401, 402] as const) {
  test(`${status} is recorded as failed without a compact retry`, async () => {
    let requests = 0;
    const { server, baseUrl } = await listen((_request, response) => {
      requests += 1;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "/Users/private key sk-provider-secret" } }));
    });
    try {
      const failed = await executePipeline(
        initial(),
        runtime(),
        createOpenAIGenerate({ baseUrl, apiKey: "test-secret", model: "test-model" }),
      );
      assert.equal(requests, 1);
      assert.equal(failed.agents[0]!.status, "failed");
      assert.match(failed.agents[0]!.error!, /ください/);
      assert.doesNotMatch(JSON.stringify(failed), /test-secret|provider-secret|\/Users\/private/);
    } finally {
      await close(server);
    }
  });
}

test("AbortError is not compact-retried", async () => {
  let calls = 0;
  const generate = createOpenAIGenerate({
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "test-secret",
    model: "test-model",
    fetch: async () => {
      calls += 1;
      throw new DOMException("/Users/private token-secret", "AbortError");
    },
  });
  const failed = await executePipeline(initial(), runtime(), generate);
  assert.equal(calls, 1);
  assert.equal(failed.agents[0]!.status, "failed");
});

test("the OpenAI boundary classifies wall-clock timeout separately from abort", async () => {
  const generate = createOpenAIGenerate({
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "test-secret",
    model: "test-model",
    fetch: async () => {
      throw new DOMException("timed out", "TimeoutError");
    },
  });
  const project = initial();
  const definition = agentDefinitions[0];
  await assert.rejects(
    generate({
      agentId: definition.id,
      context: definition.buildContext({
        prompt: project.prompt,
        language: project.language,
        bible: project.bible,
        completedOutputs: project.completedOutputs,
      }),
      chapterCount: project.configuration.chapterCount,
      compact: false,
    }),
    (cause) => cause instanceof LlmError && cause.kind === "timeout" && cause.retryable,
  );
});

test("environment selection keeps mock fallback and requires an explicit model", () => {
  assert.equal(createGenerateFromEnv({}), generateMock);
  assert.throws(
    () => createGenerateFromEnv({ OPENAI_API_KEY: "test-secret" }),
    /NOVELGEN_MODEL is required/,
  );
});

test("missing model is persisted as the first agent failure on the default pipeline path", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousModel = process.env.NOVELGEN_MODEL;
  const saved: ReturnType<typeof initial>[] = [];
  process.env.OPENAI_API_KEY = "test-secret";
  delete process.env.NOVELGEN_MODEL;

  try {
    const failed = await executePipeline(initial(), {
      save: async (state) => { saved.push(structuredClone(state)); },
      writeArtifacts: async () => undefined,
    });

    assert.equal(failed.agents[0]!.status, "failed");
    assert.match(failed.agents[0]!.error!, /ください/);
    assert.deepEqual(saved.map(({ agents }) => agents[0]!.status), ["running", "failed"]);
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.NOVELGEN_MODEL;
    else process.env.NOVELGEN_MODEL = previousModel;
  }
});

test("provider error summaries redact credentials, tokens, hashes, and internal paths", () => {
  const message = sanitizeErrorMessage(
    "Bearer token_abc API key: plain-secret access token: jwt-secret sk-live-secret file=/Users/geek/private.ts at (/opt/app/client.ts:1:2) C:\\Users\\geek\\private.ts abcdef0123456789abcdef0123456789",
  );
  assert.equal(message.includes("token_abc"), false);
  assert.equal(message.includes("sk-live-secret"), false);
  assert.equal(message.includes("plain-secret"), false);
  assert.equal(message.includes("jwt-secret"), false);
  assert.equal(message.includes("/Users/geek"), false);
  assert.equal(message.includes("/opt/app"), false);
  assert.equal(message.includes("C:\\Users\\geek"), false);
  assert.equal(message.includes("abcdef0123456789abcdef0123456789"), false);
});
