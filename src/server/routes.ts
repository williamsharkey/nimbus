import type { Express } from "express";
import express from "express";
import type { WorkerManager } from "../workers/WorkerManager.js";
import type { WsHub } from "./ws.js";
import type { SkyeyesCommand } from "../workers/types.js";
import { randomUUID } from "crypto";

export function setupRoutes(app: Express, manager: WorkerManager, wsHub: WsHub, port: number = 7777): void {
  app.use(express.json());

  // --- Worker endpoints ---

  app.get("/api/workers", (_req, res) => {
    res.json(manager.getAllStates());
  });

  app.get("/api/workers/:id", (req, res) => {
    const w = manager.getWorker(req.params.id);
    if (!w) return res.status(404).json({ error: "Worker not found" });
    res.json(w.state);
  });

  app.post("/api/workers/:id/send", (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: "message required" });
    const ok = manager.sendToWorker(req.params.id, message);
    res.json({ success: ok });
  });

  app.post("/api/workers/:id/interrupt", async (req, res) => {
    const ok = await manager.interruptWorker(req.params.id);
    res.json({ success: ok });
  });

  app.post("/api/workers/:id/restart", async (req, res) => {
    const ok = await manager.restartWorker(req.params.id);
    res.json({ success: ok });
  });

  // --- Skyeyes endpoints ---

  app.post("/api/skyeyes/:page/exec", async (req, res) => {
    const { page } = req.params;
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: "code required" });

    const id = randomUUID();
    const cmd: SkyeyesCommand = { type: "eval", id, code };
    const sent = wsHub.sendToSkyeyes(page, cmd);
    if (!sent) {
      return res.status(503).json({ error: `Skyeyes bridge not connected for page: ${page}` });
    }

    try {
      const result = await wsHub.waitForSkyeyesResult(page, id);
      res.json(result);
    } catch (err: any) {
      res.status(504).json({ error: err.message });
    }
  });

  // --- Skyeyes convenience endpoints ---
  // GET-based eval: simpler for workers using curl (no JSON escaping needed)
  // Usage: curl 'localhost:7777/api/skyeyes/shiro/eval?code=document.title'
  app.get("/api/skyeyes/:page/eval", async (req, res) => {
    const { page } = req.params;
    const code = req.query.code as string;
    if (!code) return res.status(400).json({ error: "code query parameter required" });

    const id = randomUUID();
    const cmd: SkyeyesCommand = { type: "eval", id, code };
    const sent = wsHub.sendToSkyeyes(page, cmd);
    if (!sent) {
      return res.status(503).json({ error: `Skyeyes bridge not connected for page: ${page}` });
    }

    try {
      const result = await wsHub.waitForSkyeyesResult(page, id);
      // Return plain text by default for easy shell consumption, JSON if ?json=1
      if (req.query.json) {
        res.json(result);
      } else {
        if (result.error) {
          res.status(500).type("text").send(`Error: ${result.error}`);
        } else {
          res.type("text").send(typeof result.result === "string" ? result.result : JSON.stringify(result.result));
        }
      }
    } catch (err: any) {
      res.status(504).type("text").send(`Timeout: ${err.message}`);
    }
  });

  // Reload an iframe's live page
  // Usage: curl -X POST localhost:7777/api/skyeyes/shiro/reload
  app.post("/api/skyeyes/:page/reload", async (req, res) => {
    const { page } = req.params;
    // Execute a reload via skyeyes
    const id = randomUUID();
    const cmd: SkyeyesCommand = { type: "eval", id, code: "location.reload(); 'reloading'" };
    const sent = wsHub.sendToSkyeyes(page, cmd);
    if (!sent) {
      return res.status(503).json({ error: `Skyeyes bridge not connected for page: ${page}` });
    }
    // Don't wait for result since reload kills the page
    res.json({ success: true, message: `Reload triggered for ${page}` });
  });

  // Check skyeyes connection status for all pages
  app.get("/api/skyeyes/status", (_req, res) => {
    res.json(wsHub.getSkyeyesStatus());
  });

  // --- Activity feed ---

  const REPOS = ["shiro", "foam", "windwalker", "spirit", "fluffycoreutils", "nimbus", "skyeyes"];
  const GH_USER = "williamsharkey";
  let activityCache: { data: any[]; ts: number } = { data: [], ts: 0 };
  const ACTIVITY_TTL = 30_000; // 30s cache

  app.get("/api/activity", async (_req, res) => {
    const now = Date.now();
    if (now - activityCache.ts < ACTIVITY_TTL && activityCache.data.length > 0) {
      return res.json(activityCache.data);
    }

    try {
      const { execSync } = await import("child_process");
      const items: any[] = [];

      for (const repo of REPOS) {
        const fullRepo = `${GH_USER}/${repo}`;

        // Fetch issues (open + recently closed)
        try {
          const issuesJson = execSync(
            `gh issue list --repo ${fullRepo} --state all --limit 10 --json number,title,state,updatedAt,createdAt,url,labels,comments`,
            { encoding: "utf-8", timeout: 10000 },
          );
          const issues = JSON.parse(issuesJson);
          for (const issue of issues) {
            items.push({
              type: "issue",
              repo,
              number: issue.number,
              title: issue.title,
              state: issue.state,
              time: issue.updatedAt || issue.createdAt,
              url: issue.url,
              labels: (issue.labels || []).map((l: any) => l.name),
              comments: issue.comments?.length || 0,
            });
          }
        } catch {}

        // Fetch recent pushes (commits on default branch)
        try {
          const commitsJson = execSync(
            `gh api repos/${fullRepo}/commits?per_page=5 --jq '[.[] | {sha: .sha, message: .commit.message, time: .commit.committer.date, author: .commit.author.name, url: .html_url}]'`,
            { encoding: "utf-8", timeout: 10000 },
          );
          const commits = JSON.parse(commitsJson);
          for (const c of commits) {
            items.push({
              type: "push",
              repo,
              sha: c.sha?.substring(0, 7),
              title: c.message?.split("\n")[0]?.substring(0, 120),
              time: c.time,
              url: c.url,
              author: c.author,
            });
          }
        } catch {}
      }

      // Sort newest first
      items.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
      activityCache = { data: items, ts: now };
      res.json(items);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- GitHub Pages proxy ---

  app.get("/live/:page/*", async (req, res) => {
    await proxyGitHubPages(req, res, manager, port);
  });

  app.get("/live/:page", async (req, res) => {
    await proxyGitHubPages(req, res, manager, port);
  });

  // --- Generic URL proxy for Shared TV ---
  // Proxies any external URL so it can be loaded in an iframe
  app.get("/proxy", async (req, res) => {
    const url = req.query.url as string;
    if (!url) return res.status(400).send("url query parameter required");

    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Nimbus Dashboard Proxy)" },
        redirect: "follow",
      });
      const contentType = response.headers.get("content-type") || "";

      if (contentType.includes("text/html")) {
        let html = await response.text();
        // Resolve the base URL for rewriting relative links
        const parsed = new URL(url);
        const base = `${parsed.origin}`;

        // Inject a <base> tag so relative URLs resolve against the original host
        // and rewrite links to go through the proxy
        const baseTag = `<base href="${base}/">`;
        if (html.includes("<head>")) {
          html = html.replace("<head>", `<head>${baseTag}`);
        } else if (html.includes("<HEAD>")) {
          html = html.replace("<HEAD>", `<HEAD>${baseTag}`);
        } else {
          html = baseTag + html;
        }

        // Remove X-Frame-Options / CSP frame-ancestors by serving from our origin
        res.removeHeader("X-Frame-Options");
        res.removeHeader("Content-Security-Policy");
        res.type("html").send(html);
      } else {
        const buffer = await response.arrayBuffer();
        res.type(contentType).send(Buffer.from(buffer));
      }
    } catch (err: any) {
      res.status(502).send(`Proxy error: ${err.message}`);
    }
  });
}

