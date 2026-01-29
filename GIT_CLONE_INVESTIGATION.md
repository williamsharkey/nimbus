# Git Clone in Browser OS - Investigation & Solutions

**Date:** January 29, 2026
**Status:** BLOCKING - Phase 2 of Nimbus Roadmap
**Worker:** nimbus agent

---

## Executive Summary

Both Shiro and Foam browser operating systems cannot successfully execute `git clone` or `git init` commands. This is a **critical blocker** for Nimbus Phase 2 (Self-Bootstrapping Workers), which requires workers to clone their own repositories within browser environments.

### Current Status
- ❌ **Shiro**: Issue #14 - OPEN
- ❌ **Foam**: Issue #12 - OPEN
- 🔴 **Impact**: Phase 2 blocked, autonomous workers cannot self-replicate

---

## Problem Description

### The Error

Both systems fail with identical root cause:

**Shiro:**
```
fatal: ENOENT: no such file or directory, stat '/path/.git/config'
```

**Foam:**
```
fatal: stat: cannot stat '/path/.git/config': No such file or directory
```

### Root Cause Analysis

1. **isomorphic-git** (the git implementation used in both systems) calls `fs.stat()` to check if `.git/config` exists before creating it
2. **Both VFS implementations** throw an error when `stat()` is called on a non-existent file
3. **isomorphic-git expects** the filesystem adapter to either:
   - Return a "file not found" result gracefully (not throw)
   - Provide an `exists()` method that doesn't throw
   - Handle ENOENT errors internally

### Code References

**Shiro** (`src/filesystem.ts`, lines 231-235):
```typescript
async stat(path: string): Promise<StatResult> {
  const node = await this._get(path);
  if (!node) throw fsError('ENOENT', `ENOENT: no such file or directory, stat '${path}'`);
  return makeStat(node);
}
```

**Foam** (`src/vfs.js`):
Similar implementation - throws on non-existent files instead of returning gracefully.

---

## Reproduction Steps

### Testing via Nimbus Skyeyes

**Prerequisites:**
1. Start Nimbus dashboard: `npm start` (port 7777)
2. Ensure Shiro and Foam pages are loaded in dashboard
3. Verify skyeyes connection: `curl localhost:7777/api/skyeyes/status`

### Test 1: git init (Shiro)

```bash
curl -s -X POST localhost:7777/api/skyeyes/shiro/exec \
  -H "Content-Type: application/json" \
  -d '{
    "code":"return (async () => {
      let output = \"\";
      let errors = \"\";
      await window.__shiro.shell.execute(
        \"cd /tmp && git init test-repo\",
        (s) => { output += s; },
        (e) => { errors += e; }
      );
      return { output, errors };
    })();"
  }'
```

**Expected:** Repository initialized
**Actual:** `fatal: ENOENT: no such file or directory, stat '/tmp/.git/config'`

### Test 2: git clone (Shiro)

```bash
curl -s -X POST localhost:7777/api/skyeyes/shiro/exec \
  -H "Content-Type: application/json" \
  -d '{
    "code":"return (async () => {
      let output = \"\";
      let errors = \"\";
      await window.__shiro.shell.execute(
        \"git clone https://github.com/williamsharkey/shiro\",
        (s) => { output += s; },
        (e) => { errors += e; }
      );
      return { output, errors };
    })();"
  }'
```

**Expected:** Repository cloned
**Actual:** `fatal: ENOENT: no such file or directory, stat '/home/user/shiro/.git/config'`

### Test 3: git clone (Foam)

```bash
curl -s -X POST localhost:7777/api/skyeyes/foam/exec \
  -H "Content-Type: application/json" \
  -d '{
    "code":"return (async () => {
      let output = \"\";
      let errors = \"\";
      await window.__foam.shell.execLive(
        \"git clone https://github.com/williamsharkey/foam\",
        {
          stdout: (s) => { output += s; },
          stderr: (e) => { errors += e; }
        }
      );
      return { output, errors };
    })();"
  }'
```

**Expected:** Repository cloned
**Actual:** `fatal: stat: cannot stat '/home/user/foam/.git/config': No such file or directory`

---

## Impact Assessment

### Immediate Impact
- ✗ Cannot clone repositories in browser OS
- ✗ Cannot initialize new git repositories
- ✗ Workers cannot self-replicate
- ✗ Phase 2 of Nimbus roadmap is blocked

### Downstream Impact
- **Phase 2.1**: Self-bootstrapping workers - BLOCKED
- **Phase 2.2**: Repository mirroring - BLOCKED
- **Phase 3**: Inter-worker communication (partially depends on Phase 2) - AT RISK
- **Long-term vision**: Autonomous agent ecosystems in browser environments - BLOCKED

