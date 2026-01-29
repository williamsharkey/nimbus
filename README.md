# Nimbus

> Multi-worker AI agent orchestration platform with live dashboard and priority tracking

Nimbus is a TypeScript-based orchestration system for managing multiple AI agents working on different repositories simultaneously. It provides a unified web dashboard for monitoring, controlling, and interacting with your AI workers in real-time.

## Features

### 🎯 Priority Tracking
- **Top 5 Priorities Dashboard**: Compact, at-a-glance view of your most important tasks
- **Status Indicators**: Visual markers for active, pending, blocked, and completed priorities
- **Progress Tracking**: Real-time progress percentages for each priority
- **Hover Details**: Expand priorities on hover to see full descriptions and context

### 🤖 Multi-Worker Management
- Manage multiple AI workers across different repositories
- Real-time status updates (idle, working, error, interrupted)
- Cost tracking and turn counting per worker
- Interactive message input for each worker
- Stop/interrupt workers on demand

### 📺 Live Page Integration
- Embedded iframe previews of live applications
- **Skyeyes Integration**: Execute JavaScript directly in live pages via REST API
- Console output capture and display
- Reload controls for each live page

### 🔌 WebSocket Communication
- Real-time bidirectional communication
- Auto-reconnection on disconnect
- Broadcast messages to all workers
- Live log streaming from workers

### 🎨 Modern UI
- Dark theme optimized for long sessions
- Responsive grid layouts
- Color-coded status indicators
- Compact, information-dense design

## Architecture

```
nimbus/
├── src/
│   ├── server/         # Express + WebSocket server
│   │   ├── index.ts    # Main server entry
│   │   ├── routes.ts   # HTTP routes
│   │   └── ws.ts       # WebSocket handling
│   ├── workers/        # Worker management
│   │   ├── WorkerManager.ts
│   │   ├── Worker.ts
│   │   └── types.ts
│   └── client/         # Dashboard frontend
│       ├── index.html
│       ├── app.ts      # Client-side logic
│       └── style.css   # Styling
├── scripts/            # Build and utility scripts
└── nimbus.config.json  # Configuration
```

## Getting Started

### Installation

```bash
npm install
```

### Running the Dashboard

```bash
npm start
```

The dashboard will be available at `http://localhost:7777`

### Development

Build TypeScript files:
```bash
npm run build
```

Watch mode for development:
```bash
npm run dev
```

## Dashboard Components

### Priorities Section
Located at the top of the dashboard, displays your top 5 priorities:
- **Compact View**: Icon, title, and progress badge
- **Hover View**: Full details including status, progress bar, and description
- **Status Types**:
  - ⚡ Active (orange) - Currently being worked on
  - ○ Pending (gray) - Queued for future work
  - ⏸ Blocked (red) - Waiting on dependencies
  - ✓ Completed (green) - Finished tasks

### Worker Cards
Each worker gets its own card showing:
- Repository name and status
- Current task (if any)
- Cost and turn count
- Live log output
- Interactive message input
- Stop button for interruption

### Live Pages Section
For workers with live page URLs:
- Iframe preview of the running application
- Skyeyes JavaScript execution input
- Result/console output display
- Reload button

## Skyeyes API

Execute JavaScript in live pages:

```bash
curl -X POST http://localhost:7777/api/skyeyes/<page>/exec \
  -H "Content-Type: application/json" \
  -d '{"code":"document.title"}'
```

Replace `<page>` with the worker ID or page identifier.

## Configuration

Edit `nimbus.config.json` to customize:
- Server port
- Worker settings
- Repository paths
- API keys and credentials

## Tech Stack

- **Backend**: Node.js, Express, WebSocket (ws)
- **Frontend**: TypeScript, Vanilla JS (no framework)
- **Build**: esbuild, TypeScript compiler
- **AI**: Anthropic Claude Agent SDK

## API Endpoints

- `GET /` - Dashboard HTML
- `GET /api/workers` - Get all worker states
- `POST /api/skyeyes/:page/exec` - Execute code in live page
- `WS /` - WebSocket connection for real-time updates

## WebSocket Messages

### Client → Server
- `send_to_worker` - Send message to specific worker
- `interrupt_worker` - Stop a worker
- `skyeyes_exec` - Execute code in live page

### Server → Client
- `worker_update` - Worker state changed
- `worker_log` - New log entry
- `all_workers` - Full worker state sync
- `skyeyes_result` - JavaScript execution result
- `skyeyes_console` - Console output from live page

## Contributing

This is a personal orchestration tool, but feel free to fork and adapt for your needs!

## License

MIT
