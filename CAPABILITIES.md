# Shiro & Foam Capability Matrix

Browser-native development environments. What works, what doesn't, and why.

## Quick Summary

| Feature | Shiro | Foam | Blocker |
|---------|-------|------|---------|
| **npm install lodash** | ✅ Works | ✅ Works | - |
| **npm install & use leftpad** | ✅ Works | ⚠️ Manual deps | No auto dependency resolution |
| **Run installed CLI tools** | ❌ No | ❌ No | No Node.js runtime |
| **git clone** | ✅ Works | ✅ Works | - |
| **git push** | ⚠️ With token | ❌ No | Auth not implemented in Foam |
| **vi/vim editor** | ⚠️ View only | ⚠️ View only | Terminal raw mode missing |
| **Python** | ❌ No | ✅ Pyodide | - |
| **TypeScript compile** | ✅ esbuild-wasm | ❌ No | - |
| **Spirit (Claude Code)** | ✅ Full | ✅ Full | - |

## Detailed Breakdown

### Package Management

| Operation | Shiro | Foam | Notes |
|-----------|-------|------|-------|
| `npm init` | ✅ | ✅ | Creates package.json |
| `npm install <pkg>` | ✅ | ✅ | Real tarballs from registry |
| `npm install` (all deps) | ✅ | ⚠️ | Foam: manual install each |
| Transitive dependencies | ✅ Auto | ❌ Manual | Shiro has BFS resolver |
| `npm run <script>` | ✅ | ✅ | Via shell |
| `npm list` | ✅ | ✅ | Shows installed |
| `require()` CommonJS | ❌ | ❌ | **Major blocker** |
| ES modules import | ⚠️ | ⚠️ | Via npx/esm.sh only |
| Native .node modules | ❌ | ❌ | No C++ bindings |
| Run bin/ executables | ❌ | ❌ | No Node.js runtime |

**Example - What Works:**
```bash
npm install lodash-es    # ✅ ESM version works
npm install is-number    # ✅ Simple packages work
npm install chalk        # ⚠️ Works via npx, not require()
```

**Example - What Fails:**
```bash
npm install typescript   # Installs, but `tsc` won't run
npm install prettier     # Installs, but `prettier` won't run
npm install webpack      # Installs, but can't execute
```

### Git Operations

| Operation | Shiro | Foam | Notes |
|-----------|-------|------|-------|
| `git init` | ✅ | ✅ | |
| `git add` | ✅ | ✅ | |
| `git commit` | ✅ | ✅ | |
| `git status` | ✅ | ✅ | |
| `git log` | ✅ | ✅ | |
| `git diff` | ✅ | ✅ | |
| `git branch` | ✅ | ✅ | |
| `git checkout` | ✅ | ✅ | |
| `git clone` (public) | ✅ | ✅ | Via GitHub API tarball |
| `git clone` (private) | ⚠️ | ❌ | Needs GITHUB_TOKEN |
| `git push` | ⚠️ | ❌ | Shiro: needs token |
| `git pull` | ⚠️ | ❌ | Shiro: needs token |
| `git merge` | ⚠️ | ❌ | Basic in Shiro |
| Submodules | ❌ | ❌ | Not supported |
| LFS | ❌ | ❌ | Not supported |

### Text Editors

| Editor | Shiro | Foam | Status |
|--------|-------|------|--------|
| `vi` / `vim` | ⚠️ | ⚠️ | View only, logic implemented but no terminal raw mode |
| `nano` | ⚠️ | ⚠️ | View only |
| `ed` (line editor) | ✅ | ✅ | **Full support** - scriptable, works with Spirit |
| `cat > file << EOF` | ✅ | ✅ | Heredoc file creation |
| `sed -i` | ✅ | ✅ | In-place editing |

**Workaround for editing:** Spirit uses `ed` commands or heredocs:
```bash
ed myfile.txt 3c "new line content" w    # Change line 3
cat > newfile.js << 'EOF'
console.log("hello");
EOF
```

### Build Tools

| Tool | Shiro | Foam | Notes |
|------|-------|------|-------|
| esbuild (WASM) | ✅ | ❌ | TypeScript/JS bundling |
| tsc (TypeScript) | ❌ | ❌ | Needs Node.js |
| webpack | ❌ | ❌ | Needs Node.js |
| vite | ❌ | ❌ | Needs Node.js |
| rollup | ❌ | ❌ | Needs Node.js |
| babel | ❌ | ❌ | Needs Node.js |

