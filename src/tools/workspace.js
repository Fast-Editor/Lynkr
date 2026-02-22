const path = require("path");
const fsp = require("fs/promises");
const {
  readFile,
  writeFile,
  applyFilePatch,
  resolveWorkspacePath,
  expandTilde,
  isExternalPath,
  readExternalFile,
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
      const targetPath = validateString(args.path ?? args.file ?? args.file_path, "path");
      const encoding = normalizeEncoding(args.encoding);

      // Check if path is outside workspace
      if (isExternalPath(targetPath)) {
        if (args.user_approved !== true) {
          const expanded = expandTilde(targetPath);
          const resolved = path.resolve(expanded);
          return {
            ok: true,
            status: 200,
            content: `[APPROVAL REQUIRED] The file "${resolved}" is outside the workspace and cannot be read without user permission.\n\nYou must now ask the user: "The file ${resolved} is outside the workspace. May I read it?"\n\nIf the user says yes, call the Read tool again with file_path="${targetPath}" and user_approved=true.`,
          };
        }
        // User approved — read external file
        const { content, resolvedPath } = await readExternalFile(targetPath, encoding);
        return {
          ok: true,
          status: 200,
          content,
          metadata: { path: targetPath, encoding, resolved_path: resolvedPath },
        };
      }

      // Normal workspace read (unchanged)
      const content = await readFile(targetPath, encoding);
      return {
        ok: true,
        status: 200,
        content,
        metadata: {
          path: targetPath,
          encoding,
          resolved_path: resolveWorkspacePath(targetPath),
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

      // Handle user_approved bypass for workspace access
      let writeResult;
      if (args.user_approved === true) {
        const expandedPath = expandTilde(relativePath);
        const resolvedPath = path.resolve(expandedPath);
        const dir = path.dirname(resolvedPath);
        if (createParents) {
          await fsp.mkdir(dir, { recursive: true });
        }
        let previousContent = null;
        try {
          previousContent = await fsp.readFile(resolvedPath, { encoding });
        } catch (err) {
          if (err.code !== "ENOENT") {
            throw err;
          }
        }
        await fsp.writeFile(resolvedPath, content, { encoding });
        writeResult = {
          resolvedPath,
          previousContent,
          nextContent: content,
        };
      } else {
        writeResult = await writeFile(relativePath, content, {
          encoding,
          createParents,
        });
      }

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
    "Edit",
    async ({ args = {} }, context = {}) => {
      const relativePath = validateString(args.file_path, "file_path");
      const oldString = validateString(args.old_string, "old_string");
      const newString = args.new_string; // Can be empty string
      const replaceAll = args.replace_all === true;
      const encoding = normalizeEncoding(args.encoding);

      if (typeof newString !== "string") {
        throw new Error("new_string must be a string");
      }

      if (oldString === newString) {
        throw new Error("old_string and new_string must be different");
      }

      // Handle user_approved bypass for workspace access - check if file exists
      let fileExistsResult;
      if (args.user_approved === true) {
        const expandedPath = expandTilde(relativePath);
        const resolvedPath = path.resolve(expandedPath);
        try {
          await fsp.access(resolvedPath);
          fileExistsResult = true;
        } catch {
          fileExistsResult = false;
        }
      } else {
        fileExistsResult = await fileExists(relativePath);
      }

      if (!fileExistsResult) {
        throw new Error("Cannot edit non-existent file. Use Write tool to create new files.");
      }

      // Read current content
      let beforeContent;
      if (args.user_approved === true) {
        const expandedPath = expandTilde(relativePath);
        const resolvedPath = path.resolve(expandedPath);
        beforeContent = await fsp.readFile(resolvedPath, { encoding });
      } else {
        beforeContent = await readFile(relativePath, encoding);
      }

      // Check if old_string exists in file
      if (!beforeContent.includes(oldString)) {
        throw new Error(`old_string not found in file: ${relativePath}`);
      }

      // Perform replacement
      let afterContent;
      if (replaceAll) {
        // Replace all occurrences
        afterContent = beforeContent.split(oldString).join(newString);
      } else {
        // Replace only first occurrence and check for uniqueness
        const firstIndex = beforeContent.indexOf(oldString);
        const secondIndex = beforeContent.indexOf(oldString, firstIndex + oldString.length);

        if (secondIndex !== -1) {
          throw new Error(
            "old_string appears multiple times in the file. " +
            "Either provide a larger string with more context to make it unique, " +
            "or use replace_all=true to replace all occurrences."
          );
        }

        afterContent = beforeContent.replace(oldString, newString);
      }

      // Write updated content
      if (args.user_approved === true) {
        const expandedPath = expandTilde(relativePath);
        const resolvedPath = path.resolve(expandedPath);
        await fsp.writeFile(resolvedPath, afterContent, { encoding });
      } else {
        await writeFile(relativePath, afterContent, { encoding });
      }

      // Record edit
      try {
        recordEdit({
          sessionId: context.session?.id ?? context.sessionId ?? null,
          filePath: relativePath,
          source: "Edit",
          beforeContent,
          afterContent,
          metadata: {
            encoding,
            oldStringLength: oldString.length,
            newStringLength: newString.length,
            replaceAll,
          },
        });
      } catch (err) {
        logger.warn({ err }, "Failed to record Edit edit");
      }

      return {
        ok: true,
        status: 200,
        content: JSON.stringify(
          {
            path: relativePath,
            resolved_path: resolveWorkspacePath(relativePath),
            replacements: replaceAll ? "all" : 1,
          },
          null,
          2,
        ),
        metadata: {
          path: relativePath,
          replacements: replaceAll ? "all" : 1,
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

      // Handle user_approved bypass for workspace access - check if file exists
      let fileExistsResult;
      if (args.user_approved === true) {
        const expandedPath = expandTilde(relativePath);
        const resolvedPath = path.resolve(expandedPath);
        try {
          await fsp.access(resolvedPath);
          fileExistsResult = true;
        } catch {
          fileExistsResult = false;
        }
      } else {
        fileExistsResult = await fileExists(relativePath);
      }

      if (!fileExistsResult) {
        throw new Error("Cannot apply patch to non-existent file.");
      }

      // Apply patch
      let patchResult;
      if (args.user_approved === true) {
        // Manual patch application for approved external path
        const { applyPatch } = require("diff");
        const expandedPath = expandTilde(relativePath);
        const resolvedPath = path.resolve(expandedPath);
        const original = await fsp.readFile(resolvedPath, { encoding });
        const patched = applyPatch(original, patch);
        if (patched === false) {
          throw new Error("Failed to apply patch.");
        }
        await fsp.writeFile(resolvedPath, patched, { encoding });
        patchResult = {
          resolvedPath,
          previousContent: original,
          nextContent: patched,
        };
      } else {
        patchResult = await applyFilePatch(relativePath, patch, { encoding });
      }

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
