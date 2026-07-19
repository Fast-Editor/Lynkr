#!/usr/bin/env node

const path = require("path");
const pkg = require('../package.json');

// Subcommands. Dispatched before server boot so `lynkr usage` / `lynkr trajectory`
// don't start the proxy. Add new subcommands here, not in scattered binaries.
const SUBCOMMANDS = {
  usage:      path.join(__dirname, "lynkr-usage.js"),
  stats:      path.join(__dirname, "lynkr-usage.js"),
  trajectory: path.join(__dirname, "lynkr-trajectory.js"),
  wrap:       path.join(__dirname, "wrap.js"),
  init:       path.join(__dirname, "lynkr-init.js"),
};

const sub = process.argv[2];
// `lynkr start` is an alias for `lynkr` (start the proxy). Drop the token
// and fall through so users can use whichever spelling they prefer.
if (sub === 'start') {
  process.argv.splice(2, 1);
} else if (sub && Object.prototype.hasOwnProperty.call(SUBCOMMANDS, sub)) {
  process.argv.splice(2, 1); // drop the subcommand token so the script's own arg parser is happy
  // Subcommand scripts check this to decide whether to invoke their main()
  // when they're require()'d (vs being loaded by a test for unit-checking).
  process.env._LYNKR_SUBCMD = sub;
  require(SUBCOMMANDS[sub]);
  return;
} else if (sub && !sub.startsWith('-')) {
  // Unknown positional commands must error loudly, not silently boot the
  // server (`lynkr codex` used to start a bare gateway and never say why).
  console.error(`Error: unknown command '${sub}'.`);
  console.error(`Did you mean: lynkr wrap ${sub}`);
  console.error(`Known commands: ${Object.keys(SUBCOMMANDS).join(', ')}, start (or no command to start the server)`);
  process.exit(1);
}

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log(pkg.version);
  process.exit(0);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
${pkg.name} v${pkg.version}

${pkg.description}

Usage:
  lynkr [options]                  Start the proxy server (default)
  lynkr start [options]            Alias for the above
  lynkr init [options]             Interactive setup wizard (writes .env, pulls classifier model)
  lynkr wrap <target> [options]    Wrap CLI tools through Lynkr proxy
  lynkr usage [options]            Show AI spend report and tier-routing savings
  lynkr stats [options]            Shareable savings-receipt card (also: lynkr usage --card)
  lynkr trajectory [options]       Export agent trajectories as JSONL training data

Options:
  -h, --help      Show this help message
  -v, --version   Show version number
  --cluster       Enable cluster mode (multi-core)
  --workers N     Number of worker processes (default: auto)

Environment Variables:
  CLUSTER_ENABLED=true    Enable multi-core cluster mode
  CLUSTER_WORKERS=auto    Worker count (auto = CPU cores - 1)
  See .env.example for all configuration options

Documentation:
  ${pkg.homepage}
`);
  process.exit(0);
}

// CLI flags for cluster mode
if (process.argv.includes('--cluster')) {
  process.env.CLUSTER_ENABLED = 'true';
}
const workersIdx = process.argv.indexOf('--workers');
if (workersIdx !== -1 && process.argv[workersIdx + 1]) {
  process.env.CLUSTER_WORKERS = process.argv[workersIdx + 1];
}

require("../index.js");
