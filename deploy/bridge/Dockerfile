FROM node:22-alpine

RUN apk add --no-cache dumb-init su-exec

WORKDIR /app

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --chown=node:node server/ ./
COPY --chown=root:root deploy/bridge/entrypoint.sh /usr/local/bin/bridge-entrypoint
RUN chmod 0755 /usr/local/bin/bridge-entrypoint && mkdir -p /data

ENV NODE_ENV=production \
    CONNECTOR_DATA_DIR=/data

EXPOSE 2333

ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/bridge-entrypoint"]
CMD ["node", "server.js"]
