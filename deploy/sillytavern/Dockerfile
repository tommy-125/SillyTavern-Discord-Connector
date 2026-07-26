ARG SILLYTAVERN_VERSION=1.18.0
FROM ghcr.io/sillytavern/sillytavern:${SILLYTAVERN_VERSION}

ARG EXTENSION_DIR=/home/node/app/public/scripts/extensions/third-party/SillyTavern-Discord-Connector

# Install only the browser half of the connector. The Discord token and bridge
# server are intentionally kept out of this web-facing image.
COPY --chown=node:node manifest.json index.js settings.html style.css LICENSE ${EXTENSION_DIR}/
COPY --chown=node:node src/ ${EXTENSION_DIR}/src/
COPY --chown=node:node server/locales/ ${EXTENSION_DIR}/server/locales/
