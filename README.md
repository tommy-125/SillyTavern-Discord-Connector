# KuroHelper AI Runtime

## Build

Requires Docker Desktop with Docker Compose and Node.js 22 or later. Keep
`kurohelper-ai-runtime` and `kurohelper` in the same parent directory when using
the runtime-secret configuration script.

```powershell
git clone https://github.com/tommy-125/kurohelper-ai-runtime.git
git clone https://github.com/kuro-helper/kurohelper.git

Set-Location ./kurohelper-ai-runtime
Copy-Item .env.example .env
Copy-Item server/config.example.js server/config.js
Copy-Item ../kurohelper/.env.example ../kurohelper/.env
```

Set the OpenRouter configuration in `.env`, then generate and synchronize the
shared runtime secret:

```powershell
npm run configure-runtime-secret
```

Build and start the containers:

```powershell
docker compose up -d --build
docker compose ps
```
