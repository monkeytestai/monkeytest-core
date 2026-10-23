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
