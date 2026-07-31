FROM node:22-alpine

WORKDIR /app
COPY metrics-proxy/server.js ./server.js

ENV NODE_ENV=production
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8081/health || exit 1

USER node
CMD ["node", "server.js"]
