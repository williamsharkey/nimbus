// src/client/app.ts
var workers = /* @__PURE__ */ new Map();
var logs = /* @__PURE__ */ new Map();
var ws = null;
var reconnectTimer = null;
var tvUrl = "about:blank";
var tvProxyUrl = "about:blank";
var tvHistory = [tvUrl];
var tvHistoryIndex = 0;
var commandHistory = /* @__PURE__ */ new Map();
var historyIndex = /* @__PURE__ */ new Map();
var priorities = [
  {
    id: "1",
    title: "Dashboard Enhancements",
    status: "active",
    progress: 65,
    details: "Adding priority tracking system with hover details, compact UI design"
  },
  {
    id: "2",
    title: "Worker Optimization",
    status: "pending",
    progress: 20,
    details: "Improve worker task allocation and load balancing across repos"
  },
  {
    id: "3",
    title: "Error Recovery",
    status: "blocked",
    progress: 10,
    details: "Implement automatic retry logic for failed tasks. Blocked on logging infrastructure."
  },
  {
    id: "4",
    title: "Live Page Performance",
    status: "active",
    progress: 45,
    details: "Optimize iframe loading and skyeyes execution speed"
  },
  {
    id: "5",
    title: "Cost Monitoring",
    status: "pending",
    progress: 5,
    details: "Add budget alerts and detailed cost breakdown per worker"
  }
];
var statusColors = {
  idle: "#3fb950",
  working: "#d29922",
  error: "#f85149",
  interrupted: "#bc8cff",
  starting: "#58a6ff"
};
function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}`);
  ws.onopen = () => {
    const dot = document.getElementById("connection-status");
    dot.className = "connected";
    dot.title = "Connected";
    fetch("/api/workers").then((r) => r.json()).then((data) => {
      data.forEach((w) => {
        workers.set(w.id, w);
        logs.set(w.id, w.outputLog || []);
      });
      renderAll();
    });
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
        msg.workers.forEach((w) => {
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
    const dot = document.getElementById("connection-status");
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
  }, 2e3);
}
function wsSend(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}
function renderAll() {
  renderPriorities();
  const grid = document.getElementById("worker-grid");
  grid.innerHTML = "";
  for (const [id] of workers) {
    renderWorkerCard(id);
  }
  renderLivePages();
  renderTV();
}
function renderPriorities() {
  const section = document.getElementById("priorities-section");
  const statusIcons = {
    active: "\u26A1",
    pending: "\u25CB",
    blocked: "\u23F8",
    completed: "\u2713"
  };
  const statusColors2 = {
    active: "var(--orange)",
    pending: "var(--text-muted)",
    blocked: "var(--red)",
    completed: "var(--green)"
  };
  const html = `
    <div class="priorities-header">
      <span class="priorities-title">Top Priorities</span>
    </div>
    <div class="priorities-list">
      ${priorities.map(
    (p) => `
        <div class="priority-item" data-status="${p.status}">
          <div class="priority-compact">
            <span class="priority-icon" style="color: ${statusColors2[p.status]}">${statusIcons[p.status]}</span>
            <span class="priority-title-text">${escapeHtml(p.title)}</span>
            <span class="priority-progress-badge">${p.progress}%</span>
          </div>
          <div class="priority-hover-details">
            <div class="priority-details-header">
              <strong>${escapeHtml(p.title)}</strong>
              <span class="priority-status-label">${p.status}</span>
            </div>
            <div class="priority-progress-bar">
              <div class="priority-progress-fill" style="width: ${p.progress}%; background: ${statusColors2[p.status]}"></div>
            </div>
            <div class="priority-details-text">${escapeHtml(p.details)}</div>
          </div>
        </div>
      `
  ).join("")}
    </div>
  `;
  section.innerHTML = html;
}
function renderWorkerCard(id) {
  const w = workers.get(id);
  if (!w) return;
  let card = document.getElementById(`worker-${id}`);
  if (!card) {
    card = document.createElement("div");
    card.id = `worker-${id}`;
    card.className = "worker-card";
    document.getElementById("worker-grid").appendChild(card);
  }
  const existingTextarea = document.getElementById(`input-${id}`);
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
        <h2 onclick="toggleModelDropdown('${id}')" style="cursor:pointer">${w.repoName} \u25BE</h2>
        <div class="model-dropdown" id="model-dropdown-${id}" style="display:none">
          <label><input type="radio" name="model-${id}" value="sonnet" ${currentModel === "sonnet" ? "checked" : ""} onchange="changeModel('${id}', 'sonnet')"> Sonnet</label>
          <label><input type="radio" name="model-${id}" value="opus" ${currentModel === "opus" ? "checked" : ""} onchange="changeModel('${id}', 'opus')"> Opus</label>
          <label><input type="radio" name="model-${id}" value="haiku" ${currentModel === "haiku" ? "checked" : ""} onchange="changeModel('${id}', 'haiku')"> Haiku</label>
        </div>
      </div>
      <a href="${githubUrl}" target="_blank" class="github-link" title="Open in GitHub">\u{1F517}</a>
      <button class="btn-icon" onclick="loadToTV('${githubUrl}')" title="Load to TV">\u{1F4FA}</button>
      <span class="status-label">${w.status}</span>
    </div>
    ${w.currentTask ? `<div class="current-task">${escapeHtml(w.currentTask)}</div>` : ""}
    <div class="card-meta">
      <span>$${w.costUsd.toFixed(4)}</span>
      <span>${w.turnsCompleted} turns</span>
      <span class="model-badge">${currentModel}</span>
      ${w.lastError ? `<span style="color:var(--red)">err</span>` : ""}
    </div>
    <div class="log-container" id="log-${id}">${renderLogEntries(wLogs.slice(-50))}</div>
    ${w.issues && w.issues.length > 0 ? renderIssuesSection(w.issues, id) : ""}
    <div class="card-input">
      <textarea id="input-${id}" placeholder="Message ${w.repoName}..." onkeydown="handleWorkerKey(event, '${id}')"></textarea>
      <button class="btn btn-sm" onclick="sendToWorker('${id}')">Send</button>
      <button class="btn btn-sm btn-danger" onclick="interruptWorker('${id}')">Stop</button>
    </div>
  `;
  const logEl = document.getElementById(`log-${id}`);
  if (logEl) logEl.scrollTop = logEl.scrollHeight;
  if (preservedValue) {
    const textarea = document.getElementById(`input-${id}`);
    if (textarea) {
      textarea.value = preservedValue;
    }
  }
}
function renderLogEntries(entries) {
  return entries.map(
    (e) => `<div class="log-entry ${e.type}">${e.toolName ? `[${e.toolName}] ` : ""}${escapeHtml(e.content.substring(0, 500))}</div>`
  ).join("");
}
function renderIssuesSection(issues, workerId) {
  const sortedIssues = [...issues].sort(
    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
  );
  return `
    <div class="issues-section">
      <div class="issues-header">
        <span>Issues (${issues.length})</span>
      </div>
      <div class="issues-list">
        ${sortedIssues.map(
    (issue) => `
          <div class="issue-item" data-state="${issue.state}" onclick="loadToTV('${issue.html_url}')">
            <div class="issue-number-state">
              <span class="issue-number">#${issue.number}</span>
              <span class="issue-state ${issue.state}">${issue.state === "open" ? "\u25CF" : "\u2713"}</span>
            </div>
            <div class="issue-title">${escapeHtml(issue.title)}</div>
            <div class="issue-meta">
              ${issue.comments > 0 ? `<span class="issue-comments">\u{1F4AC} ${issue.comments}</span>` : ""}
              ${issue.labels.slice(0, 2).map((label) => `<span class="issue-label" style="background:#${label.color}">${escapeHtml(label.name)}</span>`).join("")}
            </div>
          </div>
        `
  ).join("")}
      </div>
    </div>
  `;
}
function appendLogEntry(workerId, entry) {
  const logEl = document.getElementById(`log-${workerId}`);
  if (!logEl) return;
  const div = document.createElement("div");
  div.className = `log-entry ${entry.type}`;
  div.textContent = (entry.toolName ? `[${entry.toolName}] ` : "") + entry.content.substring(0, 500);
  logEl.appendChild(div);
  while (logEl.children.length > 100) {
    logEl.removeChild(logEl.firstChild);
  }
  logEl.scrollTop = logEl.scrollHeight;
  const w = workers.get(workerId);
  if (w) {
    const card = document.getElementById(`worker-${workerId}`);
    if (card) card.setAttribute("data-status", w.status);
  }
}
function renderLivePages() {
  const grid = document.getElementById("live-grid");
  grid.innerHTML = "";
  for (const [, w] of workers) {
    if (!w.liveUrl) continue;
    const card = document.createElement("div");
    card.className = "live-card";
    card.id = `live-${w.id}`;
    card.innerHTML = `
      <h3>
        <span>${w.repoName} (live)</span>
        <button class="btn btn-sm" onclick="reloadIframe('${w.id}')">Reload</button>
      </h3>
      <iframe src="/live/${w.id}" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>
      <div class="live-exec">
        <input id="exec-${w.id}" placeholder="Execute JS in ${w.repoName}..." onkeydown="handleExecKey(event, '${w.id}')">
        <button class="btn btn-sm" onclick="execSkyeyes('${w.id}')">Run</button>
      </div>
      <div class="live-result" id="result-${w.id}"></div>
    `;
    grid.appendChild(card);
  }
}
function sendToWorker(id) {
  const textarea = document.getElementById(`input-${id}`);
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
function interruptWorker(id) {
  wsSend({ type: "interrupt_worker", workerId: id });
}
function handleWorkerKey(event, id) {
  const textarea = event.target;
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
  const textarea = document.getElementById("orchestrator-msg");
  const message = textarea.value.trim();
  if (!message) return;
  for (const [id] of workers) {
    wsSend({ type: "send_to_worker", workerId: id, message });
  }
  textarea.value = "";
}
function execSkyeyes(page) {
  const input = document.getElementById(`exec-${page}`);
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
function handleExecKey(event, page) {
  if (event.key === "Enter") {
    event.preventDefault();
    execSkyeyes(page);
  }
}
function showSkyeyesResult(page, result, error) {
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
function appendLiveConsole(page, level, args) {
  const resultEl = document.getElementById(`result-${page}`);
  if (!resultEl) return;
  const line = `[${level}] ${args.join(" ")}`;
  resultEl.textContent = line;
  if (level === "error") {
    resultEl.className = "live-result error";
  }
}
function reloadIframe(id) {
  const card = document.getElementById(`live-${id}`);
  if (!card) return;
  const iframe = card.querySelector("iframe");
  if (iframe) iframe.src = iframe.src;
}
function renderTV() {
  const section = document.getElementById("tv-section");
  if (!section) return;
  const isBlank = tvUrl === "about:blank";
  section.innerHTML = `
    <div class="tv-header">
      <span class="tv-title">Shared TV</span>
      <div class="tv-controls">
        <button class="btn-icon" onclick="tvBack()" ${tvHistoryIndex === 0 ? "disabled" : ""}>\u2190</button>
        <button class="btn-icon" onclick="tvForward()" ${tvHistoryIndex === tvHistory.length - 1 ? "disabled" : ""}>\u2192</button>
        <input type="text" id="tv-url-bar" value="${isBlank ? "" : escapeHtml(tvUrl)}" onkeydown="handleTVUrlKey(event)" placeholder="Enter URL or click \u{1F4FA} on a worker...">
        <button class="btn btn-sm" onclick="tvGo()">Go</button>
        <button class="btn btn-sm" onclick="tvReload()" ${isBlank ? "disabled" : ""}>\u21BB</button>
      </div>
    </div>
    ${isBlank ? `
      <div class="tv-placeholder">
        <div class="tv-placeholder-content">
          <h3>Shared TV</h3>
          <p>Click the TV button on any worker to load content here</p>
          <p>Any URL will be proxied through the server to bypass iframe restrictions</p>
        </div>
      </div>
    ` : `
      <iframe id="tv-iframe" src="${escapeHtml(tvProxyUrl)}" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"></iframe>
    `}
  `;
}
function loadToTV(url) {
  const proxyUrl = `/proxy?url=${encodeURIComponent(url)}`;
  tvUrl = url;
  tvProxyUrl = proxyUrl;
  if (tvHistoryIndex < tvHistory.length - 1) {
    tvHistory = tvHistory.slice(0, tvHistoryIndex + 1);
  }
  tvHistory.push(url);
  tvHistoryIndex = tvHistory.length - 1;
  renderTV();
}
function tvBack() {
  if (tvHistoryIndex > 0) {
    tvHistoryIndex--;
    tvUrl = tvHistory[tvHistoryIndex];
    tvProxyUrl = tvUrl === "about:blank" ? "about:blank" : `/proxy?url=${encodeURIComponent(tvUrl)}`;
    renderTV();
  }
}
function tvForward() {
  if (tvHistoryIndex < tvHistory.length - 1) {
    tvHistoryIndex++;
    tvUrl = tvHistory[tvHistoryIndex];
    tvProxyUrl = tvUrl === "about:blank" ? "about:blank" : `/proxy?url=${encodeURIComponent(tvUrl)}`;
    renderTV();
  }
}
function tvGo() {
  const input = document.getElementById("tv-url-bar");
  let url = input.value.trim();
  if (!url) return;
  if (!url.match(/^https?:\/\//)) {
    url = "https://" + url;
  }
  loadToTV(url);
}
function tvReload() {
  const iframe = document.getElementById("tv-iframe");
  if (iframe) iframe.src = iframe.src;
}
function handleTVUrlKey(event) {
  if (event.key === "Enter") {
    event.preventDefault();
    tvGo();
  }
}
function toggleModelDropdown(workerId) {
  const dropdown = document.getElementById(`model-dropdown-${workerId}`);
  if (!dropdown) return;
  document.querySelectorAll(".model-dropdown").forEach((d) => {
    if (d.id !== `model-dropdown-${workerId}`) {
      d.style.display = "none";
    }
  });
  dropdown.style.display = dropdown.style.display === "none" ? "block" : "none";
}
function changeModel(workerId, model) {
  wsSend({ type: "change_model", workerId, model });
  const worker = workers.get(workerId);
  if (worker) {
    worker.model = model;
    const badge = document.querySelector(`#worker-${workerId} .model-badge`);
    if (badge) {
      badge.textContent = model;
    }
    const dropdown = document.getElementById(`model-dropdown-${workerId}`);
    if (dropdown) {
      dropdown.style.display = "none";
    }
  }
}
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
window.sendToWorker = sendToWorker;
window.interruptWorker = interruptWorker;
window.broadcastMessage = broadcastMessage;
window.execSkyeyes = execSkyeyes;
window.handleWorkerKey = handleWorkerKey;
window.handleExecKey = handleExecKey;
window.reloadIframe = reloadIframe;
window.loadToTV = loadToTV;
window.tvBack = tvBack;
window.tvForward = tvForward;
window.tvGo = tvGo;
window.tvReload = tvReload;
window.handleTVUrlKey = handleTVUrlKey;
window.toggleModelDropdown = toggleModelDropdown;
window.changeModel = changeModel;
window.loadToTV = loadToTV;
window.tvBack = tvBack;
window.tvForward = tvForward;
window.tvGo = tvGo;
window.tvReload = tvReload;
window.handleTVUrlKey = handleTVUrlKey;
window.toggleModelDropdown = toggleModelDropdown;
window.changeModel = changeModel;
var STORAGE_KEY = "nimbus-drafts";
function saveDraft(id, value) {
  try {
    const drafts = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (value) {
      drafts[id] = value;
    } else {
      delete drafts[id];
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
  } catch {
  }
}
function loadDraft(id) {
  try {
    const drafts = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return drafts[id] || "";
  } catch {
    return "";
  }
}
function attachDraftListeners() {
  for (const [id] of workers) {
    const textarea = document.getElementById(`input-${id}`);
    if (textarea && !textarea.dataset.draftBound) {
      textarea.dataset.draftBound = "1";
      textarea.addEventListener("input", () => saveDraft(`input-${id}`, textarea.value));
      const saved = loadDraft(`input-${id}`);
      if (saved && !textarea.value) textarea.value = saved;
    }
  }
  const orch = document.getElementById("orchestrator-msg");
  if (orch && !orch.dataset.draftBound) {
    orch.dataset.draftBound = "1";
    orch.addEventListener("input", () => saveDraft("orchestrator-msg", orch.value));
    const saved = loadDraft("orchestrator-msg");
    if (saved && !orch.value) orch.value = saved;
  }
  for (const [, w] of workers) {
    if (!w.liveUrl) continue;
    const input = document.getElementById(`exec-${w.id}`);
    if (input && !input.dataset.draftBound) {
      input.dataset.draftBound = "1";
      input.addEventListener("input", () => saveDraft(`exec-${w.id}`, input.value));
      const saved = loadDraft(`exec-${w.id}`);
      if (saved && !input.value) input.value = saved;
    }
  }
  const tvBar = document.getElementById("tv-url-bar");
  if (tvBar && !tvBar.dataset.draftBound) {
    tvBar.dataset.draftBound = "1";
    tvBar.addEventListener("input", () => saveDraft("tv-url-bar", tvBar.value));
  }
}
var _origRenderAll = renderAll;
window._renderAll = renderAll;
function patchedRenderAll() {
  _origRenderAll();
  setTimeout(attachDraftListeners, 0);
}
renderAll = patchedRenderAll;
var _origSendToWorker = sendToWorker;
window.sendToWorker = function(id) {
  _origSendToWorker(id);
  saveDraft(`input-${id}`, "");
};
var _origBroadcastMessage = broadcastMessage;
window.broadcastMessage = function() {
  _origBroadcastMessage();
  saveDraft("orchestrator-msg", "");
};
connect();
setTimeout(attachDraftListeners, 500);
