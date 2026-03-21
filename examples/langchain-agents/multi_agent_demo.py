"""
Multi-Agent LangChain Demo with Lynkr

Demonstrates how multiple LangChain agents can use Lynkr as their LLM backend,
each sending an X-Agent-Role header so Lynkr routes them to the preferred provider.

Usage:
    1. Start Lynkr:  node index.js
    2. Configure domain preferences in .env:
       ROUTING_PREFERENCES=security:anthropic|openai,code:openai|ollama,frontend:ollama
    3. Run:  python3 examples/langchain-agents/multi_agent_demo.py

Each agent gets independently routed based on its role header + message complexity.
"""

import sys
import json
from langchain_openai import ChatOpenAI
from langchain_core.messages import HumanMessage, SystemMessage

LYNKR_BASE_URL = "http://localhost:8081/v1"
LYNKR_API_KEY = "not-needed"  # Lynkr doesn't require an API key


def create_agent(role: str, system_prompt: str) -> ChatOpenAI:
    """Create a LangChain ChatOpenAI instance pointed at Lynkr with an agent role header."""
    return ChatOpenAI(
        base_url=LYNKR_BASE_URL,
        api_key=LYNKR_API_KEY,
        model="auto",
        default_headers={"X-Agent-Role": role},
    )


def run_agent(name: str, agent: ChatOpenAI, system_prompt: str, user_message: str):
    """Run a single agent and print the routing result."""
    print(f"\n{'='*60}")
    print(f"Agent: {name}")
    print(f"Role header: X-Agent-Role: {agent.default_headers.get('X-Agent-Role', 'none')}")
    print(f"Message: {user_message[:80]}...")
    print(f"{'='*60}")

    messages = [
        SystemMessage(content=system_prompt),
        HumanMessage(content=user_message),
    ]

    try:
        response = agent.invoke(messages)
        # Print response (truncated)
        text = response.content[:200] if response.content else "(empty)"
        print(f"Response: {text}")

        # Print routing metadata from response if available
        if hasattr(response, "response_metadata"):
            meta = response.response_metadata or {}
            headers = meta.get("headers", {})
            routing_info = {
                k: v for k, v in headers.items()
                if k.lower().startswith("x-lynkr-")
            } if isinstance(headers, dict) else {}
            if routing_info:
                print(f"\nLynkr routing headers:")
                for k, v in routing_info.items():
                    print(f"  {k}: {v}")

        print(f"\nStatus: OK")
        return True

    except Exception as e:
        print(f"Error: {e}")
        return False


def main():
    print("Multi-Agent LangChain Demo with Lynkr")
    print("=" * 60)
    print(f"Lynkr endpoint: {LYNKR_BASE_URL}")
    print()

    # Define specialized agents
    agents = [
        {
            "name": "Security Agent",
            "role": "security",
            "system_prompt": "You are a security expert. Analyze code for vulnerabilities. Be concise.",
            "message": "Review this login function for SQL injection vulnerabilities:\n"
                       "def login(user, pwd):\n"
                       "  query = f\"SELECT * FROM users WHERE name='{user}' AND pass='{pwd}'\"\n"
                       "  return db.execute(query)",
        },
        {
            "name": "Code Agent",
            "role": "code",
            "system_prompt": "You are a senior software engineer. Write clean, efficient code. Be concise.",
            "message": "Write a Python function that implements binary search on a sorted list. "
                       "Include type hints and handle edge cases.",
        },
        {
            "name": "Frontend Agent",
            "role": "frontend",
            "system_prompt": "You are a frontend developer specializing in React and CSS. Be concise.",
            "message": "Create a simple React component for a dark mode toggle button with Tailwind CSS classes.",
        },
        {
            "name": "General Agent (no role)",
            "role": "",  # No role header - Lynkr will detect domain from message text
            "system_prompt": "You are a helpful assistant. Be concise.",
            "message": "What is 2 + 2?",
        },
    ]

    results = []
    for agent_config in agents:
        role = agent_config["role"]
        agent = create_agent(role, agent_config["system_prompt"])

        # If no role, remove the header so Lynkr falls back to text detection
        if not role:
            agent.default_headers = {}

        success = run_agent(
            agent_config["name"],
            agent,
            agent_config["system_prompt"],
            agent_config["message"],
        )
        results.append((agent_config["name"], success))

    # Summary
    print(f"\n{'='*60}")
    print("SUMMARY")
    print(f"{'='*60}")
    for name, success in results:
        status = "PASS" if success else "FAIL"
        print(f"  [{status}] {name}")


if __name__ == "__main__":
    main()
