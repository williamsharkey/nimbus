# Nimbus Repository Issues & Challenges

**Date:** January 29, 2026
**Reporter:** nimbus worker agent
**Status:** Active Issues Identified

---

## 🔴 Critical Issues

### 1. Build Script Missing - `scripts/build-client.js`
**Priority:** HIGH
**Status:** BLOCKING BUILD PROCESS

**Problem:**
- The `package.json` build script references `scripts/build-client.js` which does not exist
- Build command fails: `Error: Cannot find module '/Users/wm/Desktop/nimbus-land/nimbus/scripts/build-client.js'`
- This prevents the TypeScript compilation pipeline from completing successfully

**Current State:**
```json
"scripts": {
  "build": "tsc && node scripts/build-client.js",
  "build:client": "esbuild src/client/app.ts --bundle --outfile=src/client/app.js --format=esm --target=es2022"
}
```

**Files Present in scripts/:**
- `scripts/setup.sh` (exists)
- `scripts/build-client.js` (MISSING)

**Impact:**
- Cannot run `npm run build` successfully
- CI/CD pipelines would fail
- New contributors cannot build the project
- Deployment process is broken

**Recommended Fix:**
Either:
1. Create the missing `scripts/build-client.js` file that invokes esbuild
2. Update `package.json` build script to use the existing `build:client` script directly
3. Simplify build to just use esbuild CLI

**Suggested Implementation:**
```javascript
// scripts/build-client.js
const esbuild = require('esbuild');

esbuild.build({
  entryPoints: ['src/client/app.ts'],
  bundle: true,
  outfile: 'src/client/app.js',
  format: 'esm',
  target: 'es2022',
}).catch(() => process.exit(1));
```

Or update package.json:
```json
"build": "tsc && npm run build:client"
```

---

## 🟡 Medium Priority Issues

### 2. Git Clone Functionality Broken in Browser OSes
**Priority:** MEDIUM (HIGH)
**Status:** ✅ INVESTIGATED - SOLUTIONS PROPOSED - UPSTREAM ISSUES COMMENTED

**Problem:**
- Both Shiro and Foam browser terminals cannot successfully clone git repositories
- Documented in `TESTING_WITH_SKYEYES.md` (lines 92-133, 168-189)
- Error: `fatal: ENOENT: no such file or directory, stat '/home/user/shiro/.git/config'`

**Root Cause:**
- isomorphic-git calls `fs.stat()` to check if files exist before creating them
- Both VFS implementations throw ENOENT instead of returning gracefully
- Simple fix: Modify error structure or add `exists()` method

**Upstream Issues:**
- https://github.com/williamsharkey/shiro/issues/14 ✅ Commented with solution
- https://github.com/williamsharkey/foam/issues/12 ✅ Commented with solution

**Impact:**
- Phase 2 of roadmap blocked (Self-Bootstrapping Workers)
- Workers cannot clone their own repositories
- Cannot test autonomous worker capabilities
- Core vision of self-replicating agents is blocked

**Detailed Documentation:**
- 📄 **`GIT_CLONE_INVESTIGATION.md`** - Full root cause analysis, 4 proposed solutions
- 📄 **`GIT_PROXY_WORKAROUND.md`** - Immediate workaround via server-side proxy

**Current Workaround:**
✅ **Available** - Server-side git proxy (can implement in 1-2 days)
- Server clones repo using real git
- Transfers files to worker VFS via WebSocket
- Unblocks Phase 2 while upstream fixes are developed

**Next Steps:**
1. ✅ Investigate root cause
2. ✅ Propose solutions to upstream repos
3. ⏳ Wait for upstream PR review or implement locally
4. 🔲 Consider implementing proxy workaround in parallel
5. 🔲 Test fixes via Nimbus skyeyes infrastructure

---

### 3. Incomplete MCP Skyeyes Integration
**Priority:** MEDIUM
**Status:** NEWLY ADDED, NEEDS TESTING

**Observation:**
- `src/mcp/skyeyes-tools.ts` was recently added (file is new)
- Provides MCP server for skyeyes terminal operations
- Not clear if this is integrated into main server startup
- Missing documentation on how workers access these MCP tools

