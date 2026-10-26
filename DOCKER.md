# Docker

Build a slim image of `@monkeytestai/monkeytester` from a clean clone. The image runs `npm ci` and `npm run build` on Node 22 (the default satisfies `engines.node` of `>=20`) and leaves an installable package at `/opt/monkeytester`.

A sibling checkout installs this package by name:

```json
"@monkeytestai/monkeytester": "file:../monkeytester"
```

`mtaiserver` is a separate repository and is not updated here. Until that follow-up, its dependency is still `file:../monkeytest-core`. Clone this repo as `monkeytester`. If a local compose stack still expects the old directory name, symlink `monkeytest-core` to `monkeytester`.

Nothing in this image is a secret. Do not pass API keys as `--build-arg` values or bake a `.env` into the context. `.dockerignore` already drops `.env` and `.env.*`. Provider keys belong in the process that starts a run.

## Build

From this repository:

```bash
docker build -t monkeytester:local .
docker run --rm monkeytester:local --help
```

The default base is `node:22.23.4-bookworm-slim`. `ARG NODE_VERSION` selects another official Node release; the Dockerfile appends `-bookworm-slim`.

Optional: record the git commit in the image label `org.opencontainers.image.revision`.

```bash
docker build --build-arg SOURCE_COMMIT="$(git rev-parse HEAD)" -t monkeytester:local .
```

`npm ci` installs from `package-lock.json`. `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` is set for both stages, so Chromium is not downloaded. The stage that actually launches a browser needs `npx playwright install chromium` and the operating-system libraries that installer expects. Those bits stay out of this image so it stays small.

## What is in the image

`/opt/monkeytester` contains:

| Path | Why it is there |
| --- | --- |
| `dist/` | `tsc` output (`dist/index.js`, `dist/cli.js`, declarations) |
| `package.json` | Package manifest. `scripts.prepack` is removed in this copy |
| `package-lock.json` | The lockfile the production `npm ci` used |
| `README.md`, `LICENSE`, `NOTICE`, `CHANGELOG.md` | Files the npm package ships |
| `node_modules/` | Production dependencies only |

Source, tests, docs, and devDependencies (`typescript`, `vitepress`, `vitest`) are not in the runtime stage.

`scripts.prepack` in a git checkout is `npm run clean && npm run build`. The image deletes that script after compilation. Packing the image tree (`npm pack`, or an installer that packs a `file:` dependency instead of linking it) then keeps `dist/` instead of deleting it and looking for `tsc`.

Copy the tree into another image:

```dockerfile
COPY --from=monkeytester:local /opt/monkeytester /opt/monkeytester
```

The working directory inside the image is `/home/node`. The default command is `node /opt/monkeytester/dist/cli.js --help`. The process runs as the `node` user.

## Sibling checkouts for local SaaS compose

Check the two repositories out next to each other. After `mtaiserver` depends on `@monkeytestai/monkeytester`, `file:../monkeytester` is resolved from `mtaiserver/`. Until that follow-up, `mtaiserver` still resolves `file:../monkeytest-core`.

```
workspace/
  monkeytester/    # this repo
  mtaiserver/         # feature/v2
```

npm 10 installs that specifier as a symlink (`"link": true` in the lockfile). It does not run `prepack`, and it does not install this package's dependencies into `mtaiserver`. The sibling has to already contain `dist/` and its own `node_modules` (that is where Node resolves `playwright` and the other dependencies).

```bash
mkdir -p workspace && cd workspace
git clone https://github.com/monkeytestai/monkeytester.git
# clone mtaiserver as a sibling of monkeytester, then:
cd mtaiserver && git checkout feature/v2 && cd ..
cd monkeytester
git checkout c24faa5
npm ci
npm run build
cd ../mtaiserver
npm ci
```

Hosted SaaS uses this same sibling layout. It does not track a floating branch of this repo. The checkout next to `mtaiserver` is pinned to a commit SHA, for example [`c24faa5`](https://github.com/monkeytestai/monkeytester/commit/c24faa5c841f6083e3f34aba05acd6f482d81fbf) (`c24faa5c841f6083e3f34aba05acd6f482d81fbf`). Use that pin when a local compose stack has to run the engine the host is running. `main` can move without the host moving.

The image tree can stand in for that sibling inside a Linux image (same libc as the build). It already has `dist/` and production `node_modules`:

```bash
docker create --name monkeytester monkeytester:local
docker cp monkeytester:/opt/monkeytester ./monkeytester
docker rm monkeytester
```

## Reproduce from a clean clone

```bash
git clone https://github.com/monkeytestai/monkeytester.git
cd monkeytester
git checkout c24faa5
docker build --build-arg SOURCE_COMMIT="$(git rev-parse HEAD)" -t monkeytester:local .
docker run --rm monkeytester:local --help
```

Confirm the artifact imports and that a second project can install it:

```bash
docker run --rm --entrypoint node monkeytester:local --input-type=module -e \
  'import { Monkey } from "/opt/monkeytester/dist/index.js"; if (typeof Monkey !== "function") process.exit(1); console.log(Monkey.name);'
```
