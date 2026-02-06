const {
  readFile,
  writeFile,
  applyFilePatch,
  resolveWorkspacePath,
  fileExists,
  workspaceRoot,
} = require("../workspace");
const { recordEdit } = require("../edits");
const { registerTool } = require(".");
const logger = require("../logger");

function validateString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function normalizeEncoding(value) {
  if (!value) return "utf8";
  const encoding = value.toLowerCase();
  if (!["utf8", "utf-8"].includes(encoding)) {
    throw new Error(`Unsupported encoding: ${value}`);
  }
  return "utf8";
}

function registerWorkspaceTools() {
  registerTool(
    "fs_read",
    async ({ args = {} }) => {
      const relativePath = validateString(args.path ?? args.file ?? args.file_path, "path");
      const encoding = normalizeEncoding(args.encoding);
      const content = await readFile(relativePath, encoding);
      return {
        ok: true,
        status: 200,
        content,
        metadata: {
          path: relativePath,
          encoding,
          resolved_path: resolveWorkspacePath(relativePath),
        },
      };
    },
    { category: "workspace" },
  );

  registerTool(
    "fs_write",
    async ({ args = {} }, context = {}) => {
      const relativePath = validateString(
        args.path ??
          args.file ??
          args.file_path ??
          args.filePath ??
          args.filename ??
          args.name,
        "path",
      );
      const encoding = normalizeEncoding(args.encoding);
      const content =
        typeof args.content === "string"
          ? args.content
          : typeof args.contents === "string"
          ? args.contents
          : "";
      const createParents = args.create_parents !== false;

      const writeResult = await writeFile(relativePath, content, {
        encoding,
        createParents,
      });

      try {
        recordEdit({
          sessionId: context.session?.id ?? context.sessionId ?? null,
          filePath: relativePath,
          source: "fs_write",
          beforeContent:
            typeof writeResult.previousContent === "string"
              ? writeResult.previousContent
              : writeResult.previousContent ?? null,
          afterContent: content,
          metadata: {
            encoding,
          },
        });
      } catch (err) {
        logger.warn({ err }, "Failed to record fs_write edit");
      }

      return {
        ok: true,
        status: 200,
        content: JSON.stringify(
          {
            path: relativePath,
            bytes: Buffer.byteLength(content, encoding),
            resolved_path: resolveWorkspacePath(relativePath),
          },
          null,
          2,
        ),
        metadata: {
          path: relativePath,
        },
      };
    },
    { category: "workspace" },
  );

  registerTool(
    "edit_patch",
    async ({ args = {} }, context = {}) => {
      const relativePath = validateString(args.path ?? args.file ?? args.file_path, "path");
      const patch = validateString(args.patch, "patch");
      const encoding = normalizeEncoding(args.encoding);

      const exists = await fileExists(relativePath);
      if (!exists) {
        throw new Error("Cannot apply patch to non-existent file.");
      }

      const patchResult = await applyFilePatch(relativePath, patch, { encoding });

      try {
        recordEdit({
          sessionId: context.session?.id ?? context.sessionId ?? null,
          filePath: relativePath,
          source: "edit_patch",
          beforeContent:
            typeof patchResult.previousContent === "string"
              ? patchResult.previousContent
              : patchResult.previousContent ?? null,
          afterContent:
            typeof patchResult.nextContent === "string"
              ? patchResult.nextContent
              : patchResult.nextContent ?? null,
          metadata: {
            encoding,
            patchLength: patch.length,
          },
        });
      } catch (err) {
        logger.warn({ err }, "Failed to record edit_patch edit");
      }

      return {
        ok: true,
        status: 200,
        content: JSON.stringify(
          {
            path: relativePath,
            resolved_path: resolveWorkspacePath(relativePath),
          },
          null,
          2,
        ),
        metadata: {
          path: relativePath,
        },
      };
    },
    { category: "workspace" },
  );
}

module.exports = {
  workspaceRoot,
  registerWorkspaceTools,
};
