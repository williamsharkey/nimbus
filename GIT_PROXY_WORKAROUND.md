# Git Clone Proxy Workaround for Nimbus

**Purpose:** Enable workers to "clone" repositories while upstream git issues are being resolved
**Status:** Proposed Solution 4 from GIT_CLONE_INVESTIGATION.md
**Timeline:** Can be implemented in 1-2 days

---

## Architecture

```
┌─────────────────┐
│  Browser Worker │
│   (Shiro/Foam)  │
└────────┬────────┘
         │ 1. Request clone via WebSocket
         │
         ▼
┌─────────────────┐
│ Nimbus Server   │
│  (Node.js)      │
└────────┬────────┘
         │ 2. Clone using real git
         │
         ▼
┌─────────────────┐
│  Host System    │
│  /tmp/workspaces│
└────────┬────────┘
         │ 3. Package as archive
         │
         ▼
┌─────────────────┐
│  Browser Worker │
│  Extract to VFS │
└─────────────────┘
```

---

## Implementation Plan

### 1. Add Git Proxy Route to Server

**File:** `src/server/routes.ts`

Add new endpoint:

```typescript
// Git proxy for workers (temporary workaround)
app.post('/api/git/clone', async (req, res) => {
  const { repoUrl, workerId, targetPath } = req.body;

  // Validate inputs
  if (!repoUrl || !workerId) {
    return res.status(400).json({ error: 'Missing repoUrl or workerId' });
  }

  try {
    // Create workspace directory
    const workspaceDir = path.join(os.tmpdir(), 'nimbus-git-proxy', workerId);
    await fs.promises.mkdir(workspaceDir, { recursive: true });

    // Clone repository
    const repoName = repoUrl.split('/').pop()?.replace('.git', '') || 'repo';
    const clonePath = path.join(workspaceDir, repoName);

    console.log(`[git-proxy] Cloning ${repoUrl} to ${clonePath}`);

    await execAsync(`git clone ${repoUrl} ${clonePath}`);

    // Create file manifest
    const files = await gatherFiles(clonePath);

    // Send file tree to worker
    res.json({
      success: true,
      repoName,
      files,
      message: `Cloned ${files.length} files`
    });

    // Cleanup after sending (optional - could keep for future pulls)
    // await fs.promises.rm(workspaceDir, { recursive: true });

  } catch (error) {
    console.error('[git-proxy] Clone failed:', error);
    res.status(500).json({
      error: 'Clone failed',
      message: error.message
    });
  }
});

// Helper: Recursively gather all files
async function gatherFiles(dir: string, baseDir = dir): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];
  const items = await fs.promises.readdir(dir, { withFileTypes: true });

  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    const relativePath = path.relative(baseDir, fullPath);

    if (item.isDirectory()) {
      if (item.name === '.git') {
        // Include .git directory contents
        entries.push(...await gatherFiles(fullPath, baseDir));
      } else {
        entries.push(...await gatherFiles(fullPath, baseDir));
      }
    } else {
      const content = await fs.promises.readFile(fullPath);
      entries.push({
        path: relativePath,
        content: content.toString('base64'), // Base64 for binary safety
        isText: isTextFile(item.name),
        size: content.length
      });
    }
  }

  return entries;
}

interface FileEntry {
  path: string;
  content: string; // base64 encoded
  isText: boolean;
  size: number;
}

function isTextFile(filename: string): boolean {
  const textExtensions = [
    '.js', '.ts', '.tsx', '.jsx', '.json', '.md', '.txt',
    '.html', '.css', '.scss', '.yml', '.yaml', '.xml',
    '.sh', '.bash', '.py', '.rb', '.go', '.rs', '.c', '.cpp',
    '.h', '.hpp', '.java', '.kt', '.swift', '.php', '.sql'
  ];
  return textExtensions.some(ext => filename.endsWith(ext)) || filename.startsWith('.');
}
```

---

### 2. Add WebSocket Command for Workers

