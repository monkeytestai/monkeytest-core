# Deploying docs to docs.monkeytest.ai

The documentation site is a **static VitePress build**.

```
docs/.vitepress/dist
```

## Where it is hosted

**Production is [Vercel](https://vercel.com).** Checked 23 Oct 2026:

- `https://docs.monkeytest.ai` responds with `server: Vercel`.
- DNS for `docs.monkeytest.ai` is a CNAME to `vercel-dns`.
- `.github/workflows/docs.yml` builds the site and uploads a `docs-site` artifact. It does **not** deploy. The Vercel project is connected to the GitHub repo on its own.

VitePress is configured with `cleanUrls: true`, so every internal link is extensionless (`/guide/quick-start`). The build still emits `guide/quick-start.html`. Vercel does not map `/guide/quick-start` to that file unless [`cleanUrls`](https://vercel.com/docs/project-configuration#cleanurls) is enabled. That flag lives in `vercel.json` at the repository root (Vercel has no dashboard toggle for it). `netlify.toml` and `docs/public/_redirects` are not read by Vercel — `_redirects` is published as a static file and returns 200, which is why those rewrites never fixed the 404s.

`vercel.json` in this repo sets:

- `cleanUrls: true` — `/guide/quick-start` serves `quick-start.html`, and a request for the `.html` URL redirects to the clean path.
- `trailingSlash: false` — `/guide/quick-start/` redirects to `/guide/quick-start`, which is what the VitePress client expects.

### What has to be true in the Vercel project

`vercel.json` is only applied when it sits in the project's **Root Directory**.

- Root Directory: repository root (the directory that contains `vercel.json` and `package.json`).
- Build command: `npm run docs:build` (install is `npm ci` / `npm install`).
- Output directory: `docs/.vitepress/dist`.
- Node: 20 or newer.

This repo does not override the build command inside `vercel.json`, so those three settings stay in the Vercel dashboard. If a deploy still 404s on `/guide/quick-start` after `vercel.json` is on `main`, the Root Directory is probably not the repo root — move `vercel.json` to that directory, or set Root Directory back to the repo root, and redeploy.

## Build locally

```bash
npm ci
npm run docs:build
npm run docs:preview
```

The preview server understands clean URLs. A plain static file server will not, until the host rewrites `.html` the way Vercel does with `cleanUrls`.

## Other hosts

The same output can be uploaded to Netlify, Cloudflare Pages, or GitHub Pages. Netlify and Cloudflare need the rewrite rules in `netlify.toml` and `docs/public/_redirects` (splat rewrites to `.html`). GitHub Pages does not apply either file; use the VitePress GitHub Pages guide if you ever move the site there.

Do not enable HTML minification on the host. VitePress relies on HTML comments, and stripping them causes hydration mismatches.
