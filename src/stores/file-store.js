const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const logger = require("../logger");

const STORAGE_DIR = path.resolve(process.env.FILES_STORAGE_PATH || "./data/files");
const MAX_FILES = parseInt(process.env.FILES_MAX_COUNT || "1000", 10);

const metadata = new Map();

function ensureStorageDir() {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }
}

function storeFile(buffer, { filename, purpose, mimeType }) {
  ensureStorageDir();
  if (metadata.size >= MAX_FILES) {
    const oldest = metadata.keys().next().value;
    deleteFile(oldest);
  }
  const id = `file-${crypto.randomUUID()}`;
  const storagePath = path.join(STORAGE_DIR, id);
  fs.writeFileSync(storagePath, buffer);
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
  logger.info({ fileId: id, bytes: buffer.length, filename }, "File stored");
  return entry;
}

function getFile(id) {
  return metadata.get(id) || null;
}

function getFileContent(id) {
  const entry = metadata.get(id);
  if (!entry) return null;
  try {
    return fs.readFileSync(entry.storage_path);
  } catch {
    return null;
  }
}

function deleteFile(id) {
  const entry = metadata.get(id);
  if (!entry) return false;
  try { fs.unlinkSync(entry.storage_path); } catch {}
  metadata.delete(id);
  return true;
}

function listFiles({ purpose } = {}) {
  const files = Array.from(metadata.values());
  if (purpose) return files.filter((f) => f.purpose === purpose);
  return files;
}

module.exports = { storeFile, getFile, getFileContent, deleteFile, listFiles };
