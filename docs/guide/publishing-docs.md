# Publishing the documentation site

**docs.monkeytest.ai** is a VitePress site deployed on **Vercel**. The GitHub Actions workflow [`.github/workflows/docs.yml`](https://github.com/monkeytestai/monkeytest-core/blob/main/.github/workflows/docs.yml) builds the site and stores an artifact. It does not deploy. Vercel builds from the GitHub repo.

Clean URLs (`/guide/quick-start`, with no `.html`) need `cleanUrls: true` in [`vercel.json`](https://github.com/monkeytestai/monkeytest-core/blob/main/vercel.json). Vercel ignores `netlify.toml` and `docs/public/_redirects`. The full host notes, dashboard settings, and local preview steps are in **[DEPLOY.md](https://github.com/monkeytestai/monkeytest-core/blob/main/docs/DEPLOY.md)**.

Quick recap:

1. `npm run docs:build` writes `docs/.vitepress/dist`.
2. Vercel publishes that directory. Root Directory in the Vercel project must be the repository root so `vercel.json` is picked up.
3. The hostname **docs.monkeytest.ai** is already pointed at Vercel.

If this package lives inside a **monorepo**, set the Vercel root to the `monkeytest-core` folder (the folder that contains `vercel.json`) and keep the output path as above.
