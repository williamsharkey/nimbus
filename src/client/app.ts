// Nimbus Dashboard - Client-side logic

interface WorkerState {
  id: string;
  repoName: string;
  status: string;
  currentTask: string | null;
  lastError: string | null;
  outputLog: LogEntry[];
  tmuxSession?: string;
  liveUrl?: string;
  githubUrl?: string;
  model?: string;
  issues?: GitHubIssue[];
}

interface GitHubIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  comments: number;
  updated_at: string;
  html_url: string;
  labels: Array<{ name: string; color: string }>;
}

interface LogEntry {
  timestamp: number;
  type: string;
  content: string;
  toolName?: string;
}

interface ActivityItem {
  type: "issue" | "push";
  repo: string;
  title: string;
  time: string;
  url: string;
  number?: number;
  state?: string;
  labels?: string[];
  comments?: number;
  sha?: string;
  author?: string;
}

// State
const workers = new Map<string, WorkerState>();
const logs = new Map<string, LogEntry[]>();
let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
let activityItems: ActivityItem[] = [];
let activityTimer: number | null = null;

// Command history per worker
const commandHistory = new Map<string, string[]>();
const historyIndex = new Map<string, number>();

// Status colors
const statusColors: Record<string, string> = {
  idle: "#3fb950",
  working: "#d29922",
  error: "#f85149",
  interrupted: "#bc8cff",
  starting: "#58a6ff",
};

// WebSocket connection
function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    const dot = document.getElementById("connection-status")!;
    dot.className = "connected";
    dot.title = "Connected";
    fetch("/api/workers")
      .then((r) => r.json())
      .then((data: WorkerState[]) => {
        data.forEach((w) => {
          workers.set(w.id, w);
          logs.set(w.id, w.outputLog || []);
        });
        renderAll();
        fetchActivity();
      });
    if (activityTimer) clearInterval(activityTimer);
    activityTimer = window.setInterval(fetchActivity, 60_000);
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    switch (msg.type) {
      case "worker_update":
        workers.set(msg.worker.id, msg.worker);
        renderWorkerCard(msg.worker.id);
        break;
      case "worker_log": {
        const wLogs = logs.get(msg.workerId) || [];
        wLogs.push(msg.entry);
        if (wLogs.length > 300) wLogs.splice(0, wLogs.length - 300);
        logs.set(msg.workerId, wLogs);
        appendLogEntry(msg.workerId, msg.entry);
        break;
      }
      case "all_workers":
        msg.workers.forEach((w: WorkerState) => {
          workers.set(w.id, w);
          logs.set(w.id, w.outputLog || []);
        });
        renderAll();
        break;
      case "skyeyes_result":
        showSkyeyesResult(msg.page, msg.result, msg.error);
        break;
      case "skyeyes_console":
        appendLiveConsole(msg.page, msg.level, msg.args);
        break;
    }
  };

  ws.onclose = () => {
    const dot = document.getElementById("connection-status")!;
    dot.className = "";
    dot.title = "Disconnected";
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 2000);
}

function wsSend(msg: any) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// Rendering
function renderAll() {
  renderActivityFeed();
  const grid = document.getElementById("worker-grid")!;
  grid.innerHTML = "";
  for (const [id] of workers) {
    renderWorkerCard(id);
  }
  renderLivePages();
}

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function fetchActivity() {
  fetch("/api/activity")
    .then((r) => r.json())
    .then((items: ActivityItem[]) => {
      activityItems = items;

      // Populate per-worker issues from activity data
      const issuesByRepo = new Map<string, GitHubIssue[]>();
      for (const item of items) {
        if (item.type === "issue") {
          const repoIssues = issuesByRepo.get(item.repo) || [];
          repoIssues.push({
            number: item.number!,
            title: item.title,
            state: (item.state as "open" | "closed") || "open",
            comments: item.comments || 0,
            updated_at: item.time,
            html_url: item.url,
            labels: (item.labels || []).map((name) => ({ name, color: "30363d" })),
          });
          issuesByRepo.set(item.repo, repoIssues);
        }
      }

      for (const [id, w] of workers) {
        w.issues = issuesByRepo.get(id) || [];
      }

      renderActivityFeed();
      for (const [id] of workers) {
        renderWorkerCard(id);
      }
    })
    .catch(() => {});
}

