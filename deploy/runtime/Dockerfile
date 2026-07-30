FROM node:22-alpine

RUN apk add --no-cache dumb-init su-exec

WORKDIR /app

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --chown=node:node server/ ./
COPY --chown=root:root deploy/runtime/runtime-entrypoint.sh /usr/local/bin/runtime-entrypoint
RUN chmod 0755 /usr/local/bin/runtime-entrypoint && mkdir -p /data

ENV NODE_ENV=production \
    CONNECTOR_DATA_DIR=/data

EXPOSE 2333 2334

ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/runtime-entrypoint"]
CMD ["node", "server.js"]
