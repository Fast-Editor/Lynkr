const logger = require("../logger");

// Lazy load heavy dependencies
let Parser = null;
let JavaScript = null;
let TypeScript = null;
let TSX = null;
let Python = null;
let treeSitterAvailable = null; // null = not checked, true/false = result

function isTreeSitterAvailable() {
  if (treeSitterAvailable !== null) {
    return treeSitterAvailable;
  }
  try {
    require.resolve("tree-sitter");
    treeSitterAvailable = true;
    logger.info("[Parser] tree-sitter available");
  } catch {
    treeSitterAvailable = false;
    logger.info("[Parser] tree-sitter not available - using babel fallback for JS/TS (Python parsing disabled)");
  }
  return treeSitterAvailable;
}

function getTreeSitterParser() {
  if (!isTreeSitterAvailable()) {
    return null;
  }
  if (!Parser) {
    try {
      Parser = require("tree-sitter");
    } catch (err) {
      logger.warn({ err: err.message }, "[Parser] Failed to load tree-sitter");
      treeSitterAvailable = false;
      return null;
    }
  }
  return Parser;
}

function getLanguageModule(language) {
  if (!isTreeSitterAvailable()) {
    return null;
  }
  try {
    switch (language) {
      case "javascript":
      case "javascript-react":
        if (!JavaScript) {
          JavaScript = require("tree-sitter-javascript");
        }
        return JavaScript;
      case "typescript":
        if (!TypeScript) {
          const ts = require("tree-sitter-typescript");
          TypeScript = ts.typescript;
        }
        return TypeScript;
      case "typescript-react":
        if (!TSX) {
          const ts = require("tree-sitter-typescript");
          TSX = ts.tsx;
        }
        return TSX;
      case "python":
        if (!Python) {
          Python = require("tree-sitter-python");
        }
        return Python;
      default:
        return null;
    }
  } catch (err) {
    logger.warn({ err: err.message, language }, "[Parser] Failed to load language module");
    return null;
  }
}

const parserCache = {};

const LANGUAGE_MAP = {
  javascript: { getLanguage: () => getLanguageModule("javascript"), type: "javascript" },
  "javascript-react": { getLanguage: () => getLanguageModule("javascript-react"), type: "javascript" },
  typescript: { getLanguage: () => getLanguageModule("typescript"), type: "typescript" },
  "typescript-react": { getLanguage: () => getLanguageModule("typescript-react"), type: "typescript" },
  python: { getLanguage: () => getLanguageModule("python"), type: "python" },
};

function getParser(languageKey) {
  if (!isTreeSitterAvailable()) {
    return null;
  }
  const entry = LANGUAGE_MAP[languageKey];
  if (!entry) return null;
  if (!parserCache[languageKey]) {
    const ParserClass = getTreeSitterParser();
    if (!ParserClass) return null;
    const parser = new ParserClass();
    const language = entry.getLanguage();
    if (!language) return null;
    parser.setLanguage(language);
    parserCache[languageKey] = parser;
  }
  return parserCache[languageKey];
}

function nodeText(node, source) {
  return source.slice(node.startIndex, node.endIndex);
}

function positionOf(node) {
  return {
    line: node.startPosition.row + 1,
    column: node.startPosition.column + 1,
  };
}

function identifierName(node, source) {
  if (!node) return null;
  if (node.type === "identifier" || node.type === "property_identifier") {
    return nodeText(node, source);
  }
  return null;
}