**File:** `src/server/ws.ts`

Add handler:

```typescript
ws.on('message', async (message: string) => {
  const msg = JSON.parse(message);

  if (msg.type === 'git_clone_request') {
    const { repoUrl, targetPath, workerId } = msg;

    try {
      // Forward to HTTP endpoint
      const response = await fetch('http://localhost:7777/api/git/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoUrl, workerId, targetPath })
      });

      const result = await response.json();

      // Send files to worker
      ws.send(JSON.stringify({
        type: 'git_clone_response',
        workerId,
        success: result.success,
        files: result.files,
        repoName: result.repoName
      }));

    } catch (error) {
      ws.send(JSON.stringify({
        type: 'git_clone_response',
        workerId,
        success: false,
        error: error.message
      }));
    }
  }
});
```

---

### 3. Worker-Side Helper Function

**Create:** `src/workers/git-proxy-client.ts`

```typescript
/**
 * Git proxy client for browser workers
 * Uses Nimbus server as git proxy until browser git is fixed
 */

export async function gitCloneViaProxy(
  repoUrl: string,
  targetPath: string,
  workerId: string,
  wsConnection: WebSocket
): Promise<boolean> {

  return new Promise((resolve, reject) => {
    // Send clone request
    wsConnection.send(JSON.stringify({
      type: 'git_clone_request',
      repoUrl,
      targetPath,
      workerId
    }));

    // Wait for response
    const handler = (event: MessageEvent) => {
      const msg = JSON.parse(event.data);

      if (msg.type === 'git_clone_response' && msg.workerId === workerId) {
        wsConnection.removeEventListener('message', handler);

        if (msg.success) {
          // Write files to VFS
          writeFilesToVFS(msg.files, targetPath).then(() => {
            console.log(`[git-proxy] Successfully cloned to ${targetPath}`);
            resolve(true);
          }).catch(reject);
        } else {
          reject(new Error(msg.error || 'Clone failed'));
        }
      }
    };

    wsConnection.addEventListener('message', handler);

    // Timeout after 5 minutes
    setTimeout(() => {
      wsConnection.removeEventListener('message', handler);
      reject(new Error('Clone timeout'));
    }, 5 * 60 * 1000);
  });
}

async function writeFilesToVFS(files: FileEntry[], baseDir: string) {
  // This will be called in the BROWSER context (Shiro/Foam)
  // Assumes access to window.__shiro or window.__foam

  for (const file of files) {
    const fullPath = `${baseDir}/${file.path}`;
    const dirPath = fullPath.substring(0, fullPath.lastIndexOf('/'));

    // Create directory structure
    if (dirPath) {
      await window.__shiro.fs.mkdir(dirPath, { recursive: true });
    }

    // Decode base64 content
    const content = atob(file.content);
    const bytes = new Uint8Array(content.length);
    for (let i = 0; i < content.length; i++) {
      bytes[i] = content.charCodeAt(i);
    }

    // Write file
    await window.__shiro.fs.writeFile(fullPath, bytes);
  }
}

interface FileEntry {
  path: string;
  content: string; // base64
  isText: boolean;
  size: number;
}
```

---

### 4. Usage in Worker Scripts

**Example:** Worker receives task to clone Shiro

```typescript
// In worker execution context
async function handleCloneTask(task: Task) {
  const { repoUrl } = task;

  console.log(`[worker] Cloning ${repoUrl} via proxy...`);

  try {
    await gitCloneViaProxy(
      repoUrl,
      '/home/user/repos/shiro',
      workerId,
      wsConnection
    );

    console.log('[worker] Clone complete!');

    // Now can read files
    const readme = await window.__shiro.fs.readFile(
      '/home/user/repos/shiro/README.md',
      'utf8'
    );

    console.log('README:', readme);

  } catch (error) {
    console.error('[worker] Clone failed:', error);
  }
}
```

---

## Advantages