### What Still Works
- ✓ Basic shell commands (ls, pwd, cd, cat, etc.)
- ✓ File operations (read, write, mkdir, rm)
- ✓ Running pre-installed tools
- ✓ Terminal emulation and display
- ✓ Network requests (fetch, curl)

---

## Proposed Solutions

### Solution 1: Fix VFS stat() Implementation (RECOMMENDED)

**Approach:** Modify both Shiro and Foam VFS to handle non-existent files gracefully.

**Shiro Changes** (`src/filesystem.ts`):
```typescript
async stat(path: string): Promise<StatResult> {
  const node = await this._get(path);
  if (!node) {
    // Instead of throwing, return a stat-like error object
    // that isomorphic-git can interpret as "file not found"
    const err: any = new Error(`ENOENT: no such file or directory, stat '${path}'`);
    err.code = 'ENOENT';
    err.errno = -2;
    throw err; // isomorphic-git catches this
  }
  return makeStat(node);
}
```

Or add a separate exists() method:
```typescript
async exists(path: string): Promise<boolean> {
  const node = await this._get(path);
  return !!node;
}
```

**Foam Changes** (`src/vfs.js`):
Similar modifications to ensure consistent error handling.

**Testing:**
1. Implement changes in both repos
2. Test with `git init` first (simpler case)
3. Test with `git clone` on small repository
4. Test with larger repository
5. Verify `.git` directory structure is correct

**Timeline:** 1-2 days for implementation + testing

---

### Solution 2: Patch isomorphic-git Configuration

**Approach:** Configure isomorphic-git to handle errors differently.

**Investigation Needed:**
1. Review isomorphic-git documentation for fs adapter requirements
2. Check if there's a configuration option for error handling
3. Test if wrapping fs calls in try/catch helps

**Code Pattern:**
```typescript
const git = require('isomorphic-git');

// Wrap filesystem with error-safe adapter
const safefs = {
  ...originalFS,
  stat: async (path) => {
    try {
      return await originalFS.stat(path);
    } catch (err) {
      if (err.code === 'ENOENT') {
        // Return a special value or re-throw with different structure
        return null;
      }
      throw err;
    }
  }
};
```

**Pros:** Could be implemented in Shiro/Foam without waiting for isomorphic-git changes
**Cons:** May be fragile, requires understanding isomorphic-git internals

**Timeline:** 2-3 days for research + implementation

---

### Solution 3: Alternative Git Implementation

**Approach:** Use a different git library designed for browser environments.

**Candidates:**
- **BrowserFS + git**: Different VFS approach
- **git-js**: May have different fs requirements
- **Native git via WebAssembly**: Compile actual git to WASM

**Pros:** Could solve other potential compatibility issues
**Cons:** Large undertaking, may introduce new issues, performance concerns

**Timeline:** 1-2 weeks for research + implementation

**Recommendation:** Only consider if Solutions 1 & 2 fail

---

### Solution 4: Workaround via External Service

**Approach:** Use an external service to handle git operations.

**Options:**
1. **Proxy through parent server**: Nimbus server clones on behalf of worker
2. **GitHub API**: Use REST API to fetch repository contents (not true clone)
3. **Cloud workspace**: Worker triggers clone in actual container/VM

**Pros:** Unblocks development immediately
**Cons:** Not true browser-native solution, defeats purpose of browser OS

**Use Case:** Temporary workaround while Solutions 1/2 are developed

**Implementation:**
```typescript
// In Nimbus server
app.post('/api/git-proxy/clone', async (req, res) => {
  const { repoUrl, targetPath, workerId } = req.body;

  // Clone on server
  const tempDir = `/tmp/nimbus-worker-${workerId}`;
  await exec(`git clone ${repoUrl} ${tempDir}`);

  // Package as tarball or zip
  const archive = await createArchive(tempDir);

  // Send to worker to extract in browser VFS
  res.json({ archive });
});
```

**Timeline:** 1-2 days for basic implementation

---

## Recommended Action Plan

### Phase 1: Immediate (This Week)
1. ✅ **Document the issue** (this document)
2. 🔲 **Comment on existing GitHub issues** with findings and proposed solutions
3. 🔲 **Implement Solution 1** in Shiro (primary target)
4. 🔲 **Test thoroughly** with various git operations
5. 🔲 **Submit PR to Shiro** with fix

### Phase 2: Short-term (Next Week)
1. 🔲 **Port fix to Foam** once Shiro fix is validated
2. 🔲 **Add test suite** for git operations in both projects
3. 🔲 **Update Nimbus** to verify worker git capabilities on startup
4. 🔲 **Document** git usage in worker environments

