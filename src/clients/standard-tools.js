/**
 * Standard tool definitions for Claude Code
 * These tools are injected when the client doesn't send tools in passthrough mode
 */

const STANDARD_TOOLS = [
  {
    name: "Write",
    description: "Writes a file to the local filesystem. Overwrites existing files. ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.",
    input_schema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Relative path within workspace (e.g., 'hello.cpp', 'src/main.py'). DO NOT use absolute paths."
        },
        content: {
          type: "string",
          description: "The content to write to the file"
        }
      },
      required: ["file_path", "content"]
    }
  },
  {
    name: "Read",
    description: "Reads a file from the local filesystem. You can access any file directly by using this tool. For files outside the workspace, the user must approve access first.",
    input_schema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the file. Use relative paths for workspace files (e.g., 'src/index.ts'). For files outside the workspace use absolute paths or ~ for the home directory (e.g., '~/Documents/notes.md', '/etc/hosts'). Each call reads ONE file only — do not pass multiple paths."
        },
        user_approved: {
          type: "boolean",
          description: "Set to true ONLY after the user has explicitly approved reading a file outside the workspace. Never set this to true without asking the user first."
        },
        limit: {
          type: "number",
          description: "The number of lines to read. Only provide if the file is too large to read at once."
        },
        offset: {
          type: "number",
          description: "The line number to start reading from. Only provide if the file is too large to read at once"
        }
      },
      required: ["file_path"]
    }
  },
  {
    name: "Edit",
    description: "Performs exact string replacements in files. You must use your Read tool at least once before editing. The edit will FAIL if old_string is not unique in the file.",
    input_schema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Relative path within workspace (e.g., 'app.py', 'src/utils.js'). DO NOT use absolute paths."
        },
        old_string: {
          type: "string",
          description: "The text to replace"
        },
        new_string: {
          type: "string",
          description: "The text to replace it with (must be different from old_string)"
        },
        replace_all: {
          type: "boolean",
          description: "Replace all occurences of old_string (default false)"
        }
      },
      required: ["file_path", "old_string", "new_string"]
    }
  },
  {
    name: "Bash",
    description: "Executes a bash command in a persistent shell session. Use for terminal operations like git, npm, docker, listing files (ls), etc. PREFERRED for listing directory contents - use 'ls' command. DO NOT use for reading file contents - use Read tool instead.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The command to execute"
        },
        description: {
          type: "string",
          description: "Clear, concise description of what this command does in 5-10 words"
        },
        timeout: {
          type: "number",
          description: "Optional timeout in milliseconds (max 600000)"
        }
      },
      required: ["command"]
    }
  },
  {
    name: "Glob",
    description: "File pattern matching for finding files by name pattern. Use ONLY when you need to find files matching a specific pattern like '**/*.js'. For simple directory listing, use Bash with 'ls' instead.",
    input_schema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "The glob pattern to match files against"
        },
        path: {
          type: "string",
          description: "The directory to search in. If not specified, the current working directory will be used."
        }
      },
      required: ["pattern"]
    }
  },
  {
    name: "Grep",
    description: "A powerful search tool built on ripgrep. Supports full regex syntax. Filter files with glob parameter or type parameter.",
    input_schema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "The regular expression pattern to search for in file contents"
        },
        path: {
          type: "string",
          description: "File or directory to search in. Defaults to current working directory."
        },
        glob: {
          type: "string",
          description: "Glob pattern to filter files (e.g. '*.js', '*.{ts,tsx}')"
        },
        output_mode: {
          type: "string",
          enum: ["content", "files_with_matches", "count"],
          description: "Output mode: 'content' shows matching lines, 'files_with_matches' shows file paths, 'count' shows match counts"
        },
        "-i": {
          type: "boolean",
          description: "Case insensitive search"
        }
      },
      required: ["pattern"]
    }
  },
  {
    name: "TodoWrite",
    description: "Create and manage a structured task list for tracking progress and organizing complex tasks. Use proactively for multi-step tasks or when user provides multiple tasks.",
    input_schema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "Array of todo items with status tracking",
          items: {
            type: "object",
            properties: {
              content: {
                type: "string",
                description: "Task description in imperative form (e.g., 'Run tests', 'Build project')"
              },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
                description: "Task status: pending (not started), in_progress (currently working), completed (finished)"
              },
              activeForm: {
                type: "string",
                description: "Present continuous form shown during execution (e.g., 'Running tests', 'Building project')"
              }
            },
            required: ["content", "status", "activeForm"]
          }
        }
      },
      required: ["todos"]
    }
  },
  {
    name: "Task",
    description: `Launch a specialized agent to handle complex, multi-step tasks autonomously.

YOU MUST USE THIS TOOL WHEN the user asks to:
- "explore", "dig into", "understand", or "analyze" a codebase → use subagent_type="Explore"
- "plan", "design", or "architect" something → use subagent_type="Plan"
- perform complex multi-file research or investigation → use subagent_type="general-purpose"

AVAILABLE AGENTS:
- Explore: Fast codebase exploration using Glob, Grep, Read. Use for searching, finding files, understanding project structure.
- Plan: Implementation planning and architecture design. Use for planning features or refactoring.
- general-purpose: Complex multi-step tasks with all tools available.

EXAMPLE: User says "explore this project" → Call Task with subagent_type="Explore", prompt="Explore the codebase structure, find main entry points, read key files, and summarize what this project does"`,
    input_schema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "A short (3-5 word) description of the task, e.g., 'Explore project structure'"
        },
        prompt: {
          type: "string",
          description: "Detailed instructions for the agent. Be specific about what to find, read, or analyze."
        },
        subagent_type: {
          type: "string",
          enum: ["general-purpose", "Explore", "Plan", "claude-code-guide"],
          description: "Agent type: Explore (search/read codebase), Plan (design/architecture), general-purpose (complex research)"
        },
        model: {
          type: "string",
          enum: ["sonnet", "opus", "haiku"],
          description: "Optional model override. Default is appropriate for each agent type."
        }
      },
      required: ["description", "prompt", "subagent_type"]
    }
  },
  {
    name: "AskUserQuestion",
    description: "Ask the user questions to gather preferences, clarify requirements, or get decisions on implementation choices. Supports multiple choice questions.",
    input_schema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "Questions to ask the user (1-4 questions)",
          minItems: 1,
          maxItems: 4,
          items: {
            type: "object",
            properties: {
              question: {
                type: "string",
                description: "The complete question to ask. Should be clear, specific, and end with a question mark."
              },
              header: {
                type: "string",
                description: "Very short label (max 12 chars). Examples: 'Auth method', 'Library', 'Approach'"
              },
              options: {
                type: "array",
                description: "Available choices (2-4 options). Each should be distinct and mutually exclusive.",
                minItems: 2,
                maxItems: 4,
                items: {
                  type: "object",
                  properties: {
                    label: {
                      type: "string",
                      description: "Display text for this option (1-5 words)"
                    },
                    description: {
                      type: "string",
                      description: "Explanation of what this option means or implications"
                    }
                  },
                  required: ["label", "description"]
                }
              },
              multiSelect: {
                type: "boolean",
                description: "Set to true to allow multiple selections instead of just one"
              }
            },
            required: ["question", "header", "options", "multiSelect"]
          }
        }
      },
      required: ["questions"]
    }
  },
  {
    name: "WebSearch",
    description: "Search the web for current information beyond the model's knowledge cutoff. Returns search results that can inform responses. Always include sources in your response.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query to use",
          minLength: 2
        },
        allowed_domains: {
          type: "array",
          description: "Only include search results from these domains",
          items: {
            type: "string"
          }
        },
        blocked_domains: {
          type: "array",
          description: "Never include search results from these domains",
          items: {
            type: "string"
          }
        }
      },
      required: ["query"]
    }
  },
  {
    name: "WebFetch",
    description: "Fetches content from a specified URL and processes it using AI. Takes a URL and a prompt describing what information to extract from the page.",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to fetch content from (must be fully-formed valid URL)",
          format: "uri"
        },
        prompt: {
          type: "string",
          description: "The prompt describing what information you want to extract from the page"
        }
      },
      required: ["url", "prompt"]
    }
  },
  {
    name: "NotebookEdit",
    description: "Completely replaces the contents of a specific cell in a Jupyter notebook (.ipynb file). Use for editing interactive documents that combine code, text, and visualizations.",
    input_schema: {
      type: "object",
      properties: {
        notebook_path: {
          type: "string",
          description: "Relative path to the Jupyter notebook within workspace (e.g., 'analysis.ipynb', 'notebooks/data.ipynb'). DO NOT use absolute paths."
        },
        new_source: {
          type: "string",
          description: "The new source for the cell"
        },
        cell_id: {
          type: "string",
          description: "The ID of the cell to edit. When inserting, new cell will be inserted after this cell."
        },
        cell_type: {
          type: "string",
          enum: ["code", "markdown"],
          description: "The type of the cell. Required when using edit_mode=insert."
        },
        edit_mode: {
          type: "string",
          enum: ["replace", "insert", "delete"],
          description: "The type of edit to make. Defaults to replace."
        }
      },
      required: ["notebook_path", "new_source"]
    }
  }
];

// Pre-computed name list to avoid re-mapping on every log call
const STANDARD_TOOL_NAMES = STANDARD_TOOLS.map(t => t.name);

module.exports = { STANDARD_TOOLS, STANDARD_TOOL_NAMES };
