const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { applyPatch } = require("diff");
const config = require("../config");

const workspaceRoot = path.resolve(config.workspace.root);

if (!fs.existsSync(workspaceRoot)) {
  fs.mkdirSync(workspaceRoot, { recursive: true });
}

function expandTilde(targetPath) {
  if (typeof targetPath !== "string") return targetPath;
  if (targetPath.startsWith("~")) {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (home) {
      return path.join(home, targetPath.slice(1));
    }
  }
  return targetPath;
}

function isExternalPath(targetPath) {
  const expanded = expandTilde(targetPath);
  const resolved = path.resolve(workspaceRoot, expanded);
  return !resolved.startsWith(workspaceRoot);
}

async function readExternalFile(targetPath, encoding = "utf8") {
  const expanded = expandTilde(targetPath);
  const resolved = path.resolve(expanded);
  const stats = await fsp.stat(resolved);
  if (!stats.isFile()) {
    throw new Error("Requested path is not a file.");
  }
  return { content: await fsp.readFile(resolved, { encoding }), resolvedPath: resolved };
}

function resolveWorkspacePath(targetPath) {
  if (!targetPath || typeof targetPath !== "string") {
    throw new Error("Path must be a non-empty string.");
  }
  const resolved = path.resolve(workspaceRoot, targetPath);
  if (!resolved.startsWith(workspaceRoot)) {
    throw new Error("Access outside workspace is not permitted.");
  }
  return resolved;
}

async function readFile(targetPath, encoding = "utf8") {
  const resolved = resolveWorkspacePath(targetPath);
  const stats = await fsp.stat(resolved);
  if (!stats.isFile()) {
    throw new Error("Requested path is not a file.");
  }
  return fsp.readFile(resolved, { encoding });
}

async function writeFile(targetPath, content, options = {}) {
  const { encoding = "utf8", createParents = true, mode } = options;
  const resolved = resolveWorkspacePath(targetPath);
  const dir = path.dirname(resolved);
  if (createParents) {
    await fsp.mkdir(dir, { recursive: true });
  }

  let previousContent = null;
  try {
    previousContent = await fsp.readFile(resolved, { encoding });
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }

  await fsp.writeFile(resolved, content, { encoding, mode });
  return {
    resolvedPath: resolved,
    previousContent,
    nextContent: content,
  };
}

async function fileExists(targetPath) {
  try {
    const resolved = resolveWorkspacePath(targetPath);
    await fsp.access(resolved, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function applyFilePatch(targetPath, patchText, options = {}) {
  if (!patchText || typeof patchText !== "string") {
    throw new Error("Patch must be a non-empty string.");
  }

  const { encoding = "utf8" } = options;
  const resolved = resolveWorkspacePath(targetPath);
  const original = await fsp.readFile(resolved, { encoding });
  const patched = applyPatch(original, patchText);
  if (patched === false) {
    throw new Error("Failed to apply patch.");
  }
  await fsp.writeFile(resolved, patched, { encoding });
  return {
    resolvedPath: resolved,
    previousContent: original,
    nextContent: patched,
  };
}

/**
 * Validate a client-provided CWD path
 * @param {string} cwd - The path to validate
 * @returns {string|null} - Resolved absolute path if valid, null otherwise
 */
function validateCwd(cwd) {
  if (!cwd || typeof cwd !== "string") {
    return null;
  }

  try {
    const resolved = path.resolve(cwd);
    const stats = fs.statSync(resolved);
    if (!stats.isDirectory()) {
      return null;
    }
    return resolved;
  } catch {
    return null;
  }
}

module.exports = {
  workspaceRoot,
  resolveWorkspacePath,
  expandTilde,
  isExternalPath,
  readExternalFile,
  readFile,
  writeFile,
  fileExists,
  applyFilePatch,
  validateCwd,
};
