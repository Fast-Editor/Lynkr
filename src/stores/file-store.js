const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const crypto = require("crypto");
const logger = require("../logger");

const STORAGE_DIR = path.resolve(process.env.FILES_STORAGE_PATH || "./data/files");
const METADATA_FILE = path.join(STORAGE_DIR, "_metadata.json");
const MAX_FILES = parseInt(process.env.FILES_MAX_COUNT || "1000", 10);

const metadata = new Map();

function ensureStorageDir() {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }
}

function persistMetadata() {
  try {
    const entries = Array.from(metadata.values());
    fs.writeFileSync(METADATA_FILE, JSON.stringify(entries), "utf8");
  } catch (err) {
    logger.warn({ err: err.message }, "Failed to persist file metadata");
  }
}

function loadMetadata() {
  ensureStorageDir();
  try {
    if (!fs.existsSync(METADATA_FILE)) return;
    const entries = JSON.parse(fs.readFileSync(METADATA_FILE, "utf8"));
    for (const entry of entries) {
      // Only restore entries whose backing file still exists on disk
      if (fs.existsSync(entry.storage_path)) {
        metadata.set(entry.id, entry);
      } else {
        logger.debug({ fileId: entry.id }, "Dropping orphaned metadata entry (file missing)");
      }
    }
    logger.info({ count: metadata.size }, "File metadata restored from disk");
  } catch (err) {
    logger.warn({ err: err.message }, "Could not load file metadata; starting fresh");
  }
}

// Restore metadata at module load so restarts don't orphan files
loadMetadata();

async function storeFile(buffer, { filename, purpose, mimeType }) {
  ensureStorageDir();
  if (metadata.size >= MAX_FILES) {
    const oldest = metadata.keys().next().value;
    await deleteFile(oldest);
  }
  const id = `file-${crypto.randomUUID()}`;
  const storagePath = path.join(STORAGE_DIR, id);
  await fsp.writeFile(storagePath, buffer);
  const entry = {
    id,
    object: "file",
    filename: filename || "upload",
    purpose: purpose || "assistants",
    bytes: buffer.length,
    mime_type: mimeType || "application/octet-stream",
    created_at: Math.floor(Date.now() / 1000),
    storage_path: storagePath,
  };
  metadata.set(id, entry);
  persistMetadata();
  logger.info({ fileId: id, bytes: buffer.length, filename }, "File stored");
  return entry;
}

function getFile(id) {
  return metadata.get(id) || null;
}

async function getFileContent(id) {
  const entry = metadata.get(id);
  if (!entry) return null;
  try {
    return await fsp.readFile(entry.storage_path);
  } catch {
    return null;
  }
}

async function deleteFile(id) {
  const entry = metadata.get(id);
  if (!entry) return false;
  try { await fsp.unlink(entry.storage_path); } catch {}
  metadata.delete(id);
  persistMetadata();
  return true;
}

function listFiles({ purpose } = {}) {
  const files = Array.from(metadata.values());
  if (purpose) return files.filter((f) => f.purpose === purpose);
  return files;
}

module.exports = { storeFile, getFile, getFileContent, deleteFile, listFiles };