function renderActivityFeed() {
  const section = document.getElementById("activity-section")!;
  if (!section) return;

  if (activityItems.length === 0) {
    section.innerHTML = `
      <div class="activity-header">
        <span class="activity-title">Activity</span>
      </div>
      <div class="activity-list">
        <div class="activity-empty">Loading activity...</div>
      </div>
    `;
    return;
  }

  const items = activityItems.slice(0, 50);

  section.innerHTML = `
    <div class="activity-header">
      <span class="activity-title">Activity</span>
      <span class="activity-count">${activityItems.length} events across 7 repos</span>
    </div>
    <div class="activity-list">
      ${items.map((item) => {
        const tag = item.type === "issue" ? "issue" : "push";
        const tagLabel = item.type === "issue" ? "issue" : "push";
        const ref = item.type === "issue"
          ? `<span class="activity-number">#${item.number}</span>`
          : `<span class="activity-sha">${item.sha || ""}</span>`;
        return `<div class="activity-row">
          <span class="activity-tag ${tag}">${tagLabel}</span>
          <span class="activity-repo">${escapeHtml(item.repo)}</span>
          ${ref}
          <span class="activity-text"><a href="${escapeHtml(item.url)}" target="_blank">${escapeHtml(item.title)}</a></span>
          <span class="activity-time">${timeAgo(item.time)}</span>
        </div>`;
      }).join("")}
    </div>
  `;
}

function renderWorkerCard(id: string) {
  const w = workers.get(id);
  if (!w) return;

  let card = document.getElementById(`worker-${id}`);
  if (!card) {
    card = document.createElement("div");
    card.id = `worker-${id}`;
    card.className = "worker-card";
    document.getElementById("worker-grid")!.appendChild(card);
  }

  const existingTextarea = document.getElementById(`input-${id}`) as HTMLTextAreaElement;
  const preservedValue = existingTextarea ? existingTextarea.value : "";

  card.setAttribute("data-status", w.status);
  const color = statusColors[w.status] || "#8b949e";
  const wLogs = logs.get(id) || [];
  const currentModel = w.model || "opus";
  const githubUrl = w.githubUrl || `https://github.com/${w.repoName}`;

  card.innerHTML = `
    <div class="card-header">
      <span class="status-dot" style="background:${color}"></span>
      <div class="worker-title">
        <h2 onclick="toggleModelDropdown('${id}')" style="cursor:pointer">${w.repoName} ▾</h2>
        <div class="model-dropdown" id="model-dropdown-${id}" style="display:none">
          <label><input type="radio" name="model-${id}" value="sonnet" ${currentModel === "sonnet" ? "checked" : ""} onchange="changeModel('${id}', 'sonnet')"> Sonnet</label>
          <label><input type="radio" name="model-${id}" value="opus" ${currentModel === "opus" ? "checked" : ""} onchange="changeModel('${id}', 'opus')"> Opus</label>
          <label><input type="radio" name="model-${id}" value="haiku" ${currentModel === "haiku" ? "checked" : ""} onchange="changeModel('${id}', 'haiku')"> Haiku</label>
        </div>
      </div>
      <a href="${githubUrl}" target="_blank" class="github-link" title="Open in GitHub">GH</a>
      <span class="status-label">${w.status}</span>
    </div>
    ${w.currentTask ? `<div class="current-task">${escapeHtml(w.currentTask)}</div>` : ""}
    <div class="card-meta">
      <span class="model-badge">${currentModel}</span>
      ${w.tmuxSession ? `<span class="tmux-badge">${w.tmuxSession}</span>` : ""}
      ${w.lastError ? `<span style="color:var(--red)">err</span>` : ""}
    </div>
    <div class="log-container" id="log-${id}">${renderLogEntries(wLogs.slice(-50))}</div>
    <div class="card-input">
      <textarea id="input-${id}" placeholder="Message ${w.repoName}..." onkeydown="handleWorkerKey(event, '${id}')"></textarea>
      <button class="btn btn-sm" onclick="sendToWorker('${id}')">Send</button>
      <button class="btn btn-sm btn-danger" onclick="interruptWorker('${id}')">Stop</button>
    </div>
  `;

  const logEl = document.getElementById(`log-${id}`);
  if (logEl) logEl.scrollTop = logEl.scrollHeight;

  if (preservedValue) {
    const textarea = document.getElementById(`input-${id}`) as HTMLTextAreaElement;
    if (textarea) textarea.value = preservedValue;
  }
}

