import { query } from "@anthropic-ai/claude-agent-sdk";
import type { WorkerState, LogEntry, RepoConfig } from "./types.js";
import { createSkyeyesMcpServer } from "../mcp/skyeyes-tools.js";

export interface WorkerCallbacks {
  onStateChange: (worker: WorkerState) => void;
  onLogEntry: (workerId: string, entry: LogEntry) => void;
}

interface PendingMessage {
  resolve: (value: any) => void;
}

// Shared MCP server instance — created once, reused by all workers
let skyeyesMcp: ReturnType<typeof createSkyeyesMcpServer> | null = null;

function getSkyeyesMcp(port: number) {
  if (!skyeyesMcp) {
    skyeyesMcp = createSkyeyesMcpServer(port);
  }
  return skyeyesMcp;
}

export class Worker {
  public state: WorkerState;
  private queryHandle: any = null;
  private abortController: AbortController | null = null;
  private messageQueue: PendingMessage[] = [];
  private pendingMessages: any[] = [];
  private callbacks: WorkerCallbacks;
  private maxLogEntries: number;
  private model: string;
  private shutdownRequested = false;
  private processing: Promise<void> | null = null;
  private port: number;

  constructor(
    config: RepoConfig,
    basePath: string,
    model: string,
    maxLogEntries: number,
    callbacks: WorkerCallbacks,
    port: number = 7777,
  ) {
    this.model = model;
    this.maxLogEntries = maxLogEntries;
    this.callbacks = callbacks;
    this.port = port;
    this.state = {
      id: config.name,
      repoName: config.name,
      repoPath: `${basePath}/${config.name}`,
      githubUrl: `https://github.com/${config.githubUser}/${config.name}`,
      liveUrl: config.liveUrl,
      status: "idle",
      sessionId: null,
      currentTask: null,
      lastError: null,
      outputLog: [],
      costUsd: 0,
      turnsCompleted: 0,
    };
  }

  async start(): Promise<void> {
    this.abortController = new AbortController();
    this.shutdownRequested = false;
    this.state.status = "starting";
    this.state.lastError = null;
    this.emitStateChange();

    try {
      this.queryHandle = query({
        prompt: `You are a worker agent for the "${this.state.repoName}" repository at ${this.state.repoPath}. You have skyeyes MCP tools (prefixed with mcp__skyeyes__) for interacting with live browser pages. Available tools: mcp__skyeyes__skyeyes_eval, mcp__skyeyes__terminal_exec, mcp__skyeyes__terminal_read, mcp__skyeyes__terminal_status, mcp__skyeyes__skyeyes_reload, mcp__skyeyes__skyeyes_status. Your dedicated page IDs are: "shiro-${this.state.id}" (your shiro iframe) and "foam-${this.state.id}" (your foam iframe). Always use these page IDs — they are your isolated browser contexts that no other worker shares. Await instructions.`,
        options: {
          cwd: this.state.repoPath,
          model: this.model,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          abortController: this.abortController,
          maxTurns: 50,
          mcpServers: { skyeyes: getSkyeyesMcp(this.port) },
        },
      });

      this.processing = this.processMessages();
    } catch (err) {
      this.state.status = "error";
      this.state.lastError = String(err);
      this.addLog("error", `Failed to start: ${err}`);
      this.emitStateChange();
    }
  }

  sendMessage(text: string): void {
    this.state.currentTask = text.substring(0, 120);
    this.addLog("user", text);

    // For now, each sendMessage starts a new query since streaming input
    // requires the unstable v2 API. We resume the session to keep context.
    this.startNewQuery(text);
  }

  private async startNewQuery(prompt: string): Promise<void> {
    // Abort the previous query and wait for its processMessages loop to finish
    if (this.abortController) {
      this.abortController.abort();
    }
    if (this.processing) {
      await this.processing.catch(() => {});
      this.processing = null;
    }

    this.abortController = new AbortController();
    this.state.status = "working";
    this.emitStateChange();

    try {
      const opts: any = {
        cwd: this.state.repoPath,
        model: this.model,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        abortController: this.abortController,
        maxTurns: 50,
        mcpServers: { skyeyes: getSkyeyesMcp(this.port) },
      };

      if (this.state.sessionId) {
        opts.resume = this.state.sessionId;
      }

      this.queryHandle = query({ prompt, options: opts });
      this.processing = this.processMessages();
      await this.processing;
    } catch (err) {
      this.state.status = "error";
      this.state.lastError = String(err);
      this.addLog("error", String(err));
      this.emitStateChange();
    }
  }

  private async processMessages(): Promise<void> {
    if (!this.queryHandle) return;
    try {
      for await (const message of this.queryHandle) {
        this.handleMessage(message);
      }
      // Query finished naturally
      if (this.state.status === "working" || this.state.status === "starting") {
        this.state.status = "idle";
        this.state.currentTask = null;
        this.emitStateChange();
      }
    } catch (err: any) {
      if (err?.name === "AbortError" || this.shutdownRequested) {
        return;
      }
      this.state.status = "error";
      this.state.lastError = String(err);
      this.addLog("error", String(err));
      this.emitStateChange();
    }
  }

  private handleMessage(message: any): void {
    switch (message.type) {
      case "system":
        if (message.subtype === "init" && message.session_id) {
          this.state.sessionId = message.session_id;
          if (this.state.status === "starting") {
            this.state.status = "idle";
            this.emitStateChange();
          }
        }
        break;

      case "assistant": {
        const content = message.message?.content;
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (block.type === "text" && block.text) {
            this.addLog("assistant", block.text);
          } else if (block.type === "tool_use") {
            const input = JSON.stringify(block.input ?? {}).substring(0, 300);
            this.addLog("tool", `${block.name}: ${input}`, block.name);
          }
        }
        break;
      }

      case "result": {
        this.state.status = "idle";
        this.state.currentTask = null;
        if (message.subtype === "success") {
          if (message.total_cost_usd) this.state.costUsd += message.total_cost_usd;
          if (message.num_turns) this.state.turnsCompleted += message.num_turns;
          if (message.result) this.addLog("result", message.result);
        } else if (message.subtype === "error_max_turns") {
          this.addLog("system", `Reached max turns (${message.num_turns || "?"})`);
          if (message.total_cost_usd) this.state.costUsd += message.total_cost_usd;
          if (message.num_turns) this.state.turnsCompleted += message.num_turns;
        } else {
          const errMsg = message.error || message.subtype || "Unknown error";
          this.state.lastError = errMsg;
          this.addLog("error", errMsg);
        }
        this.emitStateChange();
        break;
      }
    }
  }

  async interrupt(): Promise<void> {
    this.abortController?.abort();
    this.state.status = "interrupted";
    this.state.currentTask = null;
    this.addLog("system", "Interrupted by user");
    this.emitStateChange();
  }

  async shutdown(): Promise<void> {
    this.shutdownRequested = true;
    this.abortController?.abort();
  }

  private addLog(type: LogEntry["type"], content: string, toolName?: string): void {
    const entry: LogEntry = { timestamp: Date.now(), type, content, toolName };
    this.state.outputLog.push(entry);
    if (this.state.outputLog.length > this.maxLogEntries) {
      this.state.outputLog = this.state.outputLog.slice(-this.maxLogEntries);
    }
    this.callbacks.onLogEntry(this.state.id, entry);
  }

  private emitStateChange(): void {
    this.callbacks.onStateChange({ ...this.state });
  }
}
