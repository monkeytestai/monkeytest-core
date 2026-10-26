# Use in CI

monkeytester is small enough to run on every PR. The pattern is:

1. Wait for your deploy preview URL.
2. Run the engine against it.
3. Upload screenshots as artefacts.
4. Fail the job on `critical` / `major` bugs.
5. (Optional) Comment a summary on the PR.

This page shows the canonical setup for **GitHub Actions** + **Vercel-style preview URLs**, but the pattern works anywhere.

The workflow below runs `npm ci` in *your* app and imports `@monkeytestai/monkeytester`. Add that dependency first (`npm install @monkeytestai/monkeytester`). It is published at <https://www.npmjs.com/package/@monkeytestai/monkeytester> as version **0.5.1**. Screenshot paths in the sample are `.monkeytest/shots/`, which is where the engine writes them.

## Minimal `runner.ts`

Add to your repo:

```ts
// .monkeytest/runner.ts
import { writeFileSync, mkdirSync } from 'node:fs';
import { Monkey, autoLLMConfig } from '@monkeytestai/monkeytester';

const url = process.env.PREVIEW_URL;
if (!url) { console.error('PREVIEW_URL is required'); process.exit(2); }

mkdirSync('.monkeytest/shots', { recursive: true });

const monkey = new Monkey({
  llm: autoLLMConfig({
    quality: 'balanced',
    overrides: { runner: { provider: 'groq', model: 'llama-3.3-70b-versatile' } },
  }),
});

const { run, plan } = await monkey.executeAndTriage(url, {
  explore: { maxPages: 6, screenshotsDir: '.monkeytest/shots' },
  plan:    { maxFlows: 4 },
  run:     { screenshotsDir: '.monkeytest/shots', headless: true, stepTimeoutMs: 20_000 },
});

writeFileSync('.monkeytest/run.json', JSON.stringify({ plan, run }, null, 2));

const blocking = run.bugs.filter(b => b.severity !== 'minor');
console.log(`MonkeyTest: ${run.stats.flowsPassed}/${run.stats.flowsTotal} flows passed, ${blocking.length} blocking bug(s).`);

if (blocking.length){
  for (const b of blocking) console.error(`- [${b.severity}] ${b.title}\n  ${b.observed}`);
  process.exit(1);
}
```

## GitHub Actions workflow

```yaml
# .github/workflows/monkeytest.yml
name: MonkeyTest preview
on:
  pull_request:
  workflow_dispatch:

jobs:
  monkeytest:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }

      - run: npm ci

      - name: Install Playwright Chromium
        run: npx playwright install --with-deps chromium

      - name: Wait for preview URL
        id: preview
        # Replace with your deployment provider's "wait-for-deployment" action.
        run: echo "url=${{ github.event.deployment_status.target_url }}" >> $GITHUB_OUTPUT

      - name: Run MonkeyTest
        env:
          PREVIEW_URL: ${{ steps.preview.outputs.url }}
          GEMINI_API_KEY:    ${{ secrets.GEMINI_API_KEY }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GROQ_API_KEY:      ${{ secrets.GROQ_API_KEY }}
        run: npx tsx .monkeytest/runner.ts

      - name: Upload artefacts
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: monkeytest-${{ github.event.pull_request.number || github.run_id }}
          path: |
            .monkeytest/shots/**
            .monkeytest/run.json
          if-no-files-found: ignore
```

## What CI provides + tips

- **Set `headless: true`.** It's the default but be explicit.
- **Cache `~/.cache/ms-playwright`** to avoid re-downloading Chromium on every run.
- **Use Groq for the runner** in CI. It's flat-priced and the latency keeps PR feedback under a couple of minutes.
- **Pin `maxPages` and `maxFlows`.** CI shouldn't surprise you with a 10-minute job — start at `maxPages: 6, maxFlows: 4` and tune.
- **Don't fail on `minor`.** They're often dependent on viewport, timing, or transient network — surface them as warnings.
- **Persist `.monkeytest/run.json`.** Diff bug `fingerprint`s across runs to detect regressions vs. flaky failures.

## PR comment summary (optional)

A tiny script that posts a summary using the GitHub CLI:

```ts
// .monkeytest/comment.ts
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const { run } = JSON.parse(readFileSync('.monkeytest/run.json', 'utf8'));

const lines = [
  `## MonkeyTest`,
  `**${run.stats.flowsPassed}/${run.stats.flowsTotal}** flows passed.`,
  ``,
  ...(run.bugs.length === 0
    ? ['No bugs found in this run.']
    : run.bugs.map((b: any) => `- [${b.severity}] **${b.title}** — ${b.observed}`)),
];

execSync(`gh pr comment ${process.env.PR_NUMBER} --body ${JSON.stringify(lines.join('\n'))}`, { stdio: 'inherit' });
```

## Other CIs

The runner script doesn't care about the CI vendor. The recipe is the same on:

- **CircleCI** — install `playwright` in a Node 20 image, run the script, store_artifacts the screenshots.
- **GitLab CI** — node 20 image, `before_script` installs Chromium, `artifacts.paths` collects shots.
- **Buildkite / Jenkins** — same pattern, your secrets vault provides the LLM keys.

Next: [Troubleshooting →](/guide/troubleshooting)
