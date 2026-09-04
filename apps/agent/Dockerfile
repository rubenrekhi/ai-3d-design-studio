# syntax=docker/dockerfile:1
#
# Build from the repository root, so `packages/shared` is present as real files:
#   docker buildx build --platform linux/amd64 -f apps/agent/Dockerfile -t agent:dev .
#
# Blender publishes Linux builds for x64 only, so the runtime stage is amd64.

ARG NODE_VERSION=24
ARG PNPM_VERSION=11.20.0
ARG BLENDER_VERSION=4.5.11
ARG BLENDER_SHA256=05ed7bd41bf3e61ae4f4a7cdc364c43088bf8b3fed702c2269c018fdf63a2188

# Only unpacked here, never run, so this stage builds natively on any host.
FROM --platform=$BUILDPLATFORM debian:bookworm-slim AS blender
ARG BLENDER_VERSION
ARG BLENDER_SHA256
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
 && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    series="$(echo "$BLENDER_VERSION" | cut -d. -f1,2)"; \
    url="https://download.blender.org/release/Blender${series}/blender-${BLENDER_VERSION}-linux-x64.tar.xz"; \
    curl -fsSL -o /tmp/blender.tar.xz "$url"; \
    echo "${BLENDER_SHA256}  /tmp/blender.tar.xz" | sha256sum -c -; \
    mkdir -p /opt/blender; \
    tar -xJf /tmp/blender.tar.xz -C /opt/blender --strip-components=1; \
    rm /tmp/blender.tar.xz

# esbuild emits the same JavaScript whatever it runs on, and nothing from this
# stage ships, so it builds natively as well.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS builder
ARG PNPM_VERSION
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/agent/package.json apps/agent/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter @repo/agent... --filter ai-3d-design-studio
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/agent apps/agent
RUN pnpm --filter @repo/agent build

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
# Blender first: it is 1.2 GB, and buildx re-caches every layer under an edited
# one, so anything above it makes a second copy of it out of a one-line change.
COPY --from=blender /opt/blender /opt/blender

# The libs are Blender's. fd and ripgrep are pi's: it downloads them from GitHub
# on first run when they are absent from PATH, which a sandbox should never do.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fd-find ripgrep \
      libgl1 libegl1 libgomp1 libice6 libsm6 libx11-6 libxfixes3 libxi6 \
      libxkbcommon0 libxrender1 libxxf86vm1 \
 && rm -rf /var/lib/apt/lists/*

RUN ln -s /opt/blender/blender /usr/local/bin/blender && blender --version

COPY --from=builder /repo/apps/agent/dist /opt/studio-agent
RUN printf '#!/bin/sh\nexec node /opt/studio-agent/agent.js "$@"\n' > /usr/local/bin/studio-agent \
 && chmod +x /usr/local/bin/studio-agent

ENV BLENDER_PATH=/usr/local/bin/blender
WORKDIR /workspace

# Vercel Sandbox ignores CMD for custom images and starts processes with
# runCommand(). This is for `docker run` and nothing else.
CMD ["studio-agent"]
