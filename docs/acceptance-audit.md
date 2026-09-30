# CI and acceptance-evidence pilot

## Two separate layers

- **CI** runs on every PR, on pushes to main, and manually. Node 24 installs the
  committed lockfile, checks version consistency and runs `node --test`.
  A second job provisions pinned Playwright/Chromium and runs the existing
  speech fixture with local ASR/translation/Qwen/Fish stubs and fake media.
  Screenshots and console output are retained for 14 days in an artifact named
  with the tested commit SHA. No model API key is needed by either CI job.
- **Acceptance evidence audit** is an optional, manually dispatched gh-aw public
  preview pilot. It compares an exact PR head with acceptance criteria and test
  evidence, producing at most three gaps in one staged comment proposal. It is
  not a general review, test runner, passing check, or substitute for CodeRabbit.

The browser job covers speech interactions, interruption/recovery, provider
switching, mobile-width overflow and the screenshots captured by
`scripts/verify-speech-browser.mjs`. It does **not** cover all app flows (including
history-title/notes visual editing), physical devices, real microphones, audio
quality, or live Qwen/Fish connectivity. Screenshots need human visual review.
A docs-only PR does not need unrelated browser/device acceptance evidence.

## Status and activation

The pilot is configured but has not been run with a model. No provider billing
choice, secret creation, account connection or live-service access is included.
`engine: codex` is a configurable starting point, not a billing commitment.
A maintainer must select a provider/model and approve its cost and data access
before configuring its credential and dispatching a first run. Codex's current
OpenAI route expects a repository `CODEX_API_KEY` or `OPENAI_API_KEY` secret;
ChatGPT access alone does not establish that Actions has valid model auth.
Never copy a developer's local credentials. Changing providers requires editing
frontmatter and recompiling; do not hand-edit the generated lock.

Normal CI remains usable without any model credentials. Do not make this manual
pilot a required branch-protection check. Nothing runs on a schedule or PR event.
Dispatch is generally available after the workflow reaches the default branch;
this draft PR does not merge it or activate a pilot.

After explicit provider/setup approval, use Actions → Acceptance evidence audit
(manual preview), enter the PR number and its lowercase 40-character head SHA,
and use a trusted workflow ref. Do not dispatch a workflow ref supplied by an
untrusted PR. Read the resulting **Actions summary**, not the PR comments: staged
mode intentionally posts no comment. A stale head or a previous successful run
for this PR/head is rejected before inference. Re-running an existing run is
blocked; inspect its original attempt. Failed setup can be retried as a new
manual dispatch after the failure is understood. Audit history must not be
deleted to evade duplicate detection; successful-run deduplication relies on
retained Actions history (bounded to 1,000 successful runs, then fails closed).

## Safety and evidence contract

- The agent has read-only GitHub tools; shell and CLI-proxy tools are disabled.
  No PR code is executed by the model workflow. Every generated job has only
  read permissions or an empty permission set. Default issue/failure reporting
  is disabled, and all proposed safe outputs remain staged.
- GitHub-only declared network access plus compiler-managed model endpoints;
  no general web search, provider-service credentials, custom MCP or fixes.
- Agent execution: 10 minutes, 12 turns, 10 AI Credits. Overall agent job:
  15 minutes; threat detection: 5 minutes. AI Credits are an execution guardrail,
  not a dollar quote; Actions minutes and provider billing remain separate.
- CI logs must be attributable to the requested head (or explicitly identified
  merge commit containing it). Author claims, static test coverage and missing
  visual/device evidence are separate. Pending/skipped checks never mean pass.
- Untrusted PR content cannot change the task. Missing/truncated diff or evidence
  is disclosed. The head is checked before inference and again before output.
- One proposed comment per run; serialized PR/head dispatches and successful-run
  history prevent repeat completed previews. A PR/head marker protects against
  duplication if a maintainer later manually posts the proposal.

## Local verification

```sh
npm ci --ignore-scripts
npm run check:version
npm test
npx --no-install playwright install --with-deps chromium
npm run test:browser
```

If using an already installed compatible Chromium, set
`CHROMIUM_EXECUTABLE=/path/to/chromium`. `PLAYWRIGHT_MODULE` remains supported by
the existing harness. Local socket restrictions or failed browser downloads must
be reported as **not run**, not converted into a passing browser check.

Install the official gh-aw **v0.89.21** release (newer than the v0.85.4 security
floor), then:

```sh
gh aw compile acceptance-audit --validate --no-check-update
git diff --check
```

Commit `.github/workflows/acceptance-audit.md`, its compiler-generated
`.lock.yml`, `.github/aw/actions-lock.json` and `.gitattributes` together.
The lock metadata records v0.89.21 and uses matching pinned gh-aw action refs.
The deterministic guardrail tests in `test/acceptance-audit.test.mjs` exercise
invalid/stale targets, duplicate history, API failure and history bounds, and
assert the prompt's evidence taxonomy. These are structural tests, **not** a
claim that an LLM has produced a correct review.

## Initial pilot rubric (no model execution)

Use [PR #29](https://github.com/kejun/hearwise/pull/29), head
`e9594026db1142179ca36b0704033079dd7ad28a`, as the historical UI case. Its author
reported 190 local tests and explicitly disclosed missing real-browser visual
acceptance. A correct audit must preserve those labels, avoid calling the report
verified CI, and identify any still-missing history-title/notes visual evidence
without pretending the speech fixture covers it. If the PR head changes, choose
its new SHA explicitly rather than silently auditing this historical snapshot.

For a docs-only case, a correct audit checks changed documentation against code
and acceptance statements and does not request unrelated full browser, physical
device, or paid-provider tests. Before widening rollout, manually inspect one
staged UI case and one docs-only case for relevance, false claims and noise.

## Official references

- [gh-aw release v0.89.21](https://github.com/github/gh-aw/releases/tag/v0.89.21)
- [Codex engine and credentials](https://github.github.io/gh-aw/engines/codex/)
- [Staged safe outputs](https://github.github.io/gh-aw/reference/staged-mode/)
- [Frontmatter budgets](https://github.github.io/gh-aw/reference/frontmatter/)
- [Read-only GitHub tools](https://github.github.io/gh-aw/reference/github-tools/)