function renderLogEntries(entries: LogEntry[]): string {
  return entries
    .map(
      (e) =>
        `<pre class="log-entry ${e.type}">${e.toolName ? `[${e.toolName}] ` : ""}${escapeHtml(e.content.substring(0, 500))}</pre>`,
    )
    .join("");
}

function appendLogEntry(workerId: string, entry: LogEntry) {
  const logEl = document.getElementById(`log-${workerId}`);
  if (!logEl) return;
  const div = document.createElement("pre");
  div.className = `log-entry ${entry.type}`;
  div.textContent = (entry.toolName ? `[${entry.toolName}] ` : "") + entry.content.substring(0, 500);
  logEl.appendChild(div);
  while (logEl.children.length > 100) {
    logEl.removeChild(logEl.firstChild!);
  }
  logEl.scrollTop = logEl.scrollHeight;

  const w = workers.get(workerId);
  if (w) {
    const card = document.getElementById(`worker-${workerId}`);
    if (card) card.setAttribute("data-status", w.status);
  }
}

function renderLivePages() {
  const grid = document.getElementById("live-grid")!;
  grid.innerHTML = "";

  const liveUrls = new Map<string, string>();
  for (const [, w] of workers) {
    if (w.liveUrl) liveUrls.set(w.id, w.liveUrl);
  }

  for (const [, w] of workers) {
    const card = document.createElement("div");
    card.className = "live-card";
    card.id = `live-${w.id}`;

    let iframesHtml = "";
    for (const [osName, osUrl] of liveUrls) {
      const iframeSrc = w.id === osName ? osUrl : `${osUrl}/${w.id}`;
      iframesHtml += `<iframe src="${iframeSrc}" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" title="${osName}-${w.id}"></iframe>\n`;
    }

    card.innerHTML = `
      <h3>
        <span>${w.repoName}</span>
        <button class="btn btn-sm" onclick="reloadIframe('${w.id}')">Reload</button>
      </h3>
      <div class="live-iframes">${iframesHtml}</div>
      <div class="live-exec">
        <input id="exec-${w.id}" placeholder="Execute JS in ${w.repoName}..." onkeydown="handleExecKey(event, '${w.id}')">
        <button class="btn btn-sm" onclick="execSkyeyes('${w.id}')">Run</button>
      </div>
      <div class="live-result" id="result-${w.id}"></div>
    `;
    grid.appendChild(card);
  }
}

// Actions
function sendToWorker(id: string) {
  const textarea = document.getElementById(`input-${id}`) as HTMLTextAreaElement;
  const message = textarea.value.trim();
  if (!message) return;

  const history = commandHistory.get(id) || [];
  history.push(message);
  if (history.length > 50) history.shift();
  commandHistory.set(id, history);
  historyIndex.set(id, history.length);

  wsSend({ type: "send_to_worker", workerId: id, message });
  textarea.value = "";
}

function interruptWorker(id: string) {
  wsSend({ type: "interrupt_worker", workerId: id });
}