function extractJavaScript(tree, source) {
  const symbols = [];
  const dependencies = [];
  const references = [];
  const imports = [];
  const exports = [];

  const registerReference = (nameNode, refNode) => {
    if (!nameNode || !refNode) return;
    const name = identifierName(nameNode, source);
    if (!name) return;
    references.push({
      name,
      line: refNode.startPosition.row + 1,
      column: refNode.startPosition.column + 1,
      snippet: nodeText(refNode, source),
    });
  };

  const visit = (node) => {
    switch (node.type) {
      case "function_declaration": {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          symbols.push({
            name: nodeText(nameNode, source),
            kind: "function",
            ...positionOf(nameNode),
          });
        }
        break;
      }
      case "class_declaration": {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          symbols.push({
            name: nodeText(nameNode, source),
            kind: "class",
            ...positionOf(nameNode),
          });
        }
        break;
      }
      case "method_definition": {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          symbols.push({
            name: nodeText(nameNode, source),
            kind: "method",
            ...positionOf(nameNode),
          });
        }
        break;
      }
      case "arrow_function": {
        const parent = node.parent;
        if (parent && parent.type === "variable_declarator") {
          const nameNode = parent.childForFieldName("name");
          if (nameNode) {
            symbols.push({
              name: nodeText(nameNode, source),
              kind: "function",
              ...positionOf(nameNode),
            });
          }
        }
        break;
      }
      case "identifier": {
        registerReference(node, node);
        break;
      }
      case "import_statement": {
        const sourceNode = node.childForFieldName("source");
        if (sourceNode) {
          const importPath = nodeText(sourceNode, source).replace(/['"]/g, "");
          dependencies.push({
            kind: "import",
            path: importPath,
            metadata: {
              clause: nodeText(node, source),
            },
          });
          imports.push({
            path: importPath,
            clause: nodeText(node, source),
            line: sourceNode.startPosition.row + 1,
            column: sourceNode.startPosition.column + 1,
          });
        }
        break;
      }
      case "call_expression": {
        const funcNode = node.child(0);
        if (funcNode && funcNode.type === "identifier" && nodeText(funcNode, source) === "require") {
          const argsNode = node.child(1);
          if (argsNode && argsNode.firstChild) {
            const required = nodeText(argsNode.firstChild, source).replace(/['"]/g, "");
            dependencies.push({
              kind: "require",
              path: required,
              metadata: {
                clause: nodeText(node, source),
              },
            });
            imports.push({
              path: required,
              clause: nodeText(node, source),
              line: node.startPosition.row + 1,
              column: node.startPosition.column + 1,
            });
          }
        }
        break;
      }
      case "export_statement":
      case "export_clause":
      case "export_default_declaration": {
        exports.push({
          clause: nodeText(node, source),
          line: node.startPosition.row + 1,
          column: node.startPosition.column + 1,
        });
        break;
      }
      default:
        break;
    }
    for (const child of node.children) {
      visit(child);
    }
  };

  visit(tree.rootNode);
  return {
    symbols,
    dependencies,
    references,
    imports,
    exports,
  };
}

function extractPython(tree, source) {
  const symbols = [];
  const dependencies = [];
  const references = [];
  const imports = [];

  const registerReference = (nameNode) => {
    if (!nameNode) return;
    const name = nodeText(nameNode, source);
    if (!name) return;
    references.push({
      name,
      line: nameNode.startPosition.row + 1,
      column: nameNode.startPosition.column + 1,
      snippet: nodeText(nameNode, source),
    });
  };

  const visit = (node) => {
    switch (node.type) {
      case "function_definition": {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          symbols.push({
            name: nodeText(nameNode, source),
            kind: "function",
            ...positionOf(nameNode),
          });
        }
        break;
      }
      case "class_definition": {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          symbols.push({
            name: nodeText(nameNode, source),
            kind: "class",
            ...positionOf(nameNode),
          });
        }
        break;
      }
      case "import_statement": {
        const moduleNode = node.childForFieldName("module");
        if (moduleNode) {
          dependencies.push({
            kind: "import",
            path: nodeText(moduleNode, source),
            metadata: {
              clause: nodeText(node, source),
            },
          });
        }
        break;
      }
      case "import_from_statement": {
        const moduleNode = node.childForFieldName("module");
        if (moduleNode) {
          dependencies.push({
            kind: "import_from",
            path: nodeText(moduleNode, source),
            metadata: {
              clause: nodeText(node, source),
            },
          });
        }
        break;
      }
      case "call": // older parser versions
      case "function_call": {
        const nameNode =
          node.childForFieldName("name") ??
          node.namedChildren?.find((child) => child.type === "identifier") ??
          node.child(0);
        registerReference(nameNode);
        break;
      }
      case "identifier": {
        registerReference(node);
        break;
      }
      default:
        break;
    }
    for (const child of node.children) {
      visit(child);
    }
  };

  visit(tree.rootNode);
  return {
    symbols,
    dependencies,
    references,
    imports,
    exports: [],
  };
}

function parseFile(relativePath, content, language) {
  // Try tree-sitter first (faster, more accurate)
  const parser = getParser(language);
  if (parser) {
    try {
      const tree = parser.parse(content);
      const langType = LANGUAGE_MAP[language]?.type;
      if (langType === "javascript" || langType === "typescript") {
        const analysis = extractJavaScript(tree, content);
        return {
          ...analysis,
          language: langType,
          definitions: analysis.symbols,
          parser: "tree-sitter",
        };
      }
      if (langType === "python") {
        const analysis = extractPython(tree, content);
        return {
          ...analysis,
          language: langType,
          definitions: analysis.symbols,
          parser: "tree-sitter",
        };
      }
    } catch (err) {
      logger.warn({ err, file: relativePath, language }, "Tree-sitter parse failed, trying babel fallback");
    }
  }

  // Fallback to Babel parser for JS/TS (pure JS, no native modules)
  const langType = LANGUAGE_MAP[language]?.type;
  if (langType === "javascript" || langType === "typescript") {
    try {
      const babelParser = require("./babel-parser");
      const result = babelParser.parseFile(relativePath, content, language);
      if (result) {
        logger.debug({ file: relativePath, parser: "babel" }, "Parsed with babel fallback");
        return result;
      }
    } catch (err) {
      logger.debug({ err: err.message }, "Babel parser fallback not available");
    }
  }

  return null;
}

/**
 * Get info about available parsers
 */
function getParserInfo() {
  const treeSitter = isTreeSitterAvailable();
  let babel = false;
  try {
    const babelParser = require("./babel-parser");
    babel = babelParser.isBabelAvailable();
  } catch {
    babel = false;
  }
  return {
    treeSitter,
    babel,
    jsTs: treeSitter || babel,  // JS/TS parsing available
    python: treeSitter,          // Python only via tree-sitter
  };
}

module.exports = {
  parseFile,
  LANGUAGE_MAP,
  getParser,
  isTreeSitterAvailable,
  getParserInfo,
};
