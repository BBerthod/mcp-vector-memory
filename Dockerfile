FROM --platform=linux/amd64 node:22-slim AS builder

WORKDIR /app

# Install build dependencies for tree-sitter native bindings
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM --platform=linux/amd64 node:22-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY config/ ./config/

EXPOSE 3100

USER node

CMD ["node", "dist/index.js"]
