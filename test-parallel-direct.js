const http = require('http');

console.log('========================================');
console.log('Direct Parallel Subagent Test');
console.log('========================================\n');

// Directly call the /v1/messages endpoint with tool_use blocks in assistant message
// This simulates what happens when the model returns multiple Task tool calls

const testPayload = {
  model: "claude-3-5-sonnet-20241022",
  max_tokens: 8000,
  messages: [
    {
      role: "user",
      content: "Please use three Explore agents in parallel to: 1) list files in src/config, 2) find test files, and 3) check what agents are defined."
    },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "I'll execute these three exploration tasks in parallel."
        },
        {
          type: "tool_use",
          id: "task_001",
          name: "Task",
          input: {
            subagent_type: "Explore",
            description: "List config files",
            prompt: "List all files in the src/config directory. Just show the file names."
          }
        },
        {
          type: "tool_use",
          id: "task_002",
          name: "Task",
          input: {
            subagent_type: "Explore",
            description: "Find test files",
            prompt: "Find all test files in the project (*.test.js, *.spec.js). List the file paths."
          }
        },
        {
          type: "tool_use",
          id: "task_003",
          name: "Task",
          input: {
            subagent_type: "Explore",
            description: "Check agent definitions",
            prompt: "Find where agent types are defined in the codebase. Look for agent definitions like Explore, Plan, Test, etc."
          }
        }
      ]
    }
  ]
};

const options = {
  hostname: 'localhost',
  port: 8080,
  path: '/v1/messages',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  }
};

console.log('Sending request with 3 Task tool calls...\n');
const startTime = Date.now();

const req = http.request(options, (res) => {
  let data = '';

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    const duration = Date.now() - startTime;
    console.log(`Request completed in ${(duration / 1000).toFixed(1)} seconds\n`);

    try {
      const response = JSON.parse(data);

      console.log('========================================');
      console.log('Response Analysis:');
      console.log('========================================\n');

      console.log(`Content blocks: ${response.content?.length || 0}`);

      if (response.content) {
        response.content.forEach((block, i) => {
          console.log(`\nBlock ${i + 1}:`);
          console.log(`  Type: ${block.type}`);

          if (block.type === 'tool_result') {
            console.log(`  Tool Use ID: ${block.tool_use_id}`);
            console.log(`  Is Error: ${block.is_error || false}`);
            console.log(`  Content (first 200 chars): ${block.content?.substring(0, 200)}...`);
          } else if (block.type === 'text') {
            console.log(`  Text (first 100 chars): ${block.text?.substring(0, 100)}...`);
          }
        });
      }

      console.log('\n========================================');
      console.log('Log Analysis:');
      console.log('========================================\n');

      // Check logs for parallel execution
      const { execSync } = require('child_process');

      try {
        const parallelStart = execSync('grep "Executing multiple Task tools in parallel" /tmp/lynkr.log | tail -1').toString().trim();
        if (parallelStart) {
          console.log('✅ Found parallel execution log entry');
          const match = parallelStart.match(/"taskCount":\s*(\d+)/);
          if (match) {
            console.log(`   Task count: ${match[1]}`);
          }
        } else {
          console.log('❌ No parallel execution log found');
        }

        const parallelComplete = execSync('grep "Completed parallel Task execution" /tmp/lynkr.log | tail -1').toString().trim();
        if (parallelComplete) {
          console.log('✅ Found parallel completion log entry');
          const match = parallelComplete.match(/"completedTasks":\s*(\d+)/);
          if (match) {
            console.log(`   Completed tasks: ${match[1]}`);
          }
        }
      } catch (e) {
        console.log('⚠️  Could not read logs');
      }

      console.log('\n========================================');
      console.log('Test Complete!');
      console.log('========================================\n');

    } catch (error) {
      console.error('Error parsing response:', error.message);
      console.log('Raw response:', data.substring(0, 500));
    }
  });
});

req.on('error', (error) => {
  console.error('Request error:', error);
});

req.write(JSON.stringify(testPayload));
req.end();
