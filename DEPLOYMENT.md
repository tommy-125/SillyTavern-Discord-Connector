# Docker Compose deployment

This deployment runs three long-lived containers and one short-lived
initializer:

1. `character-seed` copies the character card into a new SillyTavern data directory, then exits.
2. `sillytavern` runs the official SillyTavern image with this connector's browser extension installed.
3. `discord-bridge` runs the Discord bot and WebSocket bridge.
4. `browser-worker` runs persistent headless Chromium, configures OpenRouter, selects the character, and keeps the connector online.

Only SillyTavern is published to the host, bound to `127.0.0.1` by default.
The bridge WebSocket is available only inside the Compose network.

## Requirements

- Docker Engine with Docker Compose v2
- A Discord bot token with Message Content Intent enabled
- An OpenRouter API key and model ID
- The Kuro PNG character card (the default path points to the sibling `kuro-character` repository)

## 1. Configure the Discord bridge

Copy the existing example configuration:

```sh
cp server/config.example.js server/config.js
```

At minimum, set these values in `server/config.js`:

```js
module.exports = {
  discordToken: "YOUR_DISCORD_BOT_TOKEN",
  allowedUserIds: ["YOUR_DISCORD_USER_ID"],
  allowedChannelIds: ["YOUR_DISCORD_CHANNEL_ID"],
  wssPort: 2333,
  timezone: "Asia/Taipei",
  locale: "zh-TW",
  userLocale: "zh-TW",
  // Keep the remaining settings from config.example.js.
};
```

Do not commit `server/config.js`. It is excluded by `.gitignore` and
`.dockerignore`.

## 2. Configure OpenRouter and the character

Copy the environment template:

```sh
cp .env.example .env
```

Set `OPENROUTER_MODEL` in `.env` to the exact model ID in `provider/model`
form. Check the character settings at the same time:

```dotenv
OPENROUTER_MODEL=provider/model
OPENROUTER_API_KEY=sk-or-v1-...
ST_CHARACTER_CARD_PATH=../kuro-character/Kuro-character-card-gpt-5.6-sol/Kuro_chara_card.discord.png
ST_CHARACTER_FILE_NAME=Kuro.png
ST_DEFAULT_CHARACTER=Kuro
```

The `.env` file is excluded from Git. Keep it private: the OpenRouter key is
injected into `browser-worker` as an environment variable and can be visible
through container inspection commands. The Discord token remains in
`server/config.js`; `.env` does not replace that JavaScript configuration.
If the web page needs HTTP Basic Auth, set `ST_BASIC_AUTH_ENABLED=true` plus
the username and password in `.env`; Compose applies them to both SillyTavern
and the headless browser.

## 3. Build and start

```sh
docker compose up -d --build
```

Watch startup logs:

```sh
docker compose logs -f character-seed sillytavern discord-bridge browser-worker
```

The expected browser-worker messages are:

```text
OpenRouter is ready with model provider/model
Selected SillyTavern character Kuro
Connector is connected to ws://discord-bridge:2333
```

No manual browser setup is required. This deployment layer translates `.env`
into SillyTavern's normal frontend settings and secret API. SillyTavern itself
does not provide environment variables for all user settings.

With `autoCreateDiscordPersonas: true` in `server/config.js`, the first accepted
message from an unmapped Discord user creates a SillyTavern Persona from their
Discord display name and saves the User ID mapping in
`runtime/bridge/persona-map.json`. Explicit `discordPersonaMap` entries and
user choices made with `/mypersona` still take priority. The Discord User ID
remains the stable identity key; each accepted message supplies the sender's
current server nickname as the temporary `{{user}}` display name, so changing
a nickname does not create another Persona.

The deployed configuration uses `streamResponses: false`, so Discord receives
one complete final reply instead of edited streaming previews. Incoming user
messages and commands pass through one global FIFO queue in the browser
extension because this deployment has one shared SillyTavern frontend, active
Persona, and chat state.

## 4. Optional web access

SillyTavern is bound to host loopback on port 8000. From the Docker host, open:

```text
http://127.0.0.1:8000
```

For a remote server, use an SSH tunnel from your computer:

```sh
ssh -L 8000:127.0.0.1:8000 user@your-server
```

Then open `http://127.0.0.1:8000` locally. This is only needed for
administration or manual chatting; the Discord bot does not require a visible
browser. SillyTavern settings are stored under `runtime/sillytavern/data` and
survive container replacement.

Before loading SillyTavern, the headless browser injects an in-memory connector
override for `ws://discord-bridge:2333`. It does not save this Docker-only
hostname into settings used by a normal browser. The worker reconnects after a
page or bridge interruption.

## Persistent data

Compose creates these host directories:

```text
runtime/
|-- sillytavern/
|   |-- config/
|   |-- data/
|   `-- plugins/
|-- bridge/
|   |-- persona-map.json
|   |-- lang-map.json
|   `-- .restart_protection
`-- browser/
    `-- profile/
```

Back up `runtime/sillytavern` and `runtime/bridge`. The entire `runtime`
directory is excluded from Git.

The initializer does not overwrite an existing
`runtime/sillytavern/data/default-user/characters/Kuro.png`. To deliberately
replace the seeded card, stop the stack, remove that one file, and start the
stack again.

## Networking and security

- `discord-bridge:2333` is not published to the host or Internet.
- SillyTavern binds to `127.0.0.1` by default, not all interfaces.
- SillyTavern's IP whitelist permits loopback and RFC 1918 private networks so the dynamically addressed browser container can connect; the host port is still bound to loopback only.
- Use an SSH tunnel or an authenticated HTTPS reverse proxy for remote administration.
- Keep `allowedUserIds` non-empty. An empty list allows any Discord user who can reach the bot to trigger generations.
- The OpenRouter key is injected only into `browser-worker` as an environment variable. SillyTavern stores it in its own persistent secret store after initialization.
- Do not bake `server/config.js`, API keys, character data, or browser profiles into an image.

## Common commands

```sh
# Container status
docker compose ps

# Follow browser and bridge logs
docker compose logs -f browser-worker discord-bridge

# Restart only the browser session
docker compose restart browser-worker

# Stop without deleting persistent host data
docker compose down

# Pull the configured SillyTavern base version and rebuild
docker compose build --pull
docker compose up -d
```

## Limitations

- The browser worker supports no-auth and HTTP Basic Auth SillyTavern deployments. SillyTavern multi-user form login is not automated.
- All Discord users still share the active SillyTavern character and chat. Persona mapping identifies speakers but does not create isolated sessions.
- Only one browser frontend can be connected to this bridge at a time. Opening another Connector frontend and clicking Connect replaces the headless connection until it reconnects.
