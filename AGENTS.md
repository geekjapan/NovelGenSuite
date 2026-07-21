# NovelGenSuite

## Agent skills

### Issue tracker

Issues are tracked as GitHub Issues on `geekjapan/NovelGenSuite` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Repository map

- `src/core/`: the nine-role pipeline, prompts, LLM adapter, and JSON state store.
- `src/server/`: Hono HTTP API and the production static-file server.
- `src/shared/`: schemas and contracts shared by the server and web app.
- `src/web/`: React/Vite browser UI.
- `test/fixtures/`: canonical mock-LLM output used by tests and local mock mode.
- `e2e/`: Playwright smoke tests through the public HTTP UI.
- `docs/reference/essence/`: pipeline and domain behavior reference.

## Standard commands

- `npm install`: install the locked dependencies.
- `npm run dev`: run the Vite UI development server; run `npm run start` separately for its API proxy.
- `npm test`: run all unit and contract tests.
- `npm run typecheck`: type-check both `tsconfig.node.json` and `tsconfig.web.json` without emitting files.
- `npm run build`: build the browser UI into `dist/web`.
- `npm run e2e`: build and serve the app in mock mode, then run the Chromium smoke test.
- Before finishing a change, run `npm run typecheck && npm run build && npm test && npm run e2e`.

## Change conventions

- Add or reorder pipeline roles only in `src/core/registry/agent-registry.ts`; the pipeline and prompt code consume that registry.
- Add a supported language and its limits only in the language policy and schema in `src/shared/contracts.ts`.
- Change request/response shapes in `src/shared/contracts.ts` so server and web validation stay aligned.
- Keep prompt construction in `src/core/prompts/`, and keep persisted state changes in `src/core/store/` or `src/core/pipeline/`.
- Test public behavior at its boundary. Browser tests must use role, label, or visible-text selectors, never CSS classes or component internals.
- Do not commit `.env`, generated `dist/`, `test-results/`, or project state.

## Real-LLM acceptance

Mock mode is the default when `OPENAI_API_KEY` is unset. For a human acceptance run with a real model:

1. Start OmniRoute's OpenAI-compatible endpoint (the default URL is `http://127.0.0.1:20128/v1`).
2. Copy `.env.example` to `.env`, set `OPENAI_API_KEY` to the OmniRoute credential, and set `NOVELGEN_MODEL` to the model OmniRoute should use. Set `NOVELGEN_OPENAI_BASE_URL` only when the endpoint differs from the default.
3. Run `npm run build && npm run start`, open `http://127.0.0.1:3000`, create a project, and confirm all nine roles complete and the manuscript remains visible after reloading the project URL.

Never commit the populated `.env`; it is ignored by Git.
