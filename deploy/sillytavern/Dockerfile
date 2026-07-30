ARG SILLYTAVERN_VERSION=1.18.0
FROM ghcr.io/sillytavern/sillytavern:${SILLYTAVERN_VERSION}

ARG EXTENSION_DIR=/home/node/app/public/scripts/extensions/third-party/KuroHelper-AI-Runtime

# Install only the browser half of the AI Runtime. Discord credentials and
# Gateway handling belong to the separate Go KuroHelper application.
COPY --chown=node:node manifest.json index.js settings.html style.css LICENSE ${EXTENSION_DIR}/
COPY --chown=node:node src/ ${EXTENSION_DIR}/src/
COPY --chown=node:node server/locales/ ${EXTENSION_DIR}/server/locales/