✅ **Unblocks Phase 2 immediately** - Workers can start cloning
✅ **Reliable** - Uses real git, not browser implementation
✅ **Full git history** - Includes .git directory
✅ **Fast** - Server-side clone is faster than browser
✅ **Works with private repos** - Can use server's SSH keys
✅ **Simple** - No complex isomorphic-git debugging

---

## Disadvantages

⚠️ **Not true browser-native** - Defeats purpose of browser OS
⚠️ **Security concerns** - Server has clone capabilities
⚠️ **Network overhead** - Files sent over WebSocket
⚠️ **Disk usage** - Server stores temporary clones
⚠️ **Scalability** - Server becomes bottleneck
⚠️ **Not a long-term solution** - Should be replaced when browser git works

---

## Security Considerations

### 1. Restrict Allowed Repositories

```typescript
const ALLOWED_REPOS = [
  'https://github.com/williamsharkey/shiro',
  'https://github.com/williamsharkey/foam',
  'https://github.com/your-org/*' // wildcard for org repos
];

function isRepoAllowed(repoUrl: string): boolean {
  return ALLOWED_REPOS.some(pattern => {
    if (pattern.endsWith('/*')) {
      return repoUrl.startsWith(pattern.slice(0, -2));
    }
    return repoUrl === pattern;
  });
}
```

### 2. Rate Limiting

```typescript
const cloneRateLimit = new Map<string, number>();

function checkRateLimit(workerId: string): boolean {
  const now = Date.now();
  const lastClone = cloneRateLimit.get(workerId) || 0;

  if (now - lastClone < 60000) { // 1 clone per minute
    return false;
  }

  cloneRateLimit.set(workerId, now);
  return true;
}
```

### 3. File Size Limits

```typescript
const MAX_REPO_SIZE = 100 * 1024 * 1024; // 100MB
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB per file

async function validateRepoSize(dir: string): Promise<boolean> {
  const stats = await getDirSize(dir);
  return stats.totalSize < MAX_REPO_SIZE;
}
```

### 4. Workspace Isolation

```typescript
// Each worker gets isolated workspace
const workspaceDir = path.join(
  os.tmpdir(),
  'nimbus-git-proxy',
  workerId // Unique per worker
);

// Prevent path traversal
const resolvedPath = path.resolve(workspaceDir, targetPath);
if (!resolvedPath.startsWith(workspaceDir)) {
  throw new Error('Invalid target path');
}
```

---

## Testing Plan

### Unit Tests

```typescript
describe('Git Proxy', () => {
  it('should clone a public repository', async () => {
    const result = await cloneRepo(
      'https://github.com/williamsharkey/shiro',
      'test-worker-1'
    );
    expect(result.success).toBe(true);
    expect(result.files.length).toBeGreaterThan(0);
  });

  it('should reject disallowed repositories', async () => {
    await expect(
      cloneRepo('https://github.com/malicious/repo', 'test-worker-1')
    ).rejects.toThrow('Repository not allowed');
  });

  it('should enforce rate limits', async () => {
    await cloneRepo('https://github.com/williamsharkey/shiro', 'test-worker-1');
    await expect(
      cloneRepo('https://github.com/williamsharkey/shiro', 'test-worker-1')
    ).rejects.toThrow('Rate limit exceeded');
  });
});
```

### Integration Tests

1. **Full Clone Flow:**
   - Start Nimbus server
   - Create test worker
   - Request clone via WebSocket
   - Verify files written to VFS
   - Read cloned files
   - Verify git metadata (.git directory)

2. **Error Handling:**
   - Invalid repository URL
   - Network timeout
   - Large repository (>100MB)
   - Concurrent clone requests

3. **Browser Testing via Skyeyes:**

```bash
# Test clone request from browser
curl -X POST localhost:7777/api/skyeyes/shiro/exec \
  -H "Content-Type: application/json" \
  -d '{
    "code":"return (async () => {
      // Assuming gitCloneViaProxy is injected
      const result = await gitCloneViaProxy(
        \"https://github.com/williamsharkey/shiro\",
        \"/home/user/cloned-shiro\",
        \"test-worker\"
      );
      return result;
    })();"
  }'
```

