#!/bin/bash

# Test parallel subagent execution
# This simulates a main agent spawning multiple Task tools in one response

echo "========================================="
echo "Testing Parallel Subagent Execution"
echo "========================================="
echo ""

# Create a test request with multiple Task tool calls
# Simulates the model returning 3 Task tool uses in a single response
cat > /tmp/parallel-test-request.json <<'EOF'
{
  "model": "claude-3-5-sonnet-20241022",
  "max_tokens": 4096,
  "messages": [
    {
      "role": "user",
      "content": "I need you to perform three tasks in parallel: 1) Explore the src/config directory to understand configuration structure, 2) Find all test files in the project, and 3) Check what agents are available. Use the Task tool three times."
    },
    {
      "role": "assistant",
      "content": [
        {
          "type": "text",
          "text": "I'll execute these three tasks in parallel using subagents."
        },
        {
          "type": "tool_use",
          "id": "task1",
          "name": "Task",
          "input": {
            "subagent_type": "Explore",
            "description": "Explore config directory",
            "prompt": "Explore the src/config directory and explain what configuration files exist and what they do."
          }
        },
        {
          "type": "tool_use",
          "id": "task2",
          "name": "Task",
          "input": {
            "subagent_type": "Explore",
            "description": "Find test files",
            "prompt": "Find all test files in the project (files ending in .test.js or .test.ts). List their locations."
          }
        },
        {
          "type": "tool_use",
          "id": "task3",
          "name": "Task",
          "input": {
            "subagent_type": "Explore",
            "description": "List available agents",
            "prompt": "Search the codebase to find what agent types are available. Look for agent definitions."
          }
        }
      ]
    }
  ]
}
EOF

echo "Sending request with 3 parallel Task tool calls..."
echo ""

# Set tool execution mode to server so tools execute server-side
export TOOL_EXECUTION_MODE=server

# Make the request
start_time=$(date +%s)
curl -s -X POST http://localhost:8080/v1/messages \
  -H "Content-Type: application/json" \
  -d @/tmp/parallel-test-request.json \
  > /tmp/parallel-test-response.json

end_time=$(date +%s)
duration=$((end_time - start_time))

echo "Request completed in ${duration} seconds"
echo ""

# Check the logs for parallel execution evidence
echo "========================================="
echo "Checking logs for parallel execution..."
echo "========================================="
echo ""

echo "Looking for 'Executing multiple Task tools in parallel':"
grep "Executing multiple Task tools in parallel" /tmp/lynkr.log | tail -1 | jq .

echo ""
echo "Looking for 'Completed parallel Task execution':"
grep "Completed parallel Task execution" /tmp/lynkr.log | tail -1 | jq .

echo ""
echo "========================================="
echo "Response Summary:"
echo "========================================="

# Show response structure
if [ -f /tmp/parallel-test-response.json ]; then
  echo ""
  echo "Response content blocks:"
  cat /tmp/parallel-test-response.json | jq '.content | length'
  echo " content blocks returned"

  echo ""
  echo "Tool result IDs:"
  cat /tmp/parallel-test-response.json | jq -r '.content[] | select(.type=="tool_result") | .tool_use_id'

  echo ""
  echo "First 100 chars of each tool result:"
  cat /tmp/parallel-test-response.json | jq -r '.content[] | select(.type=="tool_result") | .content' | head -c 300
  echo ""
else
  echo "ERROR: No response file found!"
fi

echo ""
echo "========================================="
echo "Test Complete!"
echo "========================================="
