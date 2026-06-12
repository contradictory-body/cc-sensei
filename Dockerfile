# Stage 1: Build
FROM node:22-slim AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Install dependencies
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy source
COPY tsconfig.json tsup.config.ts ./
COPY src/ src/
COPY scripts/ scripts/
COPY claude-code-main/ claude-code-main/
COPY knowledge/ knowledge/

# Build (index + server)
RUN pnpm build

# Stage 2: Runtime
FROM node:22-slim AS runtime

WORKDIR /app

# Copy only what's needed at runtime
COPY --from=builder /app/dist/server.js ./dist/server.js
COPY --from=builder /app/knowledge/ ./knowledge/
COPY --from=builder /app/claude-code-main/ ./claude-code-main/
COPY --from=builder /app/package.json ./

# MCP servers communicate over stdio
ENTRYPOINT ["node", "dist/server.js"]