function handleWorkerKey(event: KeyboardEvent, id: string) {
  const textarea = event.target as HTMLTextAreaElement;
  const history = commandHistory.get(id) || [];
  let currentIndex = historyIndex.get(id) ?? history.length;

  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendToWorker(id);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    if (history.length > 0 && currentIndex > 0) {
      currentIndex--;
      historyIndex.set(id, currentIndex);
      textarea.value = history[currentIndex];
    }
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    if (currentIndex < history.length - 1) {
      currentIndex++;
      historyIndex.set(id, currentIndex);
      textarea.value = history[currentIndex];
    } else if (currentIndex === history.length - 1) {
      currentIndex = history.length;
      historyIndex.set(id, currentIndex);
      textarea.value = "";
    }
  }
}

function broadcastMessage() {
  const textarea = document.getElementById("orchestrator-msg") as HTMLTextAreaElement;
  const message = textarea.value.trim();
  if (!message) return;
  for (const [id] of workers) {
    wsSend({ type: "send_to_worker", workerId: id, message });
  }
  textarea.value = "";
}

function execSkyeyes(page: string) {
  const input = document.getElementById(`exec-${page}`) as HTMLInputElement;
  const code = input.value.trim();
  if (!code) return;

  const id = crypto.randomUUID();
  wsSend({ type: "skyeyes_exec", page, code, id });

  const resultEl = document.getElementById(`result-${page}`);
  if (resultEl) {
    resultEl.textContent = "Executing...";
    resultEl.className = "live-result";
  }
}

function handleExecKey(event: KeyboardEvent, page: string) {
  if (event.key === "Enter") {
    event.preventDefault();
    execSkyeyes(page);
  }
}

function showSkyeyesResult(page: string, result: unknown, error: string | null) {
  const resultEl = document.getElementById(`result-${page}`);
  if (!resultEl) return;
  if (error) {
    resultEl.textContent = `Error: ${error}`;
    resultEl.className = "live-result error";
  } else {
    resultEl.textContent = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    resultEl.className = "live-result";
  }
}

function appendLiveConsole(page: string, level: string, args: unknown[]) {
  const resultEl = document.getElementById(`result-${page}`);
  if (!resultEl) return;
  const line = `[${level}] ${args.join(" ")}`;
  resultEl.textContent = line;
  if (level === "error") {
    resultEl.className = "live-result error";
  }
}

function reloadIframe(id: string) {
  const card = document.getElementById(`live-${id}`);
  if (!card) return;
  const iframes = card.querySelectorAll("iframe") as NodeListOf<HTMLIFrameElement>;
  for (const iframe of iframes) iframe.src = iframe.src;
}

// Model dropdown functions
function toggleModelDropdown(workerId: string) {
  const dropdown = document.getElementById(`model-dropdown-${workerId}`);
  if (!dropdown) return;

  document.querySelectorAll(".model-dropdown").forEach((d) => {
    if (d.id !== `model-dropdown-${workerId}`) {
      (d as HTMLElement).style.display = "none";
    }
  });

  dropdown.style.display = dropdown.style.display === "none" ? "block" : "none";
}

