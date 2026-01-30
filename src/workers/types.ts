export type WorkerStatus = "idle" | "working" | "error" | "interrupted" | "starting";

export interface WorkerState {
  id: string;
  repoName: string;
  repoPath: string;
  githubUrl: string;
  liveUrl?: string;
  status: WorkerStatus;
  tmuxSession: string;
  currentTask: string | null;
  lastError: string | null;
  outputLog: LogEntry[];
}

export interface LogEntry {
  timestamp: number;
  type: "assistant" | "tool" | "system" | "error" | "result" | "user" | "output";
  content: string;
  toolName?: string;
}

export interface Task {
  id: string;
  workerId: string;
  prompt: string;
  status: "queued" | "active" | "completed" | "failed";
  createdAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
}

// WebSocket messages server → dashboard
export type WsServerMessage =
  | { type: "worker_update"; worker: WorkerState }
  | { type: "worker_log"; workerId: string; entry: LogEntry }
  | { type: "all_workers"; workers: WorkerState[] }
  | { type: "task_update"; task: Task }
  | { type: "all_tasks"; tasks: Task[] }
  | { type: "skyeyes_result"; page: string; id: string; result: unknown; error: string | null }
  | { type: "skyeyes_console"; page: string; level: string; args: unknown[] };

// WebSocket messages dashboard → server
export type WsClientMessage =
  | { type: "send_to_worker"; workerId: string; message: string }
  | { type: "interrupt_worker"; workerId: string }
  | { type: "restart_worker"; workerId: string }
  | { type: "skyeyes_exec"; page: string; code: string; id: string };

// WebSocket messages skyeyes bridge → server
export type SkyeyesBridgeMessage =
  | { type: "skyeyes_ready"; page: string }
  | { type: "skyeyes_result"; id: string; result: unknown; error: string | null }
  | { type: "skyeyes_console"; level: string; args: unknown[] }
  | { type: "ping"; page: string; timestamp: number };

// WebSocket messages server → skyeyes bridge
export type SkyeyesCommand =
  | { type: "eval"; id: string; code: string };

export interface RepoConfig {
  name: string;
  githubUser: string;
  liveUrl?: string;
}

export interface NimbusConfig {
  port: number;
  basePath: string;
  defaultModel: string;
  maxBudgetPerWorkerUsd: number;
  maxLogEntries: number;
  repos: RepoConfig[];
}
