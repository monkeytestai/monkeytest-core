# syntax=docker/dockerfile:1

# Reproducible build of @mtai/monkeytest-core.
#
#   docker build -t monkeytest-core:local .
#
# The runtime stage keeps a single installable tree at /opt/monkeytest-core:
# dist/, package.json, the files the npm package ships, the lockfile, and
# production node_modules. Copy that directory into another image, or point
# a `file:` dependency at it.
#
# No API keys, tokens, or .env files are copied in. Playwright browser
# binaries are not downloaded; the process that launches Chromium installs
# them. `scripts.prepack` (`npm run clean && npm run build`) is removed from
# the image copy of package.json so packing this directory does not delete
# dist/ and look for the TypeScript compiler. npm 10 links `file:` checkouts
# instead of packing them; a git sibling still has to be built before that
# link will resolve. See DOCKER.md.

ARG NODE_VERSION=22.23.4

FROM node:${NODE_VERSION}-bookworm-slim AS build

WORKDIR /src
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY README.md LICENSE NOTICE CHANGELOG.md ./
RUN mkdir -p /tmp/pack \
 && npm run build \
 && test -f dist/cli.js \
 && test -f dist/index.js \
 && test -f dist/index.d.ts \
 && npm pack --ignore-scripts --pack-destination /tmp/pack \
 && npm cache clean --force

FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ARG SOURCE_COMMIT=
LABEL org.opencontainers.image.title="@mtai/monkeytest-core" \
      org.opencontainers.image.description="Compiled @mtai/monkeytest-core package for file: installs and image copies." \
      org.opencontainers.image.source="https://github.com/monkeytestai/monkeytest-core" \
      org.opencontainers.image.url="https://docs.monkeytest.ai" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}"

ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

WORKDIR /opt/monkeytest-core

COPY --from=build /src/package-lock.json ./package-lock.json
COPY --from=build /tmp/pack/ /tmp/pack/

# npm pack names the tarball from the package name and version. Install only
# production dependencies so typescript, vitepress, and vitest stay behind
# in the build stage. --ignore-scripts on `npm pack` skipped `prepack`
# (which would have compiled a second time); the script is still in the
# packed manifest until we delete it below.
RUN tar -xzf /tmp/pack/mtai-monkeytest-core-*.tgz -C /opt/monkeytest-core --strip-components=1 \
 && rm -rf /tmp/pack \
 && npm ci --omit=dev --no-audit --no-fund \
 && npm pkg delete scripts.prepack \
 && npm cache clean --force \
 && test -f dist/cli.js \
 && test -f dist/index.js \
 && test -f dist/index.d.ts \
 && test -f package.json \
 && test -f package-lock.json \
 && test -f LICENSE \
 && test -f README.md \
 && test -f NOTICE \
 && test -f CHANGELOG.md \
 && test ! -d src \
 && test ! -d node_modules/typescript \
 && test ! -d node_modules/vitepress \
 && test ! -d node_modules/vitest \
 && test -d node_modules/playwright \
 && test -d node_modules/zod \
 && test ! -d /root/.cache/ms-playwright \
 && test ! -d /ms-playwright \
 && chown -R node:node /opt/monkeytest-core

WORKDIR /home/node
USER node

ENTRYPOINT ["node", "/opt/monkeytest-core/dist/cli.js"]
CMD ["--help"]
