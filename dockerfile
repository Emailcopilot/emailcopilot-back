# Keep this version in sync with the "playwright" version in package.json
FROM mcr.microsoft.com/playwright:v1.59.1-noble

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy dependency files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Install deps
RUN pnpm install --frozen-lockfile

# Copy source and config
COPY esbuild.js ./
COPY src/ ./src/
COPY migrations/ ./migrations/
RUN mkdir -p /app/debug
# Build TS → JS
RUN pnpm run build

EXPOSE 3001

CMD ["node", "dist/index.js"]