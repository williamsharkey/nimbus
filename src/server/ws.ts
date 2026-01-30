import { WebSocketServer, WebSocket } from "ws";
import type { WsServerMessage, WsClientMessage, SkyeyesBridgeMessage, SkyeyesCommand } from "../workers/types.js";

export interface WsHub {
  broadcast: (msg: WsServerMessage) => void;
  sendToSkyeyes: (page: string, cmd: SkyeyesCommand) => boolean;
  onClientMessage: (handler: (msg: WsClientMessage) => void) => void;
  waitForSkyeyesResult: (page: string, id: string, timeoutMs?: number) => Promise<{ result: unknown; error: string | null }>;
  getSkyeyesStatus: () => Record<string, boolean>;
}

export function setupWebSocket(wss: WebSocketServer): WsHub {
  const dashboardClients = new Set<WebSocket>();
  const skyeyesBridges = new Map<string, WebSocket>(); // page -> ws
  const clientMessageHandlers: Array<(msg: WsClientMessage) => void> = [];
  const pendingEvals = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>();
  const aliveBridges = new WeakSet<WebSocket>();

  // Server-side heartbeat: detect dead bridge connections every 15s
  const BRIDGE_PING_INTERVAL = 15_000;
  const bridgePingTimer = setInterval(() => {
    for (const [page, bridgeWs] of skyeyesBridges) {
      if (!aliveBridges.has(bridgeWs)) {
        // No pong received since last ping — connection is dead
        console.log(`Skyeyes bridge dead (no pong): ${page}`);
        skyeyesBridges.delete(page);
        bridgeWs.terminate();
        continue;
      }
      aliveBridges.delete(bridgeWs);
      bridgeWs.ping();
    }
  }, BRIDGE_PING_INTERVAL);
  bridgePingTimer.unref(); // Don't keep process alive for this timer

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url || "/", "http://localhost");

    if (url.pathname === "/skyeyes") {
      // Skyeyes bridge connection from an iframe
      const page = url.searchParams.get("page") || "unknown";

      // Close stale connection for this page (e.g. after iframe reload)
      const oldWs = skyeyesBridges.get(page);
      if (oldWs && oldWs !== ws) {
        console.log(`Skyeyes bridge replacing stale connection: ${page}`);
        oldWs.close(4000, "replaced");
      }

      console.log(`Skyeyes bridge connected: ${page}`);
      skyeyesBridges.set(page, ws);
      aliveBridges.add(ws); // Mark alive on connect

      ws.on("pong", () => {
        aliveBridges.add(ws);
      });

      ws.on("message", (raw) => {
        try {
          const msg: SkyeyesBridgeMessage = JSON.parse(raw.toString());
          if (msg.type === "skyeyes_result") {
            // Route result to pending eval
            const pending = pendingEvals.get(msg.id);
            if (pending) {
              pending.resolve({ result: msg.result, error: msg.error });
              pendingEvals.delete(msg.id);
            }
            // Also broadcast to dashboard
            broadcast({
              type: "skyeyes_result",
              page,
              id: msg.id,
              result: msg.result,
              error: msg.error,
            });
          } else if (msg.type === "skyeyes_console") {
            broadcast({
              type: "skyeyes_console",
              page,
              level: msg.level,
              args: msg.args,
            });
          } else if (msg.type === "ping") {
            // Respond to client-side heartbeat pings
            ws.send(JSON.stringify({ type: "pong" }));
          }
        } catch {}
      });

      ws.on("close", () => {
        console.log(`Skyeyes bridge disconnected: ${page}`);
        if (skyeyesBridges.get(page) === ws) {
          skyeyesBridges.delete(page);
        }
      });
      return;
    }

    // Dashboard client
    dashboardClients.add(ws);

    ws.on("message", (raw) => {
      try {
        const msg: WsClientMessage = JSON.parse(raw.toString());
        for (const handler of clientMessageHandlers) {
          handler(msg);
        }
      } catch {}
    });

    ws.on("close", () => {
      dashboardClients.delete(ws);
    });
  });

  function broadcast(msg: WsServerMessage): void {
    const data = JSON.stringify(msg);
    for (const client of dashboardClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  function sendToSkyeyes(page: string, cmd: SkyeyesCommand): boolean {
    const ws = skyeyesBridges.get(page);
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(cmd));
    return true;
  }

  function waitForSkyeyesResult(
    page: string,
    id: string,
    timeoutMs = 10000,
  ): Promise<{ result: unknown; error: string | null }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingEvals.delete(id);
        reject(new Error(`Skyeyes eval timed out for page ${page}`));
      }, timeoutMs);

      pendingEvals.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  function getSkyeyesStatus(): Record<string, boolean> {
    const status: Record<string, boolean> = {};
    for (const [page, ws] of skyeyesBridges) {
      status[page] = ws.readyState === WebSocket.OPEN;
    }
    return status;
  }

  return {
    broadcast,
    sendToSkyeyes,
    onClientMessage: (handler) => clientMessageHandlers.push(handler),
    waitForSkyeyesResult,
    getSkyeyesStatus,
  };
}
