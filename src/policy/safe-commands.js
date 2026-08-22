const config = require("../config");

/**
 * Safe Mode Command DSL
 *
 * Declarative configuration for defining safe command patterns.
 * Supports:
 * - Command allowlisting with argument restrictions
 * - Pattern-based matching for arguments
 * - Blocklisted flag combinations
 * - Severity levels for violations
 */

const DEFAULT_SAFE_COMMANDS = {
  // Read-only file operations
  ls: {
    allowed: true,
    description: "List directory contents",
    allowedFlags: ["-l", "-a", "-h", "-R", "-t", "-1", "--color"],
    blockedPatterns: [],
  },
  cat: {
    allowed: true,
    description: "View file contents",
    allowedFlags: ["-n", "-b", "-A"],
    blockedPatterns: [/\/etc\/(passwd|shadow)/i],
  },
  grep: {
    allowed: true,
    description: "Search file contents",
    allowedFlags: ["-i", "-r", "-n", "-v", "-l", "-c", "--color"],
    blockedPatterns: [],
  },
  find: {
    allowed: true,
    description: "Find files",
    allowedFlags: ["-name", "-type", "-mtime", "-size", "-maxdepth"],
    blockedPatterns: [/-exec.*rm/i, /-delete/i],
  },
  head: {
    allowed: true,
    description: "View beginning of files",
    allowedFlags: ["-n"],
    blockedPatterns: [],
  },
  tail: {
    allowed: true,
    description: "View end of files",
    allowedFlags: ["-n", "-f"],
    blockedPatterns: [],
  },

  // Safe development commands
  git: {
    allowed: true,
    description: "Version control",
    allowedFlags: [
      "status", "log", "diff", "show", "branch", "checkout", "add",
      "commit", "pull", "fetch", "clone", "config", "remote", "tag",
      "-m", "--message", "-a", "--all", "-b", "-p", "--patch"
    ],
    blockedPatterns: [
      /push.*--force/i,
      /reset.*--hard/i,
      /clean.*-[dfx]/i,
    ],
  },
  npm: {
    allowed: true,
    description: "Node package manager",
    allowedFlags: ["install", "test", "run", "start", "build", "ci"],
    blockedPatterns: [/publish/i],
  },
  yarn: {
    allowed: true,
    description: "Yarn package manager",
    allowedFlags: ["install", "test", "run", "start", "build"],
    blockedPatterns: [/publish/i],
  },
  node: {
    allowed: true,
    description: "Node.js runtime",
    allowedFlags: ["-e", "--eval", "-p", "--print", "-v", "--version"],
    blockedPatterns: [],
  },
  python: {
    allowed: true,
    description: "Python runtime",
    allowedFlags: ["-c", "-m", "-V", "--version"],
    blockedPatterns: [],
  },
  python3: {
    allowed: true,
    description: "Python 3 runtime",
    allowedFlags: ["-c", "-m", "-V", "--version"],
    blockedPatterns: [],
  },

  // Safe utilities
  echo: {
    allowed: true,
    description: "Print text",
    allowedFlags: ["-n", "-e"],
    blockedPatterns: [],
  },
  pwd: {
    allowed: true,
    description: "Print working directory",
    allowedFlags: [],
    blockedPatterns: [],
  },
  whoami: {
    allowed: true,
    description: "Print current user",
    allowedFlags: [],
    blockedPatterns: [],
  },
  date: {
    allowed: true,
    description: "Print date/time",
    allowedFlags: ["-u", "-I", "+%Y-%m-%d"],
    blockedPatterns: [],
  },
  env: {
    allowed: true,
    description: "Print environment variables",
    allowedFlags: [],
    blockedPatterns: [],
  },

  // Build/test tools
  make: {
    allowed: true,
    description: "Build automation",
    allowedFlags: ["-j", "-B", "-n", "--dry-run"],
    blockedPatterns: [/install/i, /uninstall/i],
  },
  cargo: {
    allowed: true,
    description: "Rust package manager",
    allowedFlags: ["build", "test", "run", "check", "clippy", "fmt"],
    blockedPatterns: [/publish/i],
  },
  go: {
    allowed: true,
    description: "Go toolchain",
    allowedFlags: ["build", "test", "run", "fmt", "vet", "mod"],
    blockedPatterns: [],
  },

  // Dangerous commands (blocked by default)
  rm: {
    allowed: false,
    description: "Remove files (DANGEROUS)",
    severity: "critical",
    reason: "File deletion should be carefully controlled",
  },
  mv: {
    allowed: false,
    description: "Move files (DANGEROUS)",
    severity: "high",
    reason: "File operations should be done through fs_write tool",
  },
  cp: {
    allowed: false,
    description: "Copy files (DANGEROUS)",
    severity: "high",
    reason: "File operations should be done through fs_write tool",
  },
  chmod: {
    allowed: false,
    description: "Change permissions (DANGEROUS)",
    severity: "critical",
    reason: "Permission changes could compromise security",
  },
  chown: {
    allowed: false,
    description: "Change ownership (DANGEROUS)",
    severity: "critical",
    reason: "Ownership changes could compromise security",
  },
  sudo: {
    allowed: false,
    description: "Execute as superuser (DANGEROUS)",
    severity: "critical",
    reason: "Privilege escalation is not allowed",
  },
  su: {
    allowed: false,
    description: "Switch user (DANGEROUS)",
    severity: "critical",
    reason: "User switching is not allowed",
  },
  dd: {
    allowed: false,
    description: "Low-level copy (DANGEROUS)",
    severity: "critical",
    reason: "Can destroy data if misused",
  },
  mkfs: {
    allowed: false,
    description: "Format filesystem (DANGEROUS)",
    severity: "critical",
    reason: "Filesystem formatting would destroy data",
  },
  fdisk: {
    allowed: false,
    description: "Partition tool (DANGEROUS)",
    severity: "critical",
    reason: "Disk partitioning could destroy data",
  },
  reboot: {
    allowed: false,
    description: "Reboot system (DANGEROUS)",
    severity: "critical",
    reason: "System control commands are not allowed",
  },
  shutdown: {
    allowed: false,
    description: "Shutdown system (DANGEROUS)",
    severity: "critical",
    reason: "System control commands are not allowed",
  },
  systemctl: {
    allowed: false,
    description: "System control (DANGEROUS)",
    severity: "critical",
    reason: "System service control is not allowed",
  },
  kill: {
    allowed: false,
    description: "Terminate processes (DANGEROUS)",
    severity: "high",
    reason: "Process control should be managed carefully",
  },
  killall: {
    allowed: false,
    description: "Terminate all matching processes (DANGEROUS)",
    severity: "critical",
    reason: "Mass process termination is too dangerous",
  },
};

