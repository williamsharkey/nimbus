import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// JS code templates for terminal operations.
// These get eval'd inside the browser page via skyeyes.
// They auto-detect whether the page is Shiro or Foam.

function terminalExecCode(command: string): string {
  const escaped = JSON.stringify(command);
  return `return (async () => {
  const cmd = ${escaped};
  if (window.__shiro) {
    // Echo command in terminal so it's visible
    const term = window.__shiro.terminal.term;
    const cwd = window.__shiro.shell.cwd || '/';
    const displayCwd = cwd === '/home/user' ? '~' : cwd.replace('/home/user/', '~/');
    term.writeln('\\x1b[90m[skyeyes]\\x1b[0m \\x1b[32muser@shiro\\x1b[0m:\\x1b[34m' + displayCwd + '\\x1b[0m$ ' + cmd);
    let stdout = '', stderr = '';
    const exitCode = await window.__shiro.shell.execute(cmd, s => { stdout += s; term.write(s); }, s => { stderr += s; term.write('\\x1b[31m' + s + '\\x1b[0m'); });
    term.writeln('');
    return JSON.stringify({ stdout, stderr, exitCode });
  } else if (window.__foam) {
    // Echo command in terminal so it's visible
    const t = window.__foam.terminal;
    const cwd = window.__foam.vfs?.cwd || '/';
    t.write('\\x1b[90m[skyeyes]\\x1b[0m ' + t.promptStr + cmd + '\\n');
    const r = await window.__foam.shell.exec(cmd);
    if (r.stdout) t.write(r.stdout + (r.stdout.endsWith('\\n') ? '' : '\\n'));
    if (r.stderr) t.writeError(r.stderr + (r.stderr.endsWith('\\n') ? '' : '\\n'));
    return JSON.stringify(r);
  }
  return JSON.stringify({ error: 'No OS detected (no __shiro or __foam global)' });
})()`;
}

function terminalReadCode(): string {
  return `return (() => {
  if (window.__shiro) {
    const term = window.__shiro.terminal.term;
    const buf = term.buffer.active;
    let lines = [];
    for (let y = 0; y < term.rows; y++) {
      const line = buf.getLine(y);
      if (line) lines.push(line.translateToString().trimEnd());
    }
    // Trim trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\\n');
  } else if (window.__foam) {
    return window.__foam.terminal.output.textContent || '';
  }
  return 'No OS detected';
})()`;
}

function terminalStatusCode(): string {
  return `return (() => {
  if (window.__shiro) {
    return JSON.stringify({
      busy: !!window.__shiro.terminal.running,
      cwd: window.__shiro.shell.cwd || '/',
      os: 'shiro'
    });
  } else if (window.__foam) {
    return JSON.stringify({
      busy: !!window.__foam.terminal.busy,
      cwd: window.__foam.vfs.cwd || '/',
      os: 'foam'
    });
  }
  return JSON.stringify({ error: 'No OS detected' });
})()`;
}

// ─── HYPERCOMPACT (Token-efficient DOM navigation) ────────────────────────────

function hcOpenCode(filePath: string): string {
  const escaped = JSON.stringify(filePath);
  return `return (async () => {
  const path = ${escaped};
  if (!window.__hc) return JSON.stringify({ error: 'HC not loaded' });

  let html;
  if (window.__shiro) {
    const resolved = window.__shiro.fs.resolvePath(path, window.__shiro.shell.cwd);
    html = await window.__shiro.fs.readFile(resolved);
  } else if (window.__foam) {
    html = await window.__foam.vfs.readFile(path);
  } else {
    return JSON.stringify({ error: 'No OS detected' });
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  window.__hc.session = new window.__hc.HCSession(doc, path);
  return JSON.stringify({ ok: true, path, chars: html.length });
})()`;
}

function hcExecCode(cmd: string): string {
  const escaped = JSON.stringify(cmd);
  return `return (() => {
  if (!window.__hc || !window.__hc.session) return '✗ no session (use hc_open first)';
  return window.__hc.session.exec(${escaped});
})()`;
}

function hcLiveCode(): string {
  return `return (() => {
  if (!window.__hc) return JSON.stringify({ error: 'HC not loaded' });
  window.__hc.session = new window.__hc.HCSession(document, 'live');
  return JSON.stringify({ ok: true, mode: 'live' });
})()`;
}

