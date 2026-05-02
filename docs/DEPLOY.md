# Deploying docs to docs.monkeytest.ai

The documentation site is a **static build** (VitePress). Output directory:

```
docs/.vitepress/dist
```

## Build locally

```bash
npm ci
npm run docs:build
```

Upload the contents of `docs/.vitepress/dist` to your host.

## GitHub Actions

The workflow `.github/workflows/docs.yml` builds on every push to `main` and uploads an artifact named **`docs-site`**. Attach your deploy step (examples below) or download the artifact from the Actions tab.

## Cloudflare Pages

1. Connect the Git repository.
2. **Build command:** `npm run docs:build`  
3. **Build output directory:** `docs/.vitepress/dist`  
4. **Root directory:** repository root (or `/monkeytest-core` if this lives in a monorepo).
5. Add a **Custom domain** `docs.monkeytest.ai` and CNAME at your DNS provider.

## Vercel

1. Import project; set **Framework preset** to “Other”.
2. Build: `npm run docs:build`  
3. Output: `docs/.vitepress/dist`

## Netlify

Same as Vercel — static publish directory `docs/.vitepress/dist`.

## TLS

Use your provider’s automatic HTTPS. Redirect apex `monkeytest.ai` → `www` or product landing as you prefer; **docs** is a separate subdomain.
