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
  -h, --help     Show this help message
  -v, --version  Show version number

Environment Variables:
  See .env.example for configuration options

Documentation:
  ${pkg.homepage}
`);
  process.exit(0);
}

require("../index.js");