function changeModel(workerId: string, model: string) {
  wsSend({ type: "change_model", workerId, model });
  const worker = workers.get(workerId);
  if (worker) {
    worker.model = model;
    const badge = document.querySelector(`#worker-${workerId} .model-badge`);
    if (badge) badge.textContent = model;
    const dropdown = document.getElementById(`model-dropdown-${workerId}`);
    if (dropdown) dropdown.style.display = "none";
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Expose to onclick handlers
(window as any).sendToWorker = sendToWorker;
(window as any).interruptWorker = interruptWorker;
(window as any).broadcastMessage = broadcastMessage;
(window as any).execSkyeyes = execSkyeyes;
(window as any).handleWorkerKey = handleWorkerKey;
(window as any).handleExecKey = handleExecKey;
(window as any).reloadIframe = reloadIframe;
(window as any).toggleModelDropdown = toggleModelDropdown;
(window as any).changeModel = changeModel;

// --- localStorage persistence for textarea drafts ---
const STORAGE_KEY = "nimbus-drafts";

function saveDraft(id: string, value: string) {
  try {
    const drafts = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (value) {
      drafts[id] = value;
    } else {
      delete drafts[id];
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
  } catch {}
}

function loadDraft(id: string): string {
  try {
    const drafts = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return drafts[id] || "";
  } catch {
    return "";
  }
}

function attachDraftListeners() {
  for (const [id] of workers) {
    const textarea = document.getElementById(`input-${id}`) as HTMLTextAreaElement;
    if (textarea && !textarea.dataset.draftBound) {
      textarea.dataset.draftBound = "1";
      textarea.addEventListener("input", () => saveDraft(`input-${id}`, textarea.value));
      const saved = loadDraft(`input-${id}`);
      if (saved && !textarea.value) textarea.value = saved;
    }
  }
  const orch = document.getElementById("orchestrator-msg") as HTMLTextAreaElement;
  if (orch && !orch.dataset.draftBound) {
    orch.dataset.draftBound = "1";
    orch.addEventListener("input", () => saveDraft("orchestrator-msg", orch.value));
    const saved = loadDraft("orchestrator-msg");
    if (saved && !orch.value) orch.value = saved;
  }
  for (const [, w] of workers) {
    if (!w.liveUrl) continue;
    const input = document.getElementById(`exec-${w.id}`) as HTMLInputElement;
    if (input && !input.dataset.draftBound) {
      input.dataset.draftBound = "1";
      input.addEventListener("input", () => saveDraft(`exec-${w.id}`, input.value));
      const saved = loadDraft(`exec-${w.id}`);
      if (saved && !input.value) input.value = saved;
    }
  }
}

// Hook renderAll to attach draft listeners
const _origRenderAll = renderAll;
(window as any)._renderAll = renderAll;
function patchedRenderAll() {
  _origRenderAll();
  setTimeout(attachDraftListeners, 0);
}
(renderAll as any) = patchedRenderAll;

const _origSendToWorker = sendToWorker;
(window as any).sendToWorker = function(id: string) {
  _origSendToWorker(id);
  saveDraft(`input-${id}`, "");
};
const _origBroadcastMessage = broadcastMessage;
(window as any).broadcastMessage = function() {
  _origBroadcastMessage();
  saveDraft("orchestrator-msg", "");
};

// --- Terminal resize ---
function measureCols(): number {
  const span = document.createElement("span");
  span.style.cssText =
    'font-family:"SF Mono","Fira Code",monospace;font-size:11px;position:absolute;visibility:hidden;white-space:pre';
  span.textContent = "X";
  document.body.appendChild(span);
  const charWidth = span.getBoundingClientRect().width;
  document.body.removeChild(span);

  const logEl = document.querySelector(".log-container") as HTMLElement | null;
  if (!logEl || charWidth === 0) return 120; // fallback
  const style = getComputedStyle(logEl);
  const paddingLeft = parseFloat(style.paddingLeft) || 0;
  const paddingRight = parseFloat(style.paddingRight) || 0;
  const availableWidth = logEl.clientWidth - paddingLeft - paddingRight;
  return Math.max(40, Math.floor(availableWidth / charWidth));
}

let resizeDebounce: number | null = null;
let lastSentCols = 0;

function sendResize() {
  const cols = measureCols();
  if (cols === lastSentCols) return;
  lastSentCols = cols;
  wsSend({ type: "resize", cols, rows: 50 });
}

function scheduleResize() {
  if (resizeDebounce) clearTimeout(resizeDebounce);
  resizeDebounce = window.setTimeout(sendResize, 500);
}

// Send resize after initial render and on window resize
const _origConnect = connect;
function patchedConnect() {
  _origConnect();
  // After connect + initial render, measure and send
  setTimeout(sendResize, 1500);
}

const resizeObserver = new ResizeObserver(scheduleResize);
setTimeout(() => {
  const grid = document.getElementById("worker-grid");
  if (grid) resizeObserver.observe(grid);
}, 500);
window.addEventListener("resize", scheduleResize);

// Start
patchedConnect();
setTimeout(attachDraftListeners, 500);