---

## Deployment Checklist

- [ ] Implement server-side clone endpoint
- [ ] Add WebSocket message handlers
- [ ] Create worker-side client library
- [ ] Add security restrictions (allowlist, rate limiting)
- [ ] Add file size limits
- [ ] Implement cleanup of temp directories
- [ ] Add logging and monitoring
- [ ] Write unit tests
- [ ] Write integration tests
- [ ] Test with Shiro worker
- [ ] Test with Foam worker
- [ ] Document usage in CLAUDE.md
- [ ] Update ROADMAP.md with workaround note
- [ ] Add migration plan to native git when available

---

## Migration Plan

When browser-native git is fixed:

1. **Phase Out Gradually:**
   - Add feature flag: `USE_GIT_PROXY` (default: true)
   - Test native git in parallel
   - Monitor error rates
   - Switch flag to false when stable
   - Keep proxy code for 2-3 releases as fallback

2. **Worker Detection:**
```typescript
async function detectGitCapabilities() {
  try {
    await window.__shiro.shell.execute('git --version');
    return { native: true, needsProxy: false };
  } catch {
    return { native: false, needsProxy: true };
  }
}
```

3. **Automatic Fallback:**
```typescript
async function gitClone(repoUrl: string, targetPath: string) {
  const caps = await detectGitCapabilities();

  if (caps.native) {
    return await nativeGitClone(repoUrl, targetPath);
  } else {
    return await gitCloneViaProxy(repoUrl, targetPath);
  }
}
```

---

## Performance Considerations

### Expected Performance

| Repository Size | Clone Time (Server) | Transfer Time (WS) | Total |
|-----------------|---------------------|--------------------|-------|
| Small (1MB)     | 1-2s               | 0.5s              | ~2s   |
| Medium (10MB)   | 3-5s               | 2-3s              | ~7s   |
| Large (50MB)    | 10-15s             | 10-15s            | ~25s  |

### Optimization Opportunities

1. **Compression:** Gzip files before sending
2. **Streaming:** Stream files instead of waiting for full clone
3. **Caching:** Cache popular repos on server
4. **Partial Clone:** Only send needed files (exclude node_modules, etc.)
5. **Delta Transfer:** If repo already partially cloned, send only diffs

---

## Alternative: Archive-Based Approach

Instead of individual files, send as tarball:

```typescript
// Server-side
const tarball = await createTarball(clonePath);
const base64 = tarball.toString('base64');

res.json({
  success: true,
  archive: base64,
  format: 'tar.gz'
});

// Client-side (browser)
const tarData = atob(msg.archive);
await extractTarballToVFS(tarData, targetPath);
```

**Pros:** Smaller transfer size, maintains permissions
**Cons:** Requires tar implementation in browser

---

## Success Metrics

✓ **Functional:**
- Workers can clone their own repositories
- Files are readable and usable
- Git metadata is preserved

✓ **Performance:**
- Small repos (<5MB) clone in <5 seconds
- Large repos (<50MB) clone in <30 seconds
- No server crashes or memory leaks

✓ **Reliability:**
- 99%+ success rate for allowed repositories
- Graceful error handling
- Automatic retry on transient failures

---

## Conclusion

The git proxy workaround provides a **pragmatic solution** to unblock Nimbus Phase 2 while upstream issues are resolved. While not ideal for the long-term vision of browser-native development, it enables immediate progress on:

- Self-bootstrapping workers
- Repository mirroring
- Multi-worker orchestration
- Testing and validation

**Recommendation:** Implement this workaround in parallel with contributing fixes to Shiro and Foam. This dual-track approach ensures Nimbus development can continue while working toward the ideal solution.

---

**Status:** Ready for implementation
**Estimated Time:** 1-2 days
**Dependencies:** None (can start immediately)
**Next Step:** Review and approve, then implement server-side endpoint
