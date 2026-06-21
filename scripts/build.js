#!/usr/bin/env node

import { execSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, "..");

const serverDir = join(rootDir, "packages", "server");
const cliDir = join(rootDir, "packages", "cli");
const webDir = join(rootDir, "packages", "web");

const serverEntry = join(serverDir, "dist", "index.js");
const cliEntry = join(cliDir, "dist", "index.js");
const webDistDir = join(rootDir, "web-dist");

// 使用 root hoisted 的 tsc(workspace 模式下共享 node_modules)
const tscBin = join(rootDir, "node_modules", ".bin", "tsc");

// 1) Build server (@platform/server)
console.log("Building server (@platform/server)...");
execSync(`"${tscBin}" -p tsconfig.json`, { stdio: "inherit", cwd: serverDir });

// 2) Build CLI (@platform/cli)
if (existsSync(join(cliDir, "tsconfig.json"))) {
  console.log("Building CLI (@platform/cli)...");
  execSync(`"${tscBin}" -p tsconfig.json`, { stdio: "inherit", cwd: cliDir });
}

// 3) Build web (Vite)
if (existsSync(join(webDir, "package.json"))) {
  console.log("Building web (@platform/web)...");
  execSync("npm run build", { stdio: "inherit", cwd: webDir });
}

// Make executables on Unix-like systems
if (process.platform !== "win32") {
  for (const f of [serverEntry, cliEntry]) {
    if (!existsSync(f)) continue;
    try {
      chmodSync(f, 0o755);
      console.log(`Made ${f} executable`);
    } catch (error) {
      console.warn(`Warning: Could not set executable permissions on ${f}:`, error.message);
    }
  }
} else {
  console.log("Skipping chmod on Windows");
}

console.log("Build complete!");
