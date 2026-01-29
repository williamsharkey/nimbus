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
    ],
  });
}