### Phase 3: Medium-term (Next 2 Weeks)
1. 🔲 **Implement Solution 4** as fallback/backup
2. 🔲 **Test Phase 2** of Nimbus roadmap with working git
3. 🔲 **Add CI tests** for git operations
4. 🔲 **Document** full self-bootstrapping workflow

---

## Technical Deep Dive: isomorphic-git fs Adapter

### Expected Interface

isomorphic-git expects a filesystem adapter that implements:

```typescript
interface FSAdapter {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  rmdir(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  stat(path: string): Promise<StatResult>; // PROBLEM HERE
  lstat?(path: string): Promise<StatResult>;
  readlink?(path: string): Promise<string>;
  symlink?(target: string, path: string): Promise<void>;
}
```

### The stat() Contract

From isomorphic-git documentation and source code analysis:

1. **Should NOT throw** on non-existent files in most contexts
2. **Should throw** only on permission errors or filesystem corruption
3. **Expected behavior** for missing files:
   - Option A: Throw with specific error code that git catches
   - Option B: Return null/undefined (depends on version)
   - Option C: Return stat object with `exists: false` property

### Current Behavior vs. Expected

| Operation | Current Behavior | Expected Behavior |
|-----------|-----------------|-------------------|
| `stat('/existing/file')` | ✓ Returns StatResult | ✓ Returns StatResult |
| `stat('/missing/file')` | ✗ Throws ENOENT | ? Graceful handling |
| `stat('/.git/config')` (before init) | ✗ Throws ENOENT | ? Should not block init |

---

## Validation Checklist

Once a fix is implemented, test these scenarios:

### Basic Git Operations
- [ ] `git init` in empty directory
- [ ] `git init` in existing directory
- [ ] `git clone <public-repo>` (small)
- [ ] `git clone <public-repo>` (large, 100MB+)
- [ ] `git status` after clone
- [ ] `git log` shows history

### File Operations Post-Clone
- [ ] Can read cloned files
- [ ] Can modify cloned files
- [ ] Can stage changes (`git add`)
- [ ] Can commit changes
- [ ] `.git` directory structure is valid

### Edge Cases
- [ ] Clone to non-existent parent directory
- [ ] Clone with existing destination
- [ ] Interrupted clone (network error simulation)
- [ ] Multiple concurrent clones
- [ ] Clone + immediate operations

---

## Resources & References

### GitHub Issues
- Shiro: https://github.com/williamsharkey/shiro/issues/14
- Foam: https://github.com/williamsharkey/foam/issues/12

### Documentation
- isomorphic-git: https://isomorphic-git.org/docs/en/fs
- isomorphic-git fs plugin: https://github.com/isomorphic-git/isomorphic-git/blob/main/src/models/FileSystem.js

### Related Nimbus Files
- `ISSUES.md` - Lines 67-93 (original issue documentation)
- `TESTING_WITH_SKYEYES.md` - Lines 92-133 (reproduction steps)
- `ROADMAP.md` - Phase 2 planning
- `CLAUDE.md` - Worker capabilities section

### Testing Tools
- Nimbus Skyeyes API for remote browser testing
- curl commands for API interaction
- Browser DevTools console for debugging

---

## Next Steps

### For Nimbus Repository
1. ✅ Create this investigation document
2. 🔲 Update ISSUES.md with references to this document
3. 🔲 Monitor upstream PRs and be ready to integrate fixes
4. 🔲 Consider implementing Solution 4 (workaround) in parallel

### For Shiro Repository
1. 🔲 Comment on issue #14 with proposed Solution 1
2. 🔲 Fork repository and implement fix
3. 🔲 Create test suite for git operations
4. 🔲 Submit PR with fix and tests
5. 🔲 Validate fix via Nimbus skyeyes testing

### For Foam Repository
1. 🔲 Comment on issue #12 with proposed Solution 1
2. 🔲 Wait for Shiro fix validation (or proceed in parallel)
3. 🔲 Port fix from Shiro to Foam
4. 🔲 Submit PR with fix and tests
5. 🔲 Validate fix via Nimbus skyeyes testing

---

## Success Criteria

✓ **Minimum Viable:**
- `git clone https://github.com/williamsharkey/shiro` succeeds in Shiro
- `git clone https://github.com/williamsharkey/foam` succeeds in Foam

✓ **Phase 2 Ready:**
- Workers can clone their own repositories
- Workers can read cloned code
- Workers can execute basic git operations

✓ **Production Ready:**
- All edge cases handled
- Test suite covers git operations
- Documentation updated
- CI/CD includes git tests

---

**Document Status:** DRAFT - In Progress
**Last Updated:** 2026-01-29
**Next Review:** After implementing Solution 1 or receiving upstream feedback
