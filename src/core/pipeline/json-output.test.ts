import assert from "node:assert/strict";
import test from "node:test";

import { ConceptOutputSchema } from "../../shared/agent-schemas.js";
import { extractionCases, canonicalOutputs } from "../../../test/fixtures/canonical-story.js";
import { extractJson, parseAgentOutput } from "./json-output.js";

test("extracts fenced and prefixed JSON with braces inside strings", () => {
  assert.deepEqual(parseAgentOutput(extractionCases[0].raw, ConceptOutputSchema), canonicalOutputs.concept);
  assert.deepEqual(parseAgentOutput(extractionCases[1].raw, ConceptOutputSchema), canonicalOutputs.concept);
  assert.deepEqual(extractJson(`説明 {"value":"文字列の } は閉じ括弧ではない"} 続き`), {
    value: "文字列の } は閉じ括弧ではない",
  });
});

test("rejects incomplete JSON deterministically", () => {
  assert.throws(() => extractJson(extractionCases[2].raw), /missing or incomplete/);
});
