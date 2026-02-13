const { registerTool, hasTool } = require(".");

const STUB_TOOLS = [
  {
    name: "fs_read",
    description: "Read file contents from the active workspace.",
  },
  {
    name: "fs_write",
    description: "Write or create files within the active workspace.",
  },
  {
    name: "edit_patch",
    description: "Apply unified diff patches to workspace files.",
  },
  {
    name: "shell",
    description: "Execute shell commands inside the workspace sandbox.",
  },
  {
    name: "python_exec",
    description: "Run Python snippets in the managed runtime.",
  },
  {
    name: "web_search",
    description: "Perform a web search and return summarized results.",
  },
];

function createStubHandler(name, description) {
  return async ({ args }) => ({
    ok: false,
    status: 501,
    content: {
      error: "tool_not_implemented",
      tool: name,
      description,
      input: args,
      hint: "This is a stub tool. Implement a real handler to enable this capability.",
    },
  });
}

function askUserQuestionHandler({ args }) {
  let questions = args?.questions ?? [];

  if (typeof questions === "string") {
    try { questions = JSON.parse(questions); } catch { questions = []; }
  }

  if (!Array.isArray(questions)) questions = [questions];
  const lines = questions.map((q, i) => {
    const header = q.header ? `[${q.header}] ` : "";
    const opts = (q.options ?? [])
      .map((o, j) => `  ${j + 1}. ${o.label} — ${o.description}`)
      .join("\n");
    return `${header}${q.question}\n${opts}`;
  });

  return {
    ok: true,
    status: 200,
    content: lines.join("\n\n"),
  };
}

function registerStubTools() {
  STUB_TOOLS.forEach((tool) => {
    if (!hasTool(tool.name)) {
      registerTool(tool.name, createStubHandler(tool.name, tool.description), tool);
    }
  });

  if (!hasTool("AskUserQuestion")) {
    registerTool("AskUserQuestion", askUserQuestionHandler, {
      description: "Returns the model's question to the user as assistant output.",
    });
  }
}

module.exports = {
  STUB_TOOLS,
  registerStubTools,
};
