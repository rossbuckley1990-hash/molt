import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { TOOLS } from "../src/index.ts";

test("vendored RightClick X files match pinned upstream SHA-256 manifest byte-for-byte", () => {
  const vendorRoot = path.resolve(import.meta.dirname, "../vendor/rightclick-x");
  const manifest = JSON.parse(fs.readFileSync(path.join(vendorRoot, "UPSTREAM.json"), "utf8")) as {
    commit: string;
    modified: string[];
    files: Record<string, string>;
  };

  assert.equal(manifest.modified.length, 0, "upstream RightClick X files must remain unmodified");
  const entries = Object.entries(manifest.files);
  assert.ok(entries.length >= 60, "expected full RightClick X source tree");

  for (const [relPath, expectedSha] of entries) {
    const fullPath = path.join(vendorRoot, relPath);
    assert.ok(fs.existsSync(fullPath), `missing vendored file: ${relPath}`);
    const actualSha = crypto.createHash("sha256").update(fs.readFileSync(fullPath)).digest("hex");
    assert.equal(actualSha, expectedSha, `SHA-256 mismatch in vendored file: ${relPath}`);
  }
});

test("model-facing cognitive surface stays frozen at exactly 13 context_* tools", () => {
  assert.equal(TOOLS.length, 13);
  for (const tool of TOOLS) {
    assert.match(tool.name, /^context_/);
  }
});