**Questions to Answer:**
1. Is `createSkyeyesMcpServer()` called in `src/server/index.ts`?
2. How do workers discover and connect to this MCP server?
3. Is there a MCP server configuration file?
4. Are the dedicated worker page IDs (`shiro-{workerId}`, `foam-{workerId}`) properly implemented?

**Testing Needed:**
- Verify MCP server starts with main application
- Test terminal_exec, terminal_read, terminal_status tools
- Confirm worker-specific page isolation works
- Validate against Claude Agent SDK MCP specs

---

## 🟢 Low Priority / Technical Debt

### 4. Missing Worker Workspace Directory Structure
**Priority:** LOW
**Status:** PLANNED FOR PHASE 2

**Problem:**
- Roadmap mentions workspace directories for workers (lines 32-47 in ROADMAP.md)
- No implementation exists yet
- No directory structure defined for worker isolation

**Impact:**
- Workers would conflict if they tried to clone to same directory
- No isolated workspaces for build artifacts
- Cannot support multiple workers working on same repo

**Planned Implementation (from roadmap):**
```typescript
interface WorkerCapabilities {
  canClone: boolean;
  canBuild: boolean;
  canDeploy: boolean;
  workspaceDir: string;
}
```

---

### 5. GitHub Authentication Not Configured
**Priority:** LOW
**Status:** PLANNED FOR PHASE 2

**Problem:**
- Workers need GitHub credentials to clone private repos
- No authentication mechanism implemented
- No secure credential storage

**Impact:**
- Can only clone public repositories (when git clone is fixed)
- Cannot work on private organizational repos
- Security risk if credentials stored incorrectly

**Mentioned in Roadmap:**
- Phase 2.1: "Add GitHub authentication management"
- Phase 5.1: "Secure credential management"

---

### 6. Documentation Inconsistency
**Priority:** LOW
**Status:** MINOR

**Observations:**
- `TESTING_WITH_SKYEYES.md` documents curl-based API access
- New MCP tools provide native TypeScript access
- Unclear which method workers should use
- Need to update docs when MCP integration is complete

**Files Affected:**
- `TESTING_WITH_SKYEYES.md` - focuses on curl/HTTP API
- `CLAUDE.md` - may need updates for MCP architecture
- `README.md` - may need MCP server documentation

---

## 📊 Summary

### Blocking Issues: 1
- Missing build script

### Phase 2 Blockers: 1
- Git clone broken in browser OSes (upstream)

### Integration Issues: 1
- MCP skyeyes tools unclear integration status

### Planned Features: 3
- Worker workspaces
- GitHub auth
- Documentation updates

---

## 🎯 Recommended Next Steps

### Immediate (Before any development):
1. ✅ Fix build script issue - create `scripts/build-client.js` or update package.json
2. Test that `npm run build` completes successfully
3. Verify `npm start` launches dashboard correctly

### Short Term (This week):
1. Verify MCP skyeyes server integration
2. Test dedicated worker page IDs (`shiro-nimbus`, `foam-nimbus`)
3. Attempt basic terminal_exec commands via MCP
4. Document MCP setup in README

### Medium Term (Phase 2 prep):
1. Monitor upstream Shiro/Foam repos for git clone fixes
2. Design worker workspace directory structure
3. Plan GitHub authentication strategy
4. Begin Claude Code session integration research

### Long Term:
1. Implement autonomous worker capabilities (Phase 2)
2. Build inter-worker communication (Phase 3)
3. Add security and sandboxing (Phase 5)

---

## 🔍 Additional Notes

### Positive Observations:
- Clean TypeScript codebase with good separation of concerns
- Well-documented roadmap with clear phases
- Modern tech stack (esbuild, TypeScript, WebSocket)
- Skyeyes integration is innovative approach to browser testing
- MCP tools show forward-thinking architecture

### Architecture Strengths:
- Server/client separation is clean
- Worker management appears well-abstracted
- WebSocket real-time communication properly implemented
- Type safety with TypeScript and Zod validation

### Testing Gaps:
- No test suite visible (no `__tests__/` or `.test.ts` files)
- No CI/CD configuration (no `.github/workflows/`)
- No linting configuration (no eslint/prettier config)
- Manual testing via Skyeyes API documented, but no automated tests

---

**End of Issues Report**
