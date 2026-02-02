# Stage 1: Build
FROM oven/bun:1 AS builder

WORKDIR /app

# Copy package files
COPY package.json bun.lock* ./

# Install dependencies
RUN bun install --frozen-lockfile || bun install

# Copy source code
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN bun run build

# Stage 2: Production
FROM oven/bun:1-alpine AS production

WORKDIR /app

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 --ingroup nodejs nodejs

# Copy package files and install production deps
COPY package.json ./
RUN bun install --production

# Copy built artifacts
COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production

USER nodejs

# GraphQL HTTP and WebSocket ports
EXPOSE 4002 4003

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD bun -e "process.exit(0)"

CMD ["bun", "run", "dist/index.js"]
