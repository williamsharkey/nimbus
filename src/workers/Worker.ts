import { execSync } from "child_process";
import { writeFileSync } from "fs";
import path from "path";
import pkg from "@xterm/headless";
const { Terminal } = pkg;
import type { WorkerState, LogEntry, RepoConfig } from "./types.js";

export interface WorkerCallbacks {
  onStateChange: (worker: WorkerState) => void;
  onLogEntry: (workerId: string, entry: LogEntry) => void;
}

const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const MCP_CONFIG = path.resolve(
  process.env.MCP_CONFIG || path.join(import.meta.dirname, "../../skyeyes-mcp.json")
);
const POLL_INTERVAL_MS = 1500;
const CAPTURE_LINES = 200;

function execSafe(cmd: string): string {
  try {
    return execSync(cmd, { maxBuffer: 1024 * 1024, timeout: 5000 }).toString();
  } catch {
    return "";
  }
}

type TerminalInstance = InstanceType<typeof Terminal>;

// Read the visible text from a headless xterm Terminal buffer
function readTerminalBuffer(term: TerminalInstance): string {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < term.rows; y++) {
    const line = buf.getLine(y);
    if (!line) { lines.push(""); continue; }
    let text = "";
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      text += cell ? (cell.getChars() || " ") : " ";
    }
    lines.push(text.trimEnd());
  }
  return lines.join("\n");
}

export class Worker {
  public state: WorkerState;
  private callbacks: WorkerCallbacks;
  private maxLogEntries: number;
  private model: string;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private terminal: TerminalInstance;
  private lastScreenText = "";

  constructor(
    config: RepoConfig,
    basePath: string,
    model: string,
    maxLogEntries: number,
    callbacks: WorkerCallbacks,
    _port: number = 7777,
  ) {
    this.model = model;
    this.maxLogEntries = maxLogEntries;
    this.callbacks = callbacks;
    this.terminal = new Terminal({
      rows: 50,
      cols: 200,
      scrollback: 0,
      allowProposedApi: true,
    });
    this.state = {
      id: config.name,
      repoName: config.name,
      repoPath: `${basePath}/${config.name}`,
      githubUrl: `https://github.com/${config.githubUser}/${config.name}`,
      liveUrl: config.liveUrl,
      status: "idle",
      tmuxSession: `nimbus-${config.name}`,
      currentTask: null,
      lastError: null,
      outputLog: [],
    };
  }