async function proxyGitHubPages(req: any, res: any, manager: WorkerManager, port: number): Promise<void> {
  const rawPage: string = req.params.page;

  // Support per-worker page IDs: "shiro-spirit" → base page "shiro", skyeyes page ID "shiro-spirit"
  // Try the raw page first, then strip the last dash-segment to find the base page
  let basePage = rawPage;
  let skyeyesPageId = rawPage;
  let worker = manager.getWorker(rawPage);

  if (!worker || !worker.state.liveUrl) {
    // Try stripping worker suffix: "shiro-spirit" → look for "shiro" worker's liveUrl
    const dashIdx = rawPage.indexOf("-");
    if (dashIdx !== -1) {
      basePage = rawPage.substring(0, dashIdx);
      // Find any worker that has liveUrl matching this base page
      const allStates = manager.getAllStates();
      const match = allStates.find(s => s.id === basePage && s.liveUrl);
      if (match) {
        worker = manager.getWorker(basePage)!;
      }
    }
    if (!worker || !worker.state.liveUrl) {
      return res.status(404).send(`No live URL configured for ${rawPage}`);
    }
  }

  const liveUrl = worker.state.liveUrl;
  const isLocalDev = liveUrl.startsWith("http://localhost") || liveUrl.startsWith("http://127.0.0.1");
  const subPath = req.params[0] || "";
  const targetUrl = liveUrl + subPath;

  try {
    const response = await fetch(targetUrl);
    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("text/html")) {
      let html = await response.text();
      // Inject skyeyes.js before </body>
      // Use absolute URL so it resolves against nimbus server, not the <base> tag
      const skyeyesUrl = isLocalDev ? `http://localhost:${port}/skyeyes.js` : "/skyeyes.js";
      const skyeyesScript = `<script src="${skyeyesUrl}" data-page="${skyeyesPageId}"></script>`;
      if (html.includes("</body>")) {
        html = html.replace("</body>", `${skyeyesScript}\n</body>`);
      } else {
        html += skyeyesScript;
      }

      if (isLocalDev) {
        // Local dev server (e.g. Vite): inject a <base> tag so all relative URLs
        // resolve against the dev server directly.
        const baseTag = `<base href="${liveUrl}">`;
        if (html.includes("<head>")) {
          html = html.replace("<head>", `<head>${baseTag}`);
        } else {
          html = baseTag + html;
        }

        // IMPORTANT: Inline <script type="module"> doesn't respect <base> tag!
        // Rewrite inline module imports to go through nimbus proxy to avoid CORS issues
        // Match imports inside <script type="module"> tags
        html = html.replace(/(<script[^>]*type=["']module["'][^>]*>)([\s\S]*?)(<\/script>)/gi, (match, openTag, scriptContent, closeTag) => {
          // Rewrite "from" imports to use nimbus proxy paths
          let rewritten = scriptContent.replace(/from\s+['"](?!https?:\/\/|\/\/|\/live\/)([^'"]+)['"]/g, (m: string, url: string) => {
            // Convert relative paths to nimbus proxy URLs to keep same-origin
            let cleanUrl = url.startsWith('./') ? url.substring(2) : (url.startsWith('/') ? url.substring(1) : url);
            return `from '/live/${rawPage}/${cleanUrl}'`;
          });
          // Rewrite side-effect imports to use nimbus proxy paths
          rewritten = rewritten.replace(/import\s+['"](?!https?:\/\/|\/\/|\/live\/)([^'"]+)['"]/g, (m: string, url: string) => {
            let cleanUrl = url.startsWith('./') ? url.substring(2) : (url.startsWith('/') ? url.substring(1) : url);
            return `import '/live/${rawPage}/${cleanUrl}'`;
          });
          return openTag + rewritten + closeTag;
        });
      } else {
        // GitHub Pages / static hosting: rewrite URLs to go through the proxy
        // Match src/href attributes with relative or absolute paths (but not external URLs or already proxied)
        html = html.replace(/(href|src)="(?!https?:\/\/|\/\/|\/live\/|\/skyeyes)([^"]*?)"/g, (match, attr, url) => {
          // Remove leading slash if present to normalize
          let cleanUrl = url.startsWith('/') ? url.substring(1) : url;
          // If the URL starts with the page name (e.g., "shiro/assets/..."), strip that too
          // This handles GitHub Pages URLs like "/shiro/assets/..." -> "assets/..."
          if (cleanUrl.startsWith(`${basePage}/`)) {
            cleanUrl = cleanUrl.substring(basePage.length + 1);
          }
          return `${attr}="/live/${rawPage}/${cleanUrl}"`;
        });

        // Rewrite ES module imports (e.g., import VFS from './src/vfs.js')
        html = html.replace(/from\s+['"](?!https?:\/\/|\/\/|\/live\/)([^'"]+)['"]/g, (match, url) => {
          let cleanUrl = url.startsWith('/') ? url.substring(1) : url;
          if (cleanUrl.startsWith(`${basePage}/`)) {
            cleanUrl = cleanUrl.substring(basePage.length + 1);
          }
          // Resolve relative paths (./foo.js) to absolute proxy paths
          if (cleanUrl.startsWith('./')) {
            cleanUrl = cleanUrl.substring(2);
          }
          return `from '/live/${rawPage}/${cleanUrl}'`;
        });

        // Rewrite side-effect imports (e.g., import './src/devtools.js')
        html = html.replace(/import\s+['"](?!https?:\/\/|\/\/|\/live\/)([^'"]+)['"]/g, (match, url) => {
          let cleanUrl = url.startsWith('/') ? url.substring(1) : url;
          if (cleanUrl.startsWith(`${basePage}/`)) {
            cleanUrl = cleanUrl.substring(basePage.length + 1);
          }
          if (cleanUrl.startsWith('./')) {
            cleanUrl = cleanUrl.substring(2);
          }
          return `import '/live/${rawPage}/${cleanUrl}'`;
        });
      }

      res.type("html").send(html);
    } else if (contentType.includes("javascript") || contentType.includes("application/javascript") || targetUrl.endsWith('.js')) {
      // Rewrite JavaScript module imports to go through nimbus proxy
      let js = await response.text();

      // Helper function to resolve relative paths
      const resolveRelativePath = (url: string): string => {
        let cleanUrl = url.startsWith('/') ? url.substring(1) : url;
        if (cleanUrl.startsWith(`${basePage}/`)) {
          cleanUrl = cleanUrl.substring(basePage.length + 1);
        }
        // Resolve relative paths
        if (cleanUrl.startsWith('./')) {
          // Get the current path from targetUrl
          const currentPath = targetUrl.replace(worker.state.liveUrl || '', '').split('/').slice(0, -1).join('/');
          cleanUrl = currentPath ? `${currentPath}/${cleanUrl.substring(2)}` : cleanUrl.substring(2);
        } else if (cleanUrl.startsWith('../')) {
          // Handle parent directory references
          const currentPath = targetUrl.replace(worker.state.liveUrl || '', '').split('/').slice(0, -1);
          let pathToResolve = cleanUrl;
          while (pathToResolve.startsWith('../')) {
            currentPath.pop();
            pathToResolve = pathToResolve.substring(3);
          }
          cleanUrl = currentPath.length > 0 ? `${currentPath.join('/')}/${pathToResolve}` : pathToResolve;
        }
        return cleanUrl;
      };

      // Rewrite "from" imports
      js = js.replace(/from\s+['"](?!https?:\/\/|\/\/|\/live\/)([^'"]+)['"]/g, (match, url) => {
        const cleanUrl = resolveRelativePath(url);
        return `from '/live/${rawPage}/${cleanUrl}'`;
      });

      // Rewrite side-effect imports
      js = js.replace(/import\s+['"](?!https?:\/\/|\/\/|\/live\/)([^'"]+)['"]/g, (match, url) => {
        const cleanUrl = resolveRelativePath(url);
        return `import '/live/${rawPage}/${cleanUrl}'`;
      });

      res.type("application/javascript").send(js);
    } else {
      // Pass through binary/other content
      const buffer = await response.arrayBuffer();
      res.type(contentType).send(Buffer.from(buffer));
    }
  } catch (err: any) {
    res.status(502).send(`Failed to proxy ${targetUrl}: ${err.message}`);
  }
}
