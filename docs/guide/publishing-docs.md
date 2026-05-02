# Publishing the documentation site

The manual and CI/CD steps for deploying **docs.monkeytest.ai** live in the repository:

👉 **[DEPLOY.md (full guide)](https://github.com/monkeytest-ai/monkeytest-core/blob/main/docs/DEPLOY.md)**

Quick recap:

1. `npm run docs:build`
2. Upload `docs/.vitepress/dist` to Cloudflare Pages, Vercel, Netlify, or GitHub Pages.
3. Point the custom hostname **docs.monkeytest.ai** at your provider.

If this package lives inside a **monorepo**, set the CI “root directory” to the `monkeytest-core` folder and the output path as above.