  async start(): Promise<void> {
    this.state.status = "starting";
    this.state.lastError = null;
    this.emitStateChange();

    const session = this.state.tmuxSession;
    const repoPath = this.state.repoPath;

    try {
      // Kill any existing session
      execSafe(`tmux kill-session -t ${session} 2>/dev/null`);
      await sleep(200);

      // Create new detached tmux session in the repo directory
      // -x 200 -y 50 gives a wide pane for clean output
      execSync(
        `tmux new-session -d -s ${session} -c ${shellEscape(repoPath)} -x 200 -y 50`,
        { timeout: 5000 },
      );

      // Launch claude CLI inside the tmux session
      const claudeCmd = [
        CLAUDE_BIN,
        "--model", this.model,
        "--dangerously-skip-permissions",
        "--mcp-config", MCP_CONFIG,
      ].join(" ");

      execSync(`tmux send-keys -t ${session} ${shellEscape(claudeCmd)} Enter`, {
        timeout: 5000,
      });

      this.addLog("system", `Started tmux session "${session}" in ${repoPath}`);
      this.addLog("system", `Launching: ${claudeCmd}`);

      // Start polling for output
      this.startPolling();

      // Wait a moment then check if the session is alive
      await sleep(2000);
      const alive = this.isSessionAlive();
      if (alive) {
        this.state.status = "working"; // Claude CLI is starting up
        this.addLog("system", "Claude Code CLI starting...");
      } else {
        this.state.status = "error";
        this.state.lastError = "tmux session died immediately";
        this.addLog("error", "tmux session died immediately after start");
      }
      this.emitStateChange();
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

    const session = this.state.tmuxSession;

    try {
      // For multiline or special characters, use tmux load-buffer + paste
      // For simple single-line messages, use send-keys -l (literal)
      if (text.includes("\n") || text.length > 500) {
        // Write to a temp file and use tmux load-buffer + paste-buffer
        const tmpFile = `/tmp/nimbus-msg-${this.state.id}.txt`;
        writeFileSync(tmpFile, text);
        execSync(`tmux load-buffer ${tmpFile}`, { timeout: 5000 });
        execSync(`tmux paste-buffer -t ${session}`, { timeout: 5000 });
        execSync(`tmux send-keys -t ${session} Enter`, { timeout: 5000 });
      } else {
        // Simple single-line: send literally then Enter
        execSync(`tmux send-keys -t ${session} -l ${shellEscape(text)}`, {
          timeout: 5000,
        });
        execSync(`tmux send-keys -t ${session} Enter`, { timeout: 5000 });
      }

      this.state.status = "working";
      this.emitStateChange();
    } catch (err) {
      this.addLog("error", `Failed to send message: ${err}`);
      this.state.lastError = String(err);
      this.emitStateChange();
    }
  }

  async interrupt(): Promise<void> {
    const session = this.state.tmuxSession;
    try {
      // Send Escape key — Claude Code's interrupt
      execSync(`tmux send-keys -t ${session} Escape`, { timeout: 5000 });
      this.state.status = "interrupted";
      this.state.currentTask = null;
      this.addLog("system", "Interrupted (sent Escape)");
      this.emitStateChange();
    } catch (err) {
      this.addLog("error", `Failed to interrupt: ${err}`);
    }
  }

  async shutdown(): Promise<void> {
    this.stopPolling();
    const session = this.state.tmuxSession;
    try {
      execSafe(`tmux kill-session -t ${session} 2>/dev/null`);
      this.addLog("system", "tmux session killed");
    } catch {}
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      this.captureOutput();
    }, POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async captureOutput(): Promise<void> {
    const session = this.state.tmuxSession;

    try {
      const raw = execSafe(
        `tmux capture-pane -t ${session} -p -S -${CAPTURE_LINES}`
      );

      if (!raw) {
        if (!this.isSessionAlive()) {
          this.state.status = "error";
          this.state.lastError = "tmux session ended";
          this.stopPolling();
          this.addLog("system", "tmux session ended");
          this.emitStateChange();
        }
        return;
      }

      // Feed raw output through headless xterm to properly interpret all escape sequences
      // write() is async — wait for callback before reading buffer
      this.terminal.reset();
      await new Promise<void>((resolve) => {
        this.terminal.write(raw, resolve);
      });

      // Read the rendered screen buffer as clean text
      const screenText = readTerminalBuffer(this.terminal);

      // Only emit if content changed
      if (screenText === this.lastScreenText) return;

      // Diff to find new content
      let newContent = "";
      if (this.lastScreenText === "") {
        newContent = screenText.split("\n").filter((l) => l.trim()).join("\n");
      } else {
        const oldJoined = this.lastScreenText.split("\n").filter((l) => l.trim()).join("\n");
        const newJoined = screenText.split("\n").filter((l) => l.trim()).join("\n");

        if (newJoined.startsWith(oldJoined)) {
          newContent = newJoined.slice(oldJoined.length).trim();
        } else {
          newContent = newJoined;
        }
      }

      this.lastScreenText = screenText;

      if (newContent) {
        this.addLog("output", newContent);
      }

      this.detectStatus(screenText);
    } catch {
      // Capture failed silently
    }
  }

  private detectStatus(cleanOutput: string): void {
    const lines = cleanOutput.split("\n").filter((l) => l.trim());
    if (lines.length === 0) return;

    // Claude Code's TUI has the ❯ prompt on a line near the bottom,
    // with a status bar ("bypass permissions", tool names) below it.
    // Check the last 10 lines for the idle prompt.
    const tail = lines.slice(-10);
    const hasPrompt = tail.some((line) => {
      const trimmed = line.trim();
      // Match ❯ prompt line (idle input) or placeholder hint
      return trimmed.includes("❯") || trimmed.match(/^>\s*$/);
    });

    // Detect working: status bar shows tool names like "Read", "Bash", "Edit", etc.
    const hasToolActivity = tail.some((line) => {
      const trimmed = line.trim();
      return /\b(Read|Bash|Edit|Write|Grep|Glob|Task)\b/.test(trimmed)
        && !trimmed.includes("Try ");
    });

    if (hasPrompt && !hasToolActivity) {
      if (this.state.status !== "idle" && this.state.status !== "interrupted") {
        this.state.status = "idle";
        this.state.currentTask = null;
        this.emitStateChange();
      }
    } else if (hasToolActivity && this.state.status === "idle") {
      this.state.status = "working";
      this.emitStateChange();
    }
  }

  private isSessionAlive(): boolean {
    const result = execSafe(`tmux has-session -t ${this.state.tmuxSession} 2>&1`);
    // tmux has-session returns empty string on success, error message on failure
    return !result.includes("no ");
  }

  resize(cols: number, rows: number): void {
    const session = this.state.tmuxSession;
    execSafe(`tmux resize-window -t ${session} -x ${cols} -y ${rows}`);
    this.terminal.resize(cols, rows);
    this.addLog("system", `Resized to ${cols}x${rows}`);
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function shellEscape(str: string): string {
  // Wrap in single quotes, escaping any existing single quotes
  return "'" + str.replace(/'/g, "'\\''") + "'";
}