function hcStatusCode(): string {
  return `return (() => {
  if (!window.__hc) return JSON.stringify({ loaded: false });
  if (!window.__hc.session) return JSON.stringify({ loaded: true, session: false });
  return JSON.stringify({
    loaded: true,
    session: true,
    source: window.__hc.session.source,
    current: window.__hc.session.current?.tagName?.toLowerCase() || 'none',
    resultsCount: window.__hc.session.lastResults?.length || 0,
    varsCount: Object.keys(window.__hc.session.vars || {}).length
  });
})()`;
}

async function evalViaHttp(port: number, page: string, code: string): Promise<{ result: unknown; error: string | null }> {
  const resp = await fetch(`http://localhost:${port}/api/skyeyes/${page}/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    return { result: null, error: `HTTP ${resp.status}: ${text}` };
  }
  return await resp.json();
}

function textResult(text: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(text: string): { content: Array<{ type: "text"; text: string }>; isError: boolean } {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export function createSkyeyesMcpServer(port: number) {
  return createSdkMcpServer({
    name: "skyeyes",
    version: "1.0.0",
    tools: [
      tool(
        "skyeyes_eval",
        "Execute JavaScript code in a live browser page (shiro or foam) via the skyeyes bridge. Returns the result of the expression. Use this for DOM inspection, clicking buttons, reading page state, etc.",
        {
          page: z.string().describe("Page identifier. Workers use their dedicated IDs like 'shiro-{workerId}' or 'foam-{workerId}'. Human pages are just 'shiro' or 'foam'."),
          code: z.string().describe("JavaScript code to execute in the page context"),
        },
        async (args) => {
          const { result, error } = await evalViaHttp(port, args.page, args.code);
          if (error) return errorResult(error);
          return textResult(typeof result === "string" ? result : JSON.stringify(result));
        },
      ),

      tool(
        "skyeyes_status",
        "Check which skyeyes browser bridges are currently connected. Returns a JSON object mapping page names to connection status.",
        {},
        async () => {
          const resp = await fetch(`http://localhost:${port}/api/skyeyes/status`);
          const data = await resp.json();
          return textResult(JSON.stringify(data, null, 2));
        },
      ),

      tool(
        "skyeyes_reload",
        "Reload a live browser page iframe. The page will reconnect its skyeyes bridge after reload.",
        {
          page: z.string().describe("Page identifier. Workers use 'shiro-{workerId}' or 'foam-{workerId}'. Human pages are 'shiro' or 'foam'."),
        },
        async (args) => {
          const resp = await fetch(`http://localhost:${port}/api/skyeyes/${args.page}/reload`, {
            method: "POST",
          });
          if (!resp.ok) return errorResult(`HTTP ${resp.status}: ${await resp.text()}`);
          return textResult(`Reload triggered for ${args.page}`);
        },
      ),

      tool(
        "terminal_exec",
        "Execute a shell command inside the browser OS terminal (shiro or foam). The command runs through the OS's shell with full pipe/redirect support. Returns stdout, stderr, and exit code. Use this instead of skyeyes_eval when you want to run a shell command like 'ls', 'cat', 'git clone', etc.",
        {
          page: z.string().describe("Page identifier. Workers use 'shiro-{workerId}' or 'foam-{workerId}'. Human pages are 'shiro' or 'foam'."),
          command: z.string().describe("Shell command to execute (e.g., 'ls -la', 'git status', 'cat file.txt')"),
        },
        async (args) => {
          const code = terminalExecCode(args.command);
          const { result, error } = await evalViaHttp(port, args.page, code);
          if (error) return errorResult(error);
          // Result is a JSON string from the eval'd code
          try {
            const parsed = JSON.parse(typeof result === "string" ? result : JSON.stringify(result));
            if (parsed.error) return errorResult(parsed.error);
            return textResult(
              `Exit code: ${parsed.exitCode}\n` +
              (parsed.stdout ? `stdout:\n${parsed.stdout}` : "(no stdout)") +
              (parsed.stderr ? `\nstderr:\n${parsed.stderr}` : ""),
            );
          } catch {
            return textResult(String(result));
          }
        },
      ),

      tool(
        "terminal_read",
        "Read the current visible content of the browser OS terminal screen. Useful for checking what the terminal is displaying, seeing command output, or verifying the terminal state.",
        {
          page: z.string().describe("Page identifier. Workers use 'shiro-{workerId}' or 'foam-{workerId}'. Human pages are 'shiro' or 'foam'."),
        },
        async (args) => {
          const code = terminalReadCode();
          const { result, error } = await evalViaHttp(port, args.page, code);
          if (error) return errorResult(error);
          return textResult(String(result));
        },
      ),

      tool(
        "terminal_status",
        "Check the terminal status: whether a command is currently running (busy), the current working directory, and which OS is detected.",
        {
          page: z.string().describe("Page identifier. Workers use 'shiro-{workerId}' or 'foam-{workerId}'. Human pages are 'shiro' or 'foam'."),
        },
        async (args) => {
          const code = terminalStatusCode();
          const { result, error } = await evalViaHttp(port, args.page, code);
          if (error) return errorResult(error);
          return textResult(String(result));
        },
      ),

      // ─── HYPERCOMPACT TOOLS ─────────────────────────────────────────────────────
      // Token-efficient DOM navigation for LLM agents

      tool(
        "hc_open",
        "Open an HTML file for Hypercompact navigation. Loads the file from the browser OS filesystem and parses it into a detached DOM for querying. Use this before running hc_exec commands.",
        {
          page: z.string().describe("Page identifier (e.g., 'foam', 'shiro', 'foam-worker1')"),
          file: z.string().describe("Path to HTML file in the browser OS filesystem (e.g., '/home/user/page.html')"),
        },
        async (args) => {
          const code = hcOpenCode(args.file);
          const { result, error } = await evalViaHttp(port, args.page, code);
          if (error) return errorResult(error);
          try {
            const parsed = JSON.parse(String(result));
            if (parsed.error) return errorResult(parsed.error);
            return textResult(`✓ opened ${parsed.path} (${parsed.chars} chars)`);
          } catch {
            return textResult(String(result));
          }
        },
      ),

      tool(
        "hc_live",
        "Attach Hypercompact to the live page DOM. Allows navigating the actual browser page (use with caution - can affect the UI). Use hc_open for safer file-based navigation.",
        {
          page: z.string().describe("Page identifier (e.g., 'foam', 'shiro')"),
        },
        async (args) => {
          const code = hcLiveCode();
          const { result, error } = await evalViaHttp(port, args.page, code);
          if (error) return errorResult(error);
          try {
            const parsed = JSON.parse(String(result));
            if (parsed.error) return errorResult(parsed.error);
            return textResult(`✓ attached to live DOM`);
          } catch {
            return textResult(String(result));
          }
        },
      ),

      tool(
        "hc_exec",
        `Execute a Hypercompact command on the currently opened page. Returns terse output optimized for token efficiency.

Commands:
  s              State: "p:file c:N d:N @tag"
  t, t100        Text content (optional char limit)
  q <selector>   Query all matching elements → [0]text [1]text...
  q1 <selector>  Query one, set as current
  n<N>           Select Nth from results → ✓ [N] text...
  up, up<N>      Go to parent element
  ch             Show children
  g <pattern>    Grep for text → L23: matching line...
  look           List interactive elements → @0 <a> "Home"...
  @<N>           Click Nth element
  a              Show attributes
  h, h<N>        Show HTML (optional limit)
  >$name         Store to variable
  $name          Recall variable

Example workflow:
  hc_open file="page.html" → ✓ opened
  hc_exec cmd="t100" → first 100 chars of text
  hc_exec cmd="q .price" → [0]$29.99 [1]$49.99
  hc_exec cmd="n0" → ✓ [0] $29.99
  hc_exec cmd="a" → class=price data-sku=ABC`,
        {
          page: z.string().describe("Page identifier (e.g., 'foam', 'shiro')"),
          cmd: z.string().describe("Hypercompact command (e.g., 't100', 'q .price', 'n0', 'a')"),
        },
        async (args) => {
          const code = hcExecCode(args.cmd);
          const { result, error } = await evalViaHttp(port, args.page, code);
          if (error) return errorResult(error);
          return textResult(String(result));
        },
      ),

      tool(
        "hc_status",
        "Check Hypercompact session status: whether HC is loaded, if a session is active, the source file, current element, and cached results count.",
        {
          page: z.string().describe("Page identifier (e.g., 'foam', 'shiro')"),
        },
        async (args) => {
          const code = hcStatusCode();
          const { result, error } = await evalViaHttp(port, args.page, code);
          if (error) return errorResult(error);
          return textResult(String(result));
        },
      ),
    ],
  });
}
