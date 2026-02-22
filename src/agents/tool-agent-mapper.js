/**
 * Maps tool names from "Invoking tool(s):" text to appropriate subagent types.
 * Used when models (e.g. GLM-4.7) output tool invocations as plain text
 * instead of structured tool_calls — we auto-spawn a subagent to do the work.
 */

// Tool name → agent type mapping
// "general-purpose" agents can read AND write; "Explore" agents are read-only.
const TOOL_TO_AGENT = {
  Read: 'Explore',
  Grep: 'Explore',
  Glob: 'Explore',
  workspace_search: 'Explore',
  workspace_symbol_search: 'Explore',
  Edit: 'general-purpose',
  Write: 'general-purpose',
  Bash: 'general-purpose',
  // Unmapped tools default to 'Explore' (safe read-only fallback)
};

/**
 * Determine which agent type to spawn based on tool names the model mentioned.
 * Returns the "strongest" agent needed:
 *   - If ANY tool maps to 'general-purpose', return 'general-purpose'
 *   - Otherwise return 'Explore'
 *
 * @param {string[]} mentionedTools - e.g. ["Read", "Read", "Grep"]
 * @returns {string} Agent type name
 */
function mapToolsToAgentType(mentionedTools) {
  if (!Array.isArray(mentionedTools) || mentionedTools.length === 0) {
    return 'Explore'; // safe default
  }

  for (const tool of mentionedTools) {
    if (TOOL_TO_AGENT[tool] === 'general-purpose') {
      return 'general-purpose';
    }
  }

  return 'Explore';
}

/**
 * Build a task prompt for the subagent that will fulfil the model's intent.
 *
 * @param {string} userText  - The last user message (what they asked)
 * @param {string} modelText - The model's raw text response (includes "Invoking tool(s):…")
 * @param {string[]} mentionedTools - Parsed tool names from the model text
 * @returns {string} Prompt to pass to spawnAgent()
 */
function buildSubagentPrompt(userText, modelText, mentionedTools) {
  const toolList = [...new Set(mentionedTools)].join(', ');
  return [
    `The user asked:\n${userText}`,
    '',
    `The model intended to use these tools: ${toolList}`,
    '',
    'Complete this task using the tools listed above.',
    'Return a concise summary of your findings or actions.',
  ].join('\n');
}

module.exports = { mapToolsToAgentType, buildSubagentPrompt, TOOL_TO_AGENT };
