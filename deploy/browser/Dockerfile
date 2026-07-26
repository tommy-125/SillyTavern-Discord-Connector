FROM mcr.microsoft.com/playwright:v1.61.1-noble

WORKDIR /app

COPY deploy/browser/package.json deploy/browser/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY deploy/browser/runner.js ./runner.js
RUN mkdir -p /data/profile

ENV NODE_ENV=production \
    SILLYTAVERN_URL=http://sillytavern:8000 \
    CONNECTOR_BRIDGE_URL=ws://discord-bridge:2333 \
    BROWSER_PROFILE_DIR=/data/profile

CMD ["node", "runner.js"]
