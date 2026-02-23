#!/usr/bin/env python3
"""
Progress Listener for Lynkr

Connects to Lynkr's WebSocket server and displays real-time progress updates
during agent execution.

Usage:
    python tools/progress-listener.py [--host HOST] [--port PORT]
"""

import argparse
import asyncio
import json
import sys
import time
from datetime import datetime

try:
    import websockets
except ImportError:
    print("Error: websockets library is required.", file=sys.stderr)
    print("Install with: pip install websockets", file=sys.stderr)
    sys.exit(1)


# ANSI color codes for better formatting
class Colors:
    HEADER = '\033[95m'
    OKBLUE = '\033[94m'
    OKCYAN = '\033[96m'
    OKGREEN = '\033[92m'
    WARNING = '\033[93m'
    FAIL = '\033[91m'
    ENDC = '\033[0m'
    BOLD = '\033[1m'
    UNDERLINE = '\033[4m'


# Track agent hierarchy and timing
class AgentTracker:
    def __init__(self):
        self.agents = {}  # agentId -> {parentId, startTime, depth}
        self.parent_children = {}  # parentId -> [childIds]

    def start_agent(self, agent_id, parent_id=None):
        depth = 0
        if parent_id and parent_id in self.agents:
            depth = self.agents[parent_id]['depth'] + 1

        self.agents[agent_id] = {
            'parentId': parent_id,
            'startTime': time.time(),
            'depth': depth
        }

        if parent_id:
            if parent_id not in self.parent_children:
                self.parent_children[parent_id] = []
            self.parent_children[parent_id].append(agent_id)

    def get_agent_prefix(self, agent_id):
        """Get a formatted prefix showing agent hierarchy"""
        if agent_id not in self.agents:
            return "[Agent]"

        agent = self.agents[agent_id]
        depth = agent['depth']
        parent_id = agent['parentId']

        # Build hierarchy string like [Agent #1] or [Agent #2 → #1]
        if parent_id:
            parent_num = self._get_agent_num(parent_id)
            child_num = self._get_agent_num(agent_id)
            return f"[Agent #{child_num} → #{parent_num}]"
        else:
            agent_num = self._get_agent_num(agent_id)
            return f"[Agent #{agent_num}]"

    def _get_agent_num(self, agent_id):
        """Get a simple number for an agent (based on creation order)"""
        sorted_agents = sorted(self.agents.keys(), key=lambda a: self.agents[a]['startTime'])
        try:
            return sorted_agents.index(agent_id) + 1
        except ValueError:
            return 0

    def get_indent(self, agent_id):
        """Get indentation for nested agents"""
        if agent_id not in self.agents:
            return ""
        depth = self.agents[agent_id]['depth']
        return "  " * depth


# Global agent tracker
agent_tracker = AgentTracker()


def format_timestamp(timestamp_ms):
    """Format millisecond timestamp to HH:MM:SS"""
    return datetime.fromtimestamp(timestamp_ms / 1000).strftime('%H:%M:%S')


def format_duration(ms):
    """Format milliseconds to human-readable duration"""
    if ms < 1000:
        return f"{ms}ms"
    elif ms < 60000:
        return f"{ms / 1000:.1f}s"
    else:
        return f"{ms / 60000:.1f}m"


