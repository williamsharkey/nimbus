import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import path from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import { WorkerManager } from "../workers/WorkerManager.js";
import { setupRoutes } from "./routes.js";
import { setupWebSocket } from "./ws.js";
import type { NimbusConfig, RepoConfig } from "../workers/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load config
const configPath = path.resolve(__dirname, "../../nimbus.config.json");
const rawConfig = JSON.parse(readFileSync(configPath, "utf-8"));
const basePath = rawConfig.basePath.replace("~", process.env.HOME || "");

const config: NimbusConfig = {
  port: rawConfig.port || 7777,
  basePath,
  defaultModel: rawConfig.defaultModel || "claude-sonnet-4-5-20250929",
  maxBudgetPerWorkerUsd: rawConfig.maxBudgetPerWorkerUsd || 5.0,
  maxLogEntries: rawConfig.maxLogEntries || 500,
  repos: rawConfig.repos as RepoConfig[],
};

// Express + HTTP server
const app = express();
const server = http.createServer(app);

// WebSocket server (handles both dashboard and skyeyes connections)
const wss = new WebSocketServer({ server });
const wsHub = setupWebSocket(wss);

// Worker manager
const manager = new WorkerManager(config, wsHub.broadcast);

// Handle dashboard WebSocket messages
wsHub.onClientMessage((msg) => {
  switch (msg.type) {
    case "send_to_worker":
      manager.sendToWorker(msg.workerId, msg.message);
      break;
    case "interrupt_worker":
      manager.interruptWorker(msg.workerId);
      break;
    case "restart_worker":
      manager.restartWorker(msg.workerId);
      break;
    case "skyeyes_exec": {
      const id = msg.id || crypto.randomUUID();
      wsHub.sendToSkyeyes(msg.page, { type: "eval", id, code: msg.code });
      break;
    }
  }
});

// REST API routes
setupRoutes(app, manager, wsHub);

// Serve skyeyes.js from the skyeyes repo
const skyeyesPath = path.resolve(config.basePath, "skyeyes");
app.get("/skyeyes.js", (_req, res) => {
  res.sendFile(path.join(skyeyesPath, "skyeyes.js"));
});

// Serve dashboard static files
const clientPath = path.resolve(__dirname, "../client");
app.use(express.static(clientPath));

// Fallback to index.html for SPA
app.get("/", (_req, res) => {
  res.sendFile(path.join(clientPath, "index.html"));
});

// Start
server.listen(config.port, () => {
  console.log(`Nimbus dashboard: http://localhost:${config.port}`);
  console.log(`Base path: ${config.basePath}`);
  console.log(`Workers: ${config.repos.map((r) => r.name).join(", ")}`);

  // Start workers after server is ready
  manager.startAll().catch((err) => {
    console.error("Failed to start workers:", err);
  });
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\nShutting down workers...");
  await manager.shutdownAll();
  server.close();
  process.exit(0);
});
