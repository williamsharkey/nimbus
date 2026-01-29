# CLAUDE.md - Guide for AI Assistants Working on Nimbus

## What is Nimbus?

Nimbus is a multi-repo Claude Code orchestrator with a live testing dashboard. It manages 7 GitHub repos (shiro, foam, windwalker, spirit, fluffycoreutils, nimbus, skyeyes) under github.com/williamsharkey, giving each repo its own Claude Agent SDK worker. A web dashboard at localhost:7777 shows real-time worker status, streaming logs, cost tracking, and live GitHub Pages previews with JS execution via skyeyes.

## Project Structure

```
src/
├── server/
│   ├── index.ts        # Entry: Express + WebSocket + WorkerManager wiring
│   ├── routes.ts       # REST API, skyeyes endpoints, GitHub Pages proxy, generic URL proxy
│   └── ws.ts           # WebSocket hub: dashboard clients + skyeyes bridges
├── workers/
│   ├── types.ts        # All shared TypeScript interfaces
│   ├── Worker.ts       # Claude Agent SDK session wrapper (streaming, resume, abort)
│   └── WorkerManager.ts # Creates/manages all Worker instances
└── client/
    ├── index.html      # Dashboard SPA shell
    ├── app.ts          # Dashboard logic: worker cards, TV, priorities, skyeyes exec
    └── style.css       # Dark theme dashboard styles
```

## Common Tasks

```bash
npm run dev          # Start dev server with hot reload (tsx watch)
npm run build        # TypeScript compile + bundle client
npm start            # Run compiled server
npm run setup        # Clone all repos (scripts/setup.sh)
```

## Architecture

- **Express server** serves the dashboard static files and REST API on port 7777
- **WebSocket hub** handles two types of connections: dashboard clients and skyeyes bridges from iframes
- **WorkerManager** creates one Worker per repo from `nimbus.config.json`, staggering starts by 2s
- **Worker** wraps Claude Agent SDK `query()` with streaming input via AsyncGenerator. Supports sendMessage, interrupt, resume
- **GitHub Pages proxy** (`/live/:page`) fetches pages from GitHub Pages, injects skyeyes.js, rewrites URLs for same-origin
- **Generic proxy** (`/proxy?url=`) proxies any URL for the Shared TV iframe, stripping X-Frame-Options
- **Skyeyes bridge** routes JS eval commands from REST API / dashboard to connected iframes via WebSocket

## Key API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/workers` | GET | List all worker states |
| `/api/workers/:id/send` | POST | Send message to a worker |
| `/api/workers/:id/interrupt` | POST | Interrupt a worker |
| `/api/skyeyes/:page/exec` | POST | Execute JS in a live page (JSON body) |
| `/api/skyeyes/:page/eval?code=...` | GET | Execute JS (simple, no JSON escaping) |
| `/api/skyeyes/:page/reload` | POST | Reload a live page iframe |
| `/api/skyeyes/status` | GET | Check which skyeyes bridges are connected |
| `/live/:page` | GET | Proxied GitHub Pages with skyeyes injected |
| `/proxy?url=` | GET | Generic URL proxy for Shared TV |

## Configuration

`nimbus.config.json` defines port, repos, model, and budget:
```json
{
  "port": 7777,
  "basePath": "~/Desktop/nimbus-land",
  "defaultModel": "claude-sonnet-4-5-20250929",
  "maxBudgetPerWorkerUsd": 5.0,
  "repos": [
    { "name": "shiro", "githubUser": "williamsharkey", "liveUrl": "https://williamsharkey.github.io/shiro/" },
    ...
  ]
}
```

Repos with `liveUrl` get an iframe preview in the dashboard with skyeyes JS execution.

## Cross-Project Integration

All repos live under `~/Desktop/nimbus-land/`:

- **Shiro** (williamsharkey/shiro): Browser OS in TypeScript/Vite. Has live GitHub Pages preview
- **Foam** (williamsharkey/foam): Browser OS in plain JS. Has live GitHub Pages preview
- **Windwalker** (williamsharkey/windwalker): Test automation suite for shiro/foam
- **Spirit** (williamsharkey/spirit): Claude Code agent loop library
- **FluffyCoreutils** (williamsharkey/fluffycoreutils): Shared Unix commands for browser OSes
- **Skyeyes** (williamsharkey/skyeyes): Browser-side WebSocket bridge for remote JS execution

## Key Design Decisions

- **Workers use `bypassPermissions`** for autonomous operation
- **AsyncGenerator pattern** for feeding user messages to the Agent SDK streaming input
- **Abort + await pattern** prevents concurrent processMessages loops when sending new queries
- **localStorage drafts** persist textarea content across page reloads
- **Same-origin proxy** for GitHub Pages iframes allows skyeyes full DOM access