def format_event(event):
    """Format a progress event for display"""
    event_type = event.get('type', 'unknown')
    timestamp = format_timestamp(event.get('timestamp', time.time() * 1000))
    agent_id = event.get('agentId')
    parent_agent_id = event.get('parentAgentId')

    output = []
    indent = ""
    agent_prefix = ""

    # Track and format agent information
    if event_type == 'agent_loop_started' and agent_id:
        agent_tracker.start_agent(agent_id, parent_agent_id)
        agent_prefix = agent_tracker.get_agent_prefix(agent_id)
        indent = agent_tracker.get_indent(agent_id)
    elif agent_id:
        agent_prefix = agent_tracker.get_agent_prefix(agent_id)
        indent = agent_tracker.get_indent(agent_id)

    if event_type == 'connected':
        output.append(f"{Colors.OKGREEN}[{timestamp}] Connected to Lynkr progress server{Colors.ENDC}")
        output.append(f"  Client ID: {event.get('clientId')}")
        server_info = event.get('serverInfo', {})
        if server_info:
            output.append(f"  Features: {', '.join(server_info.get('features', []))}")
    
    elif event_type == 'ready':
        output.append(f"{Colors.OKCYAN}[{timestamp}] {event.get('message', 'Ready')}{Colors.ENDC}")
    
    elif event_type == 'agent_loop_started':
        output.append(f"{indent}{Colors.HEADER}[{timestamp}] {agent_prefix} {Colors.BOLD}Started{Colors.ENDC}")
        output.append(f"{indent}  Model: {Colors.OKCYAN}{event.get('model')}{Colors.ENDC}")
        output.append(f"{indent}  Provider: {event.get('providerType')}")
        output.append(f"{indent}  Max steps: {event.get('maxSteps')}")
        output.append(f"{indent}  Max duration: {format_duration(event.get('maxDurationMs', 0))}")
    
    elif event_type == 'agent_loop_step_started':
        step = event.get('step', 0)
        max_steps = event.get('maxSteps', 0)
        progress_pct = event.get('progress', 0)
        output.append(f"{indent}{Colors.OKBLUE}[{timestamp}] {agent_prefix} Step {Colors.BOLD}{step}/{max_steps}{Colors.ENDC} ({progress_pct}%)")
    
    elif event_type == 'model_invocation_started':
        output.append(f"{indent}{Colors.OKCYAN}[{timestamp}] {agent_prefix} Calling model...{Colors.ENDC}")
        output.append(f"{indent}  Model: {event.get('model')}")
        output.append(f"{indent}  Provider: {event.get('providerType')}")
        estimated = event.get('estimatedTokens')
        if estimated:
            output.append(f"{indent}  Estimated tokens: ~{estimated}")
    
    elif event_type == 'model_invocation_completed':
        duration = event.get('durationMs', 0)
        input_tokens = event.get('inputTokens', 0)
        output_tokens = event.get('outputTokens', 0)
        output.append(f"{indent}{Colors.OKGREEN}[{timestamp}] {agent_prefix} Model response received{Colors.ENDC}")
        output.append(f"{indent}  Duration: {format_duration(duration)}")
        output.append(f"{indent}  Tokens: {input_tokens} in → {output_tokens} out")
    
    elif event_type == 'tool_execution_started':
        tool_name = event.get('toolName', 'unknown')
        tool_id = event.get('toolId', '')
        request_preview = event.get('requestPreview')
        output.append(f"{indent}{Colors.WARNING}[{timestamp}] {agent_prefix} Executing tool: {Colors.BOLD}{tool_name}{Colors.ENDC}")
        if request_preview:
            output.append(f"{indent}  Request: {request_preview}")
        if tool_id:
            output.append(f"{indent}  ID: {tool_id}")
    
    elif event_type == 'tool_execution_completed':
        tool_name = event.get('toolName', 'unknown')
        ok = event.get('ok', True)
        duration = event.get('durationMs', 0)
        response_preview = event.get('responsePreview')
        status = f"{Colors.OKGREEN}OK{Colors.ENDC}" if ok else f"{Colors.FAIL}FAILED{Colors.ENDC}"
        output.append(f"{indent}{Colors.OKCYAN}[{timestamp}] {agent_prefix} Tool {tool_name}: {status}{Colors.ENDC}")
        output.append(f"{indent}  Duration: {format_duration(duration)}")
        if response_preview:
            output.append(f"{indent}  Response: {response_preview}")
    
    elif event_type == 'agent_loop_completed':
        duration = event.get('durationMs', 0)
        steps = event.get('steps', 0)
        tool_calls = event.get('toolCallsExecuted', 0)
        reason = event.get('terminationReason', 'completion')
        output.append(f"{indent}{Colors.OKGREEN}{Colors.BOLD}[{timestamp}] {agent_prefix} Completed{Colors.ENDC}")
        output.append(f"{indent}  Duration: {format_duration(duration)}")
        output.append(f"{indent}  Steps: {steps}")
        output.append(f"{indent}  Tool calls: {tool_calls}")
        output.append(f"{indent}  Reason: {reason}")
    
    elif event_type == 'error':
        error_type = event.get('errorType', 'unknown')
        message = event.get('errorMessage', 'No message')
        output.append(f"{Colors.FAIL}{Colors.BOLD}[{timestamp}] ERROR: {error_type}{Colors.ENDC}")
        output.append(f"  {message}")
    
    elif event_type == 'server:shutdown':
        output.append(f"{Colors.WARNING}[{timestamp}] Server shutting down{Colors.ENDC}")
    
    else:
        # Unknown event type - just display the raw data
        output.append(f"{Colors.OKCYAN}[{timestamp}] {event_type}{Colors.ENDC}")
        for key, value in event.items():
            if key not in ['type', 'timestamp']:
                output.append(f"  {key}: {value}")
    
    return '\n'.join(output)


