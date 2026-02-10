/**
 * Babel-based Parser (Pure JS Fallback)
 *
 * Used when tree-sitter is unavailable (e.g., Node 25 without prebuilt binaries).
 * Supports JavaScript, TypeScript, JSX, and TSX.
 *
 * @module indexer/babel-parser
 */

const logger = require("../logger");

let babelParser = null;
let babelTraverse = null;

function loadBabel() {
  if (babelParser) return true;
  try {
    babelParser = require("@babel/parser");
    babelTraverse = require("@babel/traverse").default;
    return true;
  } catch (err) {
    logger.warn({ err: err.message }, "[BabelParser] Failed to load @babel/parser");
    return false;
  }
}

const LANGUAGE_TO_PLUGINS = {
  javascript: ["jsx"],
  "javascript-react": ["jsx"],
  typescript: ["typescript", "jsx"],
  "typescript-react": ["typescript", "jsx"],
};

/**
 * Parse JavaScript/TypeScript file using Babel
 */
function parseFile(relativePath, content, language) {
  if (!loadBabel()) return null;

  const plugins = LANGUAGE_TO_PLUGINS[language];
  if (!plugins) {
    logger.debug({ language }, "[BabelParser] Unsupported language");
    return null;
  }

  try {
    const ast = babelParser.parse(content, {
      sourceType: "unambiguous",
      plugins: [...plugins, "decorators-legacy", "classProperties", "dynamicImport"],
      errorRecovery: true,
    });

    const symbols = [];
    const dependencies = [];
    const imports = [];
    const exports = [];
    const references = [];

    babelTraverse(ast, {
      // Functions
      FunctionDeclaration(path) {
        if (path.node.id) {
          symbols.push({
            name: path.node.id.name,
            kind: "function",
            line: path.node.loc?.start.line || 1,
            column: (path.node.loc?.start.column || 0) + 1,
          });
        }
      },

      // Arrow functions assigned to variables
      VariableDeclarator(path) {
        if (
          path.node.init &&
          (path.node.init.type === "ArrowFunctionExpression" ||
            path.node.init.type === "FunctionExpression") &&
          path.node.id?.type === "Identifier"
        ) {
          symbols.push({
            name: path.node.id.name,
            kind: "function",
            line: path.node.loc?.start.line || 1,
            column: (path.node.loc?.start.column || 0) + 1,
          });
        }
      },

      // Classes
      ClassDeclaration(path) {
        if (path.node.id) {
          symbols.push({
            name: path.node.id.name,
            kind: "class",
            line: path.node.loc?.start.line || 1,
            column: (path.node.loc?.start.column || 0) + 1,
          });
        }
      },

      // Class methods
      ClassMethod(path) {
        if (path.node.key?.type === "Identifier") {
          symbols.push({
            name: path.node.key.name,
            kind: "method",
            line: path.node.loc?.start.line || 1,
            column: (path.node.loc?.start.column || 0) + 1,
          });
        }
      },

      // Import statements
      ImportDeclaration(path) {
        const importPath = path.node.source.value;
        dependencies.push({
          kind: "import",
          path: importPath,
          metadata: { clause: content.slice(path.node.start, path.node.end) },
        });
        imports.push({
          path: importPath,
          clause: content.slice(path.node.start, path.node.end),
          line: path.node.loc?.start.line || 1,
          column: (path.node.loc?.start.column || 0) + 1,
        });
      },

      // require() calls
      CallExpression(path) {
        if (
          path.node.callee?.type === "Identifier" &&
          path.node.callee.name === "require" &&
          path.node.arguments[0]?.type === "StringLiteral"
        ) {
          const reqPath = path.node.arguments[0].value;
          dependencies.push({
            kind: "require",
            path: reqPath,
            metadata: { clause: content.slice(path.node.start, path.node.end) },
          });
          imports.push({
            path: reqPath,
            clause: content.slice(path.node.start, path.node.end),
            line: path.node.loc?.start.line || 1,
            column: (path.node.loc?.start.column || 0) + 1,
          });
        }
      },

      // Exports
      ExportNamedDeclaration(path) {
        exports.push({
          clause: content.slice(path.node.start, path.node.end).substring(0, 200),
          line: path.node.loc?.start.line || 1,
          column: (path.node.loc?.start.column || 0) + 1,
        });
      },

      ExportDefaultDeclaration(path) {
        exports.push({
          clause: content.slice(path.node.start, path.node.end).substring(0, 200),
          line: path.node.loc?.start.line || 1,
          column: (path.node.loc?.start.column || 0) + 1,
        });
      },

      // Track identifiers for references (limited to avoid noise)
      Identifier(path) {
        // Only track identifiers in call expressions or member expressions
        if (
          path.parent?.type === "CallExpression" &&
          path.parent.callee === path.node
        ) {
          references.push({
            name: path.node.name,
            line: path.node.loc?.start.line || 1,
            column: (path.node.loc?.start.column || 0) + 1,
            snippet: path.node.name,
          });
        }
      },
    });

    const langType = language.includes("typescript") ? "typescript" : "javascript";

    return {
      symbols,
      dependencies,
      references,
      imports,
      exports,
      language: langType,
      definitions: symbols,
      parser: "babel",
    };
  } catch (err) {
    logger.warn({ err: err.message, file: relativePath }, "[BabelParser] Parse failed");
    return null;
  }
}

/**
 * Check if Babel parser is available
 */
function isBabelAvailable() {
  return loadBabel();
}

module.exports = {
  parseFile,
  isBabelAvailable,
};
