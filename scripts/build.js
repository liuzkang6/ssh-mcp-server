#!/usr/bin/env node

import { execSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, "..");
const buildFile = join(rootDir, "build", "index.js");
const cliFile = join(rootDir, "packages", "cli", "dist", "index.js");
const legacyCliFile = join(rootDir, "build", "cli-tool", "index.js");

// Build server (root)
console.log("Building server TypeScript...");
execSync("tsc", { stdio: "inherit", cwd: rootDir });

// Build CLI subpackage (Phase 7 monorepo)
const cliDir = join(rootDir, "packages", "cli");
if (existsSync(join(cliDir, "tsconfig.json"))) {
  console.log("Building CLI subpackage (@platform/cli)...");
  execSync("tsc -p tsconfig.json", { stdio: "inherit", cwd: cliDir });
}

// Make executable on Unix-like systems
if (process.platform !== "win32") {
  for (const f of [buildFile, cliFile, legacyCliFile]) {
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
