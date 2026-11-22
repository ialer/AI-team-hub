# AI Team Hub — minimal runtime image.
# No build step, no dependencies: copy the tree and run node.
FROM node:22-alpine

WORKDIR /app

# Only the runtime pieces. Tests, docs and examples stay out of the image.
COPY package.json ./
COPY server ./server
COPY public ./public
COPY connectors ./connectors

# Data lives here; mount a volume to keep it across upgrades.
RUN mkdir -p /app/data && chown -R node:node /app

USER node

ENV HUB_HOST=0.0.0.0
ENV HUB_PORT=8899
ENV HUB_DATA_DIR=/app/data

EXPOSE 8899

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8899/api/state').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.mjs"]
