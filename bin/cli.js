#!/usr/bin/env node

const pkg = require('../package.json');

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log(pkg.version);
  process.exit(0);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
${pkg.name} v${pkg.version}

${pkg.description}

Usage:
  lynkr [options]

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
