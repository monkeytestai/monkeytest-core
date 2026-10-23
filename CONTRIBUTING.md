# Contributing to MonkeyTest Core

Thank you for helping make exploratory AI testing better for everyone. This
project is **AGPL-3.0** licensed—by contributing, you agree your contributions
are licensed under the same terms (see [LICENSE](./LICENSE)).

## Ways to contribute

- **Bug reports** — reproducible steps win; include Node version, OS, Playwright
  version, and a minimal URL or fixture where possible.
- **Feature ideas** — open a discussion or issue; we optimize for clarity and
  safety of browser automation over “magic”.
- **Code** — small, focused PRs; match existing TypeScript style and add tests
  when behavior changes.
- **Docs** — the documentation site lives in `docs/` (VitePress). Typos and
  clarity improvements are always welcome.

## Development setup

```bash
git clone https://github.com/monkeytestai/monkeytest-core.git
cd monkeytest-core
npm install
npx playwright install chromium
npm run build
test -f dist/cli.js
node scripts/smoke.mjs
```

`npm run build` has to leave `dist/cli.js` in place. `scripts/smoke.mjs` crawls `https://example.com` with a stub LLM and needs no API key.

Run the CLI against a throwaway URL:

```bash
export GEMINI_API_KEY=...
npx tsx src/cli.ts explore https://example.com
```

Screenshots are written to `.monkeytest/shots/`. The CLI does not read `.monkeytest/config.json`.

## Pull request checklist

- [ ] `npm run build` passes (`tsc` with no errors).
- [ ] New public APIs are exported from `src/index.ts` and documented in
      `docs/reference/` if user-facing.
- [ ] No secrets or real API keys in commits.
- [ ] For behavioral changes, describe **why** in the PR body (not only *what*).

## Code style

- TypeScript **strict** mode; prefer explicit types on public exports.
- Use `async`/`await`; avoid floating promises.
- Keep LLM prompts and Zod schemas close to the code that uses them.
- English for user-facing strings and comments.

## Community

Be kind. See [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## Questions?

- Documentation: [docs.monkeytest.ai](https://docs.monkeytest.ai)
- Hosted product (no self-hosting required): [monkeytest.ai](https://monkeytest.ai)

## Layered tests

`npm test` is the contributor suite. It needs no API key. It includes the Vitest unit tests and a stub LLM against `test/fixtures/demo-app` (a page error, a link to a 404, a form that returns 500, and a disabled button). CI runs that command on every pull request.

Maintainers can run the same fixture with a real model via `.github/workflows/e2e-live.yml` (Actions → **Live e2e** → Run workflow). The workflow also runs nightly and on pushes to `main`. Pull requests stay on `npm test`, so a fork never receives the keys.

Add repository secrets under Settings → Secrets and variables → Actions:

| Secret | Role |
| --- | --- |
| `GEMINI_API_KEY` | Default live run, model `gemini-flash-lite-latest`. A manual or scheduled run fails when this secret is missing. A push to `main` skips the Gemini leg instead, so the branch stays green before the secret exists. |
| `OPENAI_API_KEY` | Optional matrix leg, model `gpt-4o-mini`. Skipped when the secret is empty. |
| `ANTHROPIC_API_KEY` | Optional matrix leg, model `claude-haiku-4-5`. Skipped when the secret is empty. |

The live job crawls at most 3 pages and 4 flows, times out after 15 minutes, and uploads the run report and screenshots when it fails.
