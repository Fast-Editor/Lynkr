const express = require("express");
const logger = require("../logger");
const fileStore = require("../stores/file-store");

const router = express.Router();

const MAX_FILE_SIZE = parseInt(process.env.FILES_MAX_SIZE_MB || "100", 10) * 1024 * 1024;

router.post("/files", async (req, res) => {
  try {
    const chunks = [];
    let totalSize = 0;
    for await (const chunk of req) {
      totalSize += chunk.length;
      if (totalSize > MAX_FILE_SIZE) {
        return res.status(413).json({ error: { message: `File exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit` } });
      }
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    const contentType = req.headers["content-type"] || "";
    let filename = "upload";
    let purpose = "assistants";
    let mimeType = "application/octet-stream";

    if (contentType.includes("multipart/form-data")) {
      const boundary = contentType.split("boundary=")[1];
      if (boundary) {
        const { parseMultipart } = require("./files-multipart");
        const parsed = parseMultipart(buffer, boundary);
        if (parsed.file) {
          filename = parsed.filename || filename;
          mimeType = parsed.mimeType || mimeType;
          purpose = parsed.purpose || purpose;
          const entry = fileStore.storeFile(parsed.file, { filename, purpose, mimeType });
          return res.json(entry);
        }
      }
    }

    // Raw body upload
    mimeType = contentType.split(";")[0].trim() || mimeType;
    filename = req.headers["x-filename"] || filename;
    purpose = req.query.purpose || purpose;
    const entry = fileStore.storeFile(buffer, { filename, purpose, mimeType });
    res.json(entry);
  } catch (err) {
    logger.error({ err }, "File upload failed");
    res.status(500).json({ error: { message: err.message } });
  }
});

router.get("/files", (req, res) => {
  const files = fileStore.listFiles({ purpose: req.query.purpose });
  res.json({ object: "list", data: files });
});

router.get("/files/:id", (req, res) => {
  const file = fileStore.getFile(req.params.id);
  if (!file) return res.status(404).json({ error: { message: "File not found" } });
  res.json(file);
});

router.get("/files/:id/content", (req, res) => {
  const file = fileStore.getFile(req.params.id);
  if (!file) return res.status(404).json({ error: { message: "File not found" } });
  const content = fileStore.getFileContent(req.params.id);
  if (!content) return res.status(404).json({ error: { message: "File content not found" } });
  res.setHeader("Content-Type", file.mime_type);
  res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
  res.send(content);
});

router.delete("/files/:id", (req, res) => {
  const deleted = fileStore.deleteFile(req.params.id);
  if (!deleted) return res.status(404).json({ error: { message: "File not found" } });
  res.json({ id: req.params.id, object: "file", deleted: true });
});

module.exports = router;
