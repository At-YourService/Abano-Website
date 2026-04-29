#!/usr/bin/env node
"use strict";

/**
 * patch-base-path.js
 *
 * Rewrites every root-relative path in all local HTML files so the site
 * works on GitHub Pages at https://at-yourservice.github.io/Abano-Website/
 *
 * Run once after export:  node scripts/patch-base-path.js
 * Undo / re-run export normally for www.abano.be (no prefix needed there).
 */

const fs   = require("fs-extra");
const path = require("path");

const ROOT      = path.resolve(".");
const BASE_PATH = "/Abano-Website";

// Folders that contain source code — never touch these
const SKIP_DIRS = new Set(["node_modules", ".git", "scripts", ".github"]);

// ─── Collect all HTML files ───────────────────────────────────────────────────

async function findHTML(dir, results = []) {
  for (const entry of await fs.readdir(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const stat = await fs.stat(full);
    if (stat.isDirectory()) {
      await findHTML(full, results);
    } else if (entry.endsWith(".html")) {
      results.push(full);
    }
  }
  return results;
}

// ─── Rewrite one HTML file ────────────────────────────────────────────────────

function patchHTML(html) {
  // Only rewrite paths that:
  //   • start with a single /  (root-relative)
  //   • are NOT already prefixed with BASE_PATH
  //   • are NOT protocol-relative (//)
  const PREFIX_RE = new RegExp(
    `((?:href|src|action|content)=["'])(?!${BASE_PATH})(?!//)(/)`,
    "g"
  );

  // Also fix CSS url() references in inline styles and <style> blocks
  const CSS_URL_RE = new RegExp(
    `(url\\(["']?)(?!${BASE_PATH})(?!//)(/)`,
    "g"
  );

  return html
    .replace(PREFIX_RE,   (_, attr, slash) => `${attr}${BASE_PATH}${slash}`)
    .replace(CSS_URL_RE,  (_, url,  slash) => `${url}${BASE_PATH}${slash}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Patching HTML files with base path: ${BASE_PATH}\n`);

  const files = await findHTML(ROOT);
  let count = 0;

  for (const file of files) {
    const original = await fs.readFile(file, "utf8");
    const patched  = patchHTML(original);

    if (patched !== original) {
      await fs.writeFile(file, patched, "utf8");
      console.log("  patched:", path.relative(ROOT, file));
      count++;
    }
  }

  console.log(`\nDone — ${count} file(s) updated out of ${files.length} total.`);
  console.log(`Now commit and push. Pages will be served at:`);
  console.log(`  https://at-yourservice.github.io${BASE_PATH}/`);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
