# flowscan-mcp as a Streamable HTTP MCP server.
#   docker build -t flowscan-mcp .
#   docker run --rm -p 127.0.0.1:8787:8787 flowscan-mcp        # MCP endpoint: http://127.0.0.1:8787/mcp
#   docker run --rm -p 127.0.0.1:8787:8787 -e FLOWSCAN_HYPERLIQUID_DIRECT=1 flowscan-mcp
# The server has no authentication: publish the port on localhost only, or put it
# behind a reverse proxy that adds auth and TLS (set FLOWSCAN_MCP_ALLOWED_HOSTS to its hostname).

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY scripts/gen-guide.mjs ./scripts/gen-guide.mjs
COPY skills ./skills
COPY src ./src
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production \
    FLOWSCAN_MCP_TRANSPORT=http \
    HOST=0.0.0.0 \
    PORT=8787
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/index.js", "--http"]
