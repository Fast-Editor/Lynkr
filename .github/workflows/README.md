# GitHub Actions Workflows

This directory contains GitHub Actions workflows for automated testing and CI/CD.

## Available Workflows

### 1. CI Tests (`ci.yml`)

**Purpose:** Run comprehensive test suite on every push and pull request

**Triggers:**
- Push to `main` or `develop` branches
- Pull requests to `main` or `develop` branches

**What it does:**
- Tests on Node.js 20.x and 22.x
- Runs linter (`npm run lint`)
- Runs unit tests (`npm run test:unit`)
- Runs performance tests (`npm run test:performance`)
- Uses npm cache for faster builds

**Environment Variables:**
- `DATABRICKS_API_KEY=test-key` (mock value for tests)
- `DATABRICKS_API_BASE=http://test.com` (mock value for tests)

**Status:** Runs on every push/PR, fails if unit tests fail

---

### 2. NPM Publish (`npm-publish.yml`)

**Purpose:** Automatically publish package to npm registry

**Triggers:**
- Git tags starting with `v` (e.g., `v0.1.5`)
- GitHub Releases created

**What it does:**
- Runs full test suite before publishing
- Checks if version already exists on npm
- Publishes package to npm registry (if tests pass)
- Prevents duplicate publishes
- Creates publish summary

**Requirements:**
- `NPM_TOKEN` secret must be configured
- Tests must pass
- Version must be new

**Status:** Only publishes on successful builds

---

### 3. Version Bump (`version-bump.yml`)

**Purpose:** Manual workflow to bump version and create releases

**Triggers:**
- Manual workflow dispatch (button in Actions tab)

**What it does:**
- Prompts for version type (patch/minor/major)
- Runs tests before version bump
- Updates package.json version
- Creates git commit and tag
- Pushes changes to repository
- Creates GitHub Release with changelog
- Triggers npm-publish workflow automatically

**Options:**
- `patch` - Bug fixes (0.1.4 → 0.1.5)
- `minor` - New features (0.1.4 → 0.2.0)
- `major` - Breaking changes (0.1.4 → 1.0.0)

---

### 4. IndexNow Notification (`index.yml`)

**Purpose:** Notify search engines when documentation is updated

**Triggers:**
- Push to `main` branch
- Changes in `docs/**` directory

**What it does:**
- Notifies Bing IndexNow about updated documentation
- Helps with SEO and documentation discoverability

---

## Adding Status Badges

Add these badges to your README.md:

```markdown
![CI Tests](https://github.com/vishalveerareddy123/Lynkr/actions/workflows/ci.yml/badge.svg)
![npm version](https://img.shields.io/npm/v/lynkr.svg)
![npm downloads](https://img.shields.io/npm/dt/lynkr.svg)
```

## Running Tests Locally

Before pushing, run tests locally:

```bash
# Run all unit tests
npm run test:unit

# Run quick tests (routing only)
npm run test:quick

# Run all tests including performance
npm test
```

## Workflow Configuration

### Required Secrets

**For npm publishing workflows:**
- `NPM_TOKEN` - Your npm automation token (required to publish)
  - Get from: https://www.npmjs.com/settings/YOUR_USERNAME/tokens
  - Type: "Automation" token
  - Add to: Settings → Secrets → Actions → New repository secret

**For test workflows:**
- No secrets required (uses mock credentials)

**For IndexNow workflow:**
- `INDEX_NOW` - Your IndexNow API key (optional, only for docs)

### Matrix Strategy

The CI workflow uses a matrix strategy to test on multiple Node.js versions:
- Node.js 20.x (LTS)
- Node.js 22.x (Current)

This ensures compatibility across different Node versions.

## Troubleshooting

### Tests fail locally but pass in CI
- Check Node.js version (`node --version`)
- Ensure `npm ci` is used (not `npm install`)
- Check for platform-specific issues (macOS vs Linux)

### Tests pass locally but fail in CI
- Environment variables might be missing
- Dependencies might need updating
- Check GitHub Actions logs for details

### Workflow doesn't trigger
- Verify file paths in `on.push.paths`
- Check branch names match
- Ensure workflow file is in `.github/workflows/`

## Modifying Workflows

When making changes:

1. Test YAML syntax (use a YAML validator)
2. Test locally first with same commands
3. Create a PR to test in CI before merging
4. Check GitHub Actions tab for results

## Performance Considerations

- **npm cache:** Workflows cache `node_modules` for faster builds
- **Parallel jobs:** Tests run on multiple Node versions in parallel
- **Path filtering:** Web tools workflow only runs when relevant files change
- **continue-on-error:** Performance tests won't fail the build

## Future Improvements

Potential additions:
- Code coverage reporting
- Docker container testing
- E2E integration tests
- Deploy previews for PRs
- Automated dependency updates (Dependabot)
