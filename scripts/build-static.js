#!/usr/bin/env node
/**
 * Build static HTML files for shiro and foam that can be opened locally (file://)
 * Output: dist/shiro.html, dist/foam.html
 *
 * Usage: node scripts/build-static.js
 */

import * as esbuild from 'esbuild';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nimbusRoot = path.resolve(__dirname, '..');
const basePath = path.resolve(nimbusRoot, '..');
const distDir = path.join(nimbusRoot, 'dist');

// Ensure dist directory exists
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

async function buildShiro() {
  console.log('Building Shiro...');
  const shiroPath = path.join(basePath, 'shiro');

  // Install deps if needed
  if (!fs.existsSync(path.join(shiroPath, 'node_modules'))) {
    console.log('  Installing shiro dependencies...');
    execSync('npm install', { cwd: shiroPath, stdio: 'inherit' });
  }

  // Build with Vite
  console.log('  Running vite build...');
  execSync('npx vite build', { cwd: shiroPath, stdio: 'inherit' });

  // Read the built files
  const shiroDistPath = path.join(shiroPath, 'dist');
  const indexHtml = fs.readFileSync(path.join(shiroDistPath, 'index.html'), 'utf-8');

  // Find and read the JS bundle
  const assetsDir = path.join(shiroDistPath, 'assets');
  const jsFiles = fs.readdirSync(assetsDir).filter(f => f.endsWith('.js'));
  const cssFiles = fs.readdirSync(assetsDir).filter(f => f.endsWith('.css'));

  let jsContent = '';
  for (const jsFile of jsFiles) {
    jsContent += fs.readFileSync(path.join(assetsDir, jsFile), 'utf-8') + '\n';
  }

  let cssContent = '';
  for (const cssFile of cssFiles) {
    cssContent += fs.readFileSync(path.join(assetsDir, cssFile), 'utf-8') + '\n';
  }

  // Create standalone HTML with inlined assets
  let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Shiro OS (Standalone)</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: #1a1a2e; }
    #terminal { width: 100%; height: 100%; padding: 4px; }
    .xterm { height: 100%; }
${cssContent}
  </style>
</head>
<body>
  <div id="terminal"></div>
  <script type="module">
${jsContent}
  </script>
</body>
</html>`;

  const outPath = path.join(distDir, 'shiro.html');
  fs.writeFileSync(outPath, html);
  console.log(`  ✓ Created ${outPath}`);
}

async function buildFoam() {
  console.log('Building Foam...');
  const foamPath = path.join(basePath, 'foam');

  // Initialize submodules if needed
  const fluffySubmodule = path.join(foamPath, 'fluffycoreutils', 'package.json');
  if (!fs.existsSync(fluffySubmodule)) {
    console.log('  Initializing git submodules...');
    execSync('git submodule update --init --recursive', { cwd: foamPath, stdio: 'inherit' });
  }

  // Build fluffycoreutils if needed
  const fluffyDist = path.join(foamPath, 'fluffycoreutils', 'dist');
  if (!fs.existsSync(fluffyDist)) {
    console.log('  Building fluffycoreutils...');
    const fluffyPath = path.join(foamPath, 'fluffycoreutils');
    if (!fs.existsSync(path.join(fluffyPath, 'node_modules'))) {
      execSync('npm install', { cwd: fluffyPath, stdio: 'inherit' });
    }
    execSync('npm run build', { cwd: fluffyPath, stdio: 'inherit' });
  }

  // Create a temporary entry point that imports everything
  const entryContent = `
import VFS from './src/vfs.js';
import Shell from './src/shell.js';
import Terminal from './src/terminal.js';
import ClaudeClient from './src/claude.js';
// Skip spirit for standalone - requires network
// import { SpiritAgent, FoamProvider } from './spirit/dist/spirit.js';
import { registerFluffyCommands } from './src/fluffy-bridge.js';
import './src/devtools.js';

async function boot() {
  const vfs = new VFS();
  await vfs.init();
  registerFluffyCommands();
  const shell = new Shell(vfs);
  const container = document.getElementById('terminal');
  const terminal = new Terminal(container, shell);
  const claude = new ClaudeClient(shell, terminal);
  terminal.claudeClient = claude;
  terminal.onConfigChange = () => {
    claude.setApiKey(localStorage.getItem('foam_api_key') || '');
  };

  // Expose global for automation
  window.__foam = { vfs, shell, terminal, claude };
  window.dispatchEvent(new CustomEvent('foam:ready', { detail: window.__foam }));

  // Boot message
  terminal.write('\\x1b[36m╔═══════════════════════════════════════════════╗\\x1b[0m\\n');
  terminal.write('\\x1b[36m║\\x1b[0m   \\x1b[1;97mFoam OS\\x1b[0m \\x1b[95mv0.1.0\\x1b[0m (Standalone)              \\x1b[36m║\\x1b[0m\\n');
  terminal.write('\\x1b[36m║\\x1b[0m   \\x1b[92mBrowser-Native Virtual OS\\x1b[0m                 \\x1b[36m║\\x1b[0m\\n');
  terminal.write('\\x1b[36m║\\x1b[0m                                               \\x1b[36m║\\x1b[0m\\n');
  terminal.write('\\x1b[36m║\\x1b[0m   \\x1b[33mhelp\\x1b[0m        — list all commands             \\x1b[36m║\\x1b[0m\\n');
  terminal.write('\\x1b[36m║\\x1b[0m   \\x1b[33mupload\\x1b[0m      — upload files from host        \\x1b[36m║\\x1b[0m\\n');
  terminal.write('\\x1b[36m║\\x1b[0m   \\x1b[33mdownload\\x1b[0m    — download files to host        \\x1b[36m║\\x1b[0m\\n');
  terminal.write('\\x1b[36m╚═══════════════════════════════════════════════╝\\x1b[0m\\n');
  terminal.write('\\n');
}

boot().catch(err => {
  document.body.textContent = 'Boot failed: ' + err.message;
  console.error(err);
});
`;

  const entryPath = path.join(foamPath, '_standalone-entry.js');
  fs.writeFileSync(entryPath, entryContent);

  try {
    // Bundle with esbuild
    console.log('  Bundling with esbuild...');
    const result = await esbuild.build({
      entryPoints: [entryPath],
      bundle: true,
      format: 'esm',
      target: 'es2022',
      write: false,
      minify: false,
      sourcemap: false,
      // Handle external deps that won't work standalone
      external: ['./spirit/dist/spirit.js'],
    });

    const jsContent = result.outputFiles[0].text;

    // Read CSS
    const cssContent = fs.readFileSync(path.join(foamPath, 'style.css'), 'utf-8');

    // Create standalone HTML
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Foam OS (Standalone)</title>
  <style>
${cssContent}
  </style>
</head>
<body>
  <div id="terminal"></div>
  <script type="module">
${jsContent}
  </script>
</body>
</html>`;

    const outPath = path.join(distDir, 'foam.html');
    fs.writeFileSync(outPath, html);
    console.log(`  ✓ Created ${outPath}`);
  } finally {
    // Clean up temp entry file
    fs.unlinkSync(entryPath);
  }
}

async function main() {
  console.log('Building standalone HTML files...\n');

  try {
    await buildShiro();
  } catch (err) {
    console.error('Failed to build Shiro:', err.message);
  }

  console.log('');

  try {
    await buildFoam();
  } catch (err) {
    console.error('Failed to build Foam:', err.message);
  }

  console.log('\nDone! Files are in dist/');
  console.log('Open them directly in a browser (file:// protocol works)');
}

main();
