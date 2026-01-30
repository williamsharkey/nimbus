import { Worker } from "./Worker.js";
import type { NimbusConfig, WorkerState, WsServerMessage } from "./types.js";

export class WorkerManager {
  private workers: Map<string, Worker> = new Map();
  private broadcast: (msg: WsServerMessage) => void;

  constructor(config: NimbusConfig, broadcast: (msg: WsServerMessage) => void) {
    this.broadcast = broadcast;

    for (const repo of config.repos) {
      const worker = new Worker(
        repo,
        config.basePath,
        config.defaultModel,
        config.maxLogEntries,
        {
          onStateChange: (state: WorkerState) => {
            this.broadcast({ type: "worker_update", worker: state });
          },
          onLogEntry: (workerId, entry) => {
            this.broadcast({ type: "worker_log", workerId, entry });
          },
        },
        config.port,
      );
      this.workers.set(repo.name, worker);
    }
  }

  async startAll(): Promise<void> {
    for (const [name, worker] of this.workers) {
      console.log(`Starting worker: ${name}`);
      try {
        await worker.start();
      } catch (err) {
        console.error(`Failed to start worker ${name}:`, err);
      }
      // Stagger starts
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.log("All workers started");
  }

  getWorker(id: string): Worker | undefined {
    return this.workers.get(id);
  }

  getAllStates(): WorkerState[] {
    return Array.from(this.workers.values()).map((w) => ({ ...w.state }));
  }

  sendToWorker(workerId: string, message: string): boolean {
    const worker = this.workers.get(workerId);
    if (!worker) return false;
    worker.sendMessage(message);
    return true;
  }

  async interruptWorker(workerId: string): Promise<boolean> {
    const worker = this.workers.get(workerId);
    if (!worker) return false;
    await worker.interrupt();
    return true;
  }

  async restartWorker(workerId: string): Promise<boolean> {
    const worker = this.workers.get(workerId);
    if (!worker) return false;
    await worker.shutdown();
    await new Promise((r) => setTimeout(r, 1000));
    await worker.start();
    return true;
  }

  resizeAll(cols: number, rows: number): void {
    for (const worker of this.workers.values()) {
      worker.resize(cols, rows);
    }
  }

  async shutdownAll(): Promise<void> {
    const promises = Array.from(this.workers.values()).map((w) => w.shutdown());
    await Promise.allSettled(promises);
  }
}
