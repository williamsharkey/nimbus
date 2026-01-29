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
  const { page } = req.params;
  const worker = manager.getWorker(page);
  if (!worker || !worker.state.liveUrl) {
    return res.status(404).send(`No live URL configured for ${page}`);
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
      const skyeyesScript = `<script src="${skyeyesUrl}" data-page="${page}"></script>`;
      if (html.includes("</body>")) {
        html = html.replace("</body>", `${skyeyesScript}\n</body>`);
      } else {
        html += skyeyesScript;
      }

      if (isLocalDev) {
        // Local dev server (e.g. Vite): inject a <base> tag so all relative URLs
        // resolve against the dev server directly. Don't rewrite URLs — the dev
        // server handles module transforms, HMR, etc.
        const baseTag = `<base href="${liveUrl}">`;
        if (html.includes("<head>")) {
          html = html.replace("<head>", `<head>${baseTag}`);
        } else {
          html = baseTag + html;
        }
      } else {
        // GitHub Pages / static hosting: rewrite URLs to go through the proxy
        // Match src/href attributes with relative or absolute paths (but not external URLs or already proxied)
        html = html.replace(/(href|src)="(?!https?:\/\/|\/\/|\/live\/|\/skyeyes)([^"]*?)"/g, (match, attr, url) => {
          // Remove leading slash if present to normalize
          let cleanUrl = url.startsWith('/') ? url.substring(1) : url;
          // If the URL starts with the page name (e.g., "shiro/assets/..."), strip that too
          // This handles GitHub Pages URLs like "/shiro/assets/..." -> "assets/..."
          if (cleanUrl.startsWith(`${page}/`)) {
            cleanUrl = cleanUrl.substring(page.length + 1);
          }
          return `${attr}="/live/${page}/${cleanUrl}"`;
        });

        // Rewrite ES module imports (e.g., import VFS from './src/vfs.js')
        html = html.replace(/from\s+['"](?!https?:\/\/|\/\/|\/live\/)([^'"]+)['"]/g, (match, url) => {
          let cleanUrl = url.startsWith('/') ? url.substring(1) : url;
          if (cleanUrl.startsWith(`${page}/`)) {
            cleanUrl = cleanUrl.substring(page.length + 1);
          }
          // Resolve relative paths (./foo.js) to absolute proxy paths
          if (cleanUrl.startsWith('./')) {
            cleanUrl = cleanUrl.substring(2);
          }
          return `from '/live/${page}/${cleanUrl}'`;
        });

        // Rewrite side-effect imports (e.g., import './src/devtools.js')
        html = html.replace(/import\s+['"](?!https?:\/\/|\/\/|\/live\/)([^'"]+)['"]/g, (match, url) => {
          let cleanUrl = url.startsWith('/') ? url.substring(1) : url;
          if (cleanUrl.startsWith(`${page}/`)) {
            cleanUrl = cleanUrl.substring(page.length + 1);
          }
          if (cleanUrl.startsWith('./')) {
            cleanUrl = cleanUrl.substring(2);
          }
          return `import '/live/${page}/${cleanUrl}'`;
        });
      }

      res.type("html").send(html);
    } else if (!isLocalDev && (contentType.includes("javascript") || contentType.includes("application/javascript") || targetUrl.endsWith('.js'))) {
      // Rewrite JavaScript module imports (only for static hosting, not local dev servers)
      let js = await response.text();

      // Helper function to resolve relative paths
      const resolveRelativePath = (url: string): string => {
        let cleanUrl = url.startsWith('/') ? url.substring(1) : url;
        if (cleanUrl.startsWith(`${page}/`)) {
          cleanUrl = cleanUrl.substring(page.length + 1);
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
        return `from '/live/${page}/${cleanUrl}'`;
      });

      // Rewrite side-effect imports
      js = js.replace(/import\s+['"](?!https?:\/\/|\/\/|\/live\/)([^'"]+)['"]/g, (match, url) => {
        const cleanUrl = resolveRelativePath(url);
        return `import '/live/${page}/${cleanUrl}'`;
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
