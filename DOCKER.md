# Docker

Build a slim image of `@monkeytestai/monkeytest-core` from a clean clone. The image runs `npm ci` and `npm run build` on Node 22 (the default satisfies `engines.node` of `>=20`) and leaves an installable package at `/opt/monkeytest-core`.

That directory is what `mtaiserver` consumes. Depend on this package name; the path stays the sibling checkout:

```json
"@monkeytestai/monkeytest-core": "file:../monkeytest-core"
```

The `file:` directory does not move. Rename the dependency key in the consumer `package.json` (including a future npm dependency). A droplet can keep `file:../monkeytest-core` until that key is updated.

Nothing in this image is a secret. Do not pass API keys as `--build-arg` values or bake a `.env` into the context. `.dockerignore` already drops `.env` and `.env.*`. Provider keys belong in the process that starts a run.

## Build

From this repository:

```bash
docker build -t monkeytest-core:local .
docker run --rm monkeytest-core:local --help
```

The default base is `node:22.23.4-bookworm-slim`. `ARG NODE_VERSION` selects another official Node release; the Dockerfile appends `-bookworm-slim`.

Optional: record the git commit in the image label `org.opencontainers.image.revision`.

```bash
docker build --build-arg SOURCE_COMMIT="$(git rev-parse HEAD)" -t monkeytest-core:local .
```

`npm ci` installs from `package-lock.json`. `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` is set for both stages, so Chromium is not downloaded. The stage that actually launches a browser needs `npx playwright install chromium` and the operating-system libraries that installer expects. Those bits stay out of this image so it stays small.

## What is in the image

`/opt/monkeytest-core` contains:

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
COPY --from=monkeytest-core:local /opt/monkeytest-core /opt/monkeytest-core
```

The working directory inside the image is `/home/node`. The default command is `node /opt/monkeytest-core/dist/cli.js --help`. The process runs as the `node` user.

## Sibling checkouts for local SaaS compose

Check the two repositories out next to each other. `file:../monkeytest-core` is resolved from `mtaiserver/`.

```
workspace/
  monkeytest-core/    # this repo
  mtaiserver/         # feature/v2
```

npm 10 installs that specifier as a symlink (`"link": true` in the lockfile). It does not run `prepack`, and it does not install this package's dependencies into `mtaiserver`. The sibling has to already contain `dist/` and its own `node_modules` (that is where Node resolves `playwright` and the other dependencies).

```bash
mkdir -p workspace && cd workspace
git clone https://github.com/monkeytestai/monkeytest-core.git
# clone mtaiserver as a sibling of monkeytest-core, then:
cd mtaiserver && git checkout feature/v2 && cd ..
cd monkeytest-core
git checkout c24faa5
npm ci
npm run build
cd ../mtaiserver
npm ci
```

Hosted SaaS uses this same sibling layout. It does not track a floating branch of this repo. The checkout next to `mtaiserver` is pinned to a commit SHA, for example [`c24faa5`](https://github.com/monkeytestai/monkeytest-core/commit/c24faa5c841f6083e3f34aba05acd6f482d81fbf) (`c24faa5c841f6083e3f34aba05acd6f482d81fbf`). Use that pin when a local compose stack has to run the engine the host is running. `main` can move without the host moving.

The image tree can stand in for that sibling inside a Linux image (same libc as the build). It already has `dist/` and production `node_modules`:

```bash
docker create --name mt-core monkeytest-core:local
docker cp mt-core:/opt/monkeytest-core ./monkeytest-core
docker rm mt-core
```

## Reproduce from a clean clone

```bash
git clone https://github.com/monkeytestai/monkeytest-core.git
cd monkeytest-core
git checkout c24faa5
docker build --build-arg SOURCE_COMMIT="$(git rev-parse HEAD)" -t monkeytest-core:local .
docker run --rm monkeytest-core:local --help
```

Confirm the artifact imports and that a second project can install it:

```bash
docker run --rm --entrypoint node monkeytest-core:local --input-type=module -e \
  'import { Monkey } from "/opt/monkeytest-core/dist/index.js"; if (typeof Monkey !== "function") process.exit(1); console.log(Monkey.name);'
```