async def listen_progress(host, port):
    """Connect to Lynkr progress WebSocket server and listen for events"""
    uri = f"ws://{host}:{port}"
    print(f"{Colors.BOLD}Connecting to Lynkr progress server at {uri}...{Colors.ENDC}")
    
    try:
        async with websockets.connect(uri) as websocket:
            print(f"{Colors.OKGREEN}Connected! Waiting for progress updates...{Colors.ENDC}\n")
            
            while True:
                message = await websocket.recv()
                try:
                    event = json.loads(message)
                    print(format_event(event))
                    print()  # Empty line between events
                    sys.stdout.flush()
                except json.JSONDecodeError as e:
                    print(f"{Colors.FAIL}[ERROR] Failed to parse message: {e}{Colors.ENDC}")
                    print(f"  Raw message: {message[:200]}")
                    sys.stdout.flush()
                    
    except websockets.exceptions.ConnectionClosed as e:
        print(f"\n{Colors.WARNING}Connection closed: {e}{Colors.ENDC}")
    except websockets.exceptions.WebSocketException as e:
        print(f"\n{Colors.FAIL}WebSocket error: {e}{Colors.ENDC}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print(f"\n{Colors.OKCYAN}Stopped by user{Colors.ENDC}")
    except ConnectionRefusedError:
        print(f"\n{Colors.FAIL}Connection refused. Is Lynkr running with PROGRESS_ENABLED=true?{Colors.ENDC}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"\n{Colors.FAIL}Unexpected error: {e}{Colors.ENDC}", file=sys.stderr)
        sys.exit(1)


def main():
    """Main entry point"""
    parser = argparse.ArgumentParser(
        description='Lynkr Progress Listener - Display real-time agent execution progress',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python tools/progress-listener.py
  python tools/progress-listener.py --host localhost --port 8765
  python tools/progress-listener.py --host 192.168.1.100

Environment variables:
  LYNKR_PROGRESS_HOST    WebSocket server host (default: localhost)
  LYNKR_PROGRESS_PORT    WebSocket server port (default: 8765)
        """
    )
    parser.add_argument(
        '--host',
        default=None,
        help='WebSocket server host (default: from LYNKR_PROGRESS_HOST or localhost)'
    )
    parser.add_argument(
        '--port',
        type=int,
        default=None,
        help='WebSocket server port (default: from LYNKR_PROGRESS_PORT or 8765)'
    )
    parser.add_argument(
        '--no-color',
        action='store_true',
        help='Disable colored output'
    )
    
    args = parser.parse_args()
    
    # Read from environment if not specified
    host = args.host or os.getenv('LYNKR_PROGRESS_HOST', 'localhost')
    port = args.port or int(os.getenv('LYNKR_PROGRESS_PORT', '8765'))
    
    # Disable colors if requested
    if args.no_color or not sys.stdout.isatty():
        for attr in dir(Colors):
            if not attr.startswith('_'):
                setattr(Colors, attr, '')
    
    asyncio.run(listen_progress(host, port))


if __name__ == '__main__':
    import os
    main()