class SafeCommandDSL {
  constructor(customRules = {}) {
    this.rules = { ...DEFAULT_SAFE_COMMANDS, ...customRules };
  }

  /**
   * Load custom rules from config
   */
  static fromConfig() {
    const customRules = config.policy?.safeCommands ?? {};
    return new SafeCommandDSL(customRules);
  }

  /**
   * Evaluate if a command is safe to execute
   */
  evaluate(commandString) {
    if (typeof commandString !== "string" || !commandString.trim()) {
      return {
        allowed: false,
        reason: "Empty command",
        severity: "low",
      };
    }

    // Parse command - extract base command and arguments
    const parts = this.parseCommand(commandString);
    const baseCommand = parts.command;
    const args = parts.args;
    const fullArgs = parts.fullArgs;

    // Check if command has a rule
    const rule = this.rules[baseCommand];

    if (!rule) {
      // No rule = allow by default (permissive mode)
      // Could be changed to deny by default (restrictive mode)
      return {
        allowed: true,
        reason: "No specific rule defined (permissive mode)",
        command: baseCommand,
      };
    }

    // Check if command is explicitly blocked
    if (rule.allowed === false) {
      return {
        allowed: false,
        reason: rule.reason ?? `Command "${baseCommand}" is not allowed`,
        severity: rule.severity ?? "high",
        command: baseCommand,
      };
    }

    // Check blocked patterns
    if (rule.blockedPatterns && Array.isArray(rule.blockedPatterns)) {
      for (const pattern of rule.blockedPatterns) {
        if (pattern.test(fullArgs)) {
          return {
            allowed: false,
            reason: `Command matches blocked pattern: ${pattern.source}`,
            severity: "high",
            command: baseCommand,
            matchedPattern: pattern.source,
          };
        }
      }
    }

    // Check allowed flags (if defined)
    if (rule.allowedFlags && Array.isArray(rule.allowedFlags)) {
      const allowedSet = new Set(rule.allowedFlags);

      for (const arg of args) {
        // Skip non-flag arguments (file paths, etc.)
        if (!arg.startsWith("-")) continue;

        // Check if flag is in allowed list
        if (allowedSet.has(arg)) {
          continue; // Flag is explicitly allowed
        }

        // Handle combined short flags like "-la" = "-l" + "-a"
        if (arg.startsWith("-") && !arg.startsWith("--") && arg.length > 2) {
          const flags = arg.slice(1).split("").map(f => `-${f}`);
          const allAllowed = flags.every(f => allowedSet.has(f));
          if (allAllowed) {
            continue; // All combined flags are allowed
          }
        }

        // Flag is not allowed
        return {
          allowed: false,
          reason: `Flag "${arg}" is not in the allowed list for "${baseCommand}"`,
          severity: "medium",
          command: baseCommand,
          disallowedFlag: arg,
          allowedFlags: rule.allowedFlags,
        };
      }
    }

    // All checks passed
    return {
      allowed: true,
      reason: `Command "${baseCommand}" passed all safety checks`,
      command: baseCommand,
      description: rule.description,
    };
  }

  /**
   * Parse command string into components
   */
  parseCommand(commandString) {
    const trimmed = commandString.trim();

    // Simple parsing - split on spaces (doesn't handle quotes properly, but good enough)
    const parts = trimmed.split(/\s+/);
    const command = parts[0];
    const args = parts.slice(1);

    return {
      command,
      args,
      fullArgs: args.join(" "),
      original: commandString,
    };
  }

  /**
   * Get rule for a command
   */
  getRule(command) {
    return this.rules[command] ?? null;
  }

  /**
   * Add or update a rule
   */
  addRule(command, rule) {
    this.rules[command] = rule;
  }

  /**
   * Get list of all allowed commands
   */
  getAllowedCommands() {
    return Object.entries(this.rules)
      .filter(([, rule]) => rule.allowed !== false)
      .map(([command, rule]) => ({
        command,
        description: rule.description,
        allowedFlags: rule.allowedFlags,
      }));
  }

  /**
   * Get list of all blocked commands
   */
  getBlockedCommands() {
    return Object.entries(this.rules)
      .filter(([, rule]) => rule.allowed === false)
      .map(([command, rule]) => ({
        command,
        reason: rule.reason,
        severity: rule.severity,
      }));
  }
}

// Singleton instance
let instance = null;

function getSafeCommandDSL() {
  if (!instance) {
    instance = SafeCommandDSL.fromConfig();
  }
  return instance;
}

module.exports = {
  SafeCommandDSL,
  getSafeCommandDSL,
  DEFAULT_SAFE_COMMANDS,
};