**Shiro can compile TypeScript:**
```bash
build src/app.ts --outfile=dist/app.js --bundle
```

### Languages

| Language | Shiro | Foam | Notes |
|----------|-------|------|-------|
| JavaScript | ✅ | ✅ | Via `js-eval` / `node -e` |
| TypeScript | ✅ | ❌ | Via esbuild-wasm |
| Python | ❌ | ✅ | Via Pyodide WASM |
| Ruby/Go/Rust | ❌ | ❌ | Would need WASM ports |

### AI Coding Agents

| Feature | Shiro | Foam | Notes |
|---------|-------|------|-------|
| Spirit (Claude Code) | ✅ | ✅ | Full integration |
| File read/write | ✅ | ✅ | Via VFS |
| Shell commands | ✅ | ✅ | All commands available |
| Interactive editing | ⚠️ | ⚠️ | Uses ed/heredoc, not vi |
| Git operations | ✅ | ⚠️ | Foam: no push |
| Build projects | ✅ | ❌ | Shiro has esbuild |

---

## What Blocks Real Apps?

### 1. No Node.js Runtime
**Impact:** Can't run any npm CLI tools (typescript, prettier, eslint, webpack, etc.)
**Workaround:** Use esbuild-wasm in Shiro for TypeScript
**Fix needed:** WebContainers, wasi-node, or custom Node.js WASM port

### 2. No CommonJS require()
**Impact:** ~70% of npm packages use CommonJS and won't work
**Workaround:** Use ESM packages via esm.sh/npx
**Fix needed:** Implement require() with module resolution

### 3. No Terminal Raw Mode
**Impact:** Interactive editors (vi/vim/nano) don't work
**Workaround:** Use `ed` line editor or heredocs
**Fix needed:** xterm.js raw mode integration + keystroke capture

### 4. No Native Modules
**Impact:** Packages with .node bindings fail (sqlite3, bcrypt, sharp, etc.)
**Workaround:** Use pure JS alternatives or WASM versions
**Fix needed:** Would require full WASI implementation

### 5. CORS Restrictions
**Impact:** Can't fetch from arbitrary URLs
**Workaround:** CORS proxy (cors.isomorphic-git.org)
**Fix needed:** Browser limitation, needs proxy

---

## Most Impressive Working Workflow

**Full TypeScript project in Shiro:**
```bash
# Clone a repo
git clone https://github.com/user/my-ts-project

# Install dependencies
npm install

# Edit code (via heredoc or ed)
cat > src/index.ts << 'EOF'
import _ from 'lodash';
export const sum = (a: number, b: number) => a + b;
console.log(_.map([1,2,3], x => x * 2));
EOF

# Build with esbuild
build src/index.ts --outfile=dist/bundle.js --bundle

# Run it
js-eval "$(cat dist/bundle.js)"

# Commit
git add . && git commit -m "Add sum function"
```

**Data analysis in Foam:**
```bash
pip install pandas numpy matplotlib
python << 'EOF'
import pandas as pd
import numpy as np
data = pd.DataFrame({'x': range(10), 'y': np.random.randn(10)})
print(data.describe())
EOF
```

---

## Comparison to Real Dev Environments

| Capability | Shiro/Foam | VS Code | GitHub Codespaces |
|------------|------------|---------|-------------------|
| Runs in browser | ✅ | ❌ | ✅ |
| No server needed | ✅ | N/A | ❌ |
| Full Node.js | ❌ | ✅ | ✅ |
| npm CLI tools | ❌ | ✅ | ✅ |
| Interactive vim | ❌ | ✅ | ✅ |
| Git push | ⚠️ | ✅ | ✅ |
| Offline capable | ✅ | ✅ | ❌ |
| Free | ✅ | ✅ | ⚠️ Limited |
| Spirit/Claude | ✅ | Via extension | Via extension |

---

## Roadmap to "Real App" Support

1. **Terminal raw mode** → Interactive vi/vim
2. **Node.js WASM** → Run any npm CLI tool
3. **require() implementation** → CommonJS compatibility
4. **WASI support** → Native module alternatives
5. **Git auth UI** → Push/pull without env vars

*Last updated: 2026-01-30*
