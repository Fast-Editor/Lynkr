#!/bin/bash
#
# Lynkr Installation Script
# Usage: curl -fsSL https://raw.githubusercontent.com/Fast-Editor/Lynkr/main/install.sh | bash
#
# This script installs Lynkr, a self-hosted Claude Code proxy with multi-provider support.
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
REPO_URL="https://github.com/Fast-Editor/Lynkr"
INSTALL_DIR="${LYNKR_INSTALL_DIR:-$HOME/.lynkr}"
BRANCH="${LYNKR_BRANCH:-main}"

# Print colored output
print_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
print_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
print_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
print_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Print banner
print_banner() {
    echo -e "${BLUE}"
    echo "  _                _         "
    echo " | |   _   _ _ __ | | ___ __ "
    echo " | |  | | | | '_ \| |/ / '__|"
    echo " | |__| |_| | | | |   <| |   "
    echo " |_____\__, |_| |_|_|\_\_|   "
    echo "       |___/                 "
    echo -e "${NC}"
    echo "Self-hosted Claude Code Proxy"
    echo "=============================="
    echo ""
}

# Check for required commands
check_requirements() {
    print_info "Checking requirements..."

    local missing=()

    if ! command -v node &> /dev/null; then
        missing+=("node")
    else
        NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
        if [ "$NODE_VERSION" -lt 20 ]; then
            print_error "Node.js version 20 or higher is required (found v$NODE_VERSION)"
            exit 1
        fi
        print_success "Node.js $(node -v) found"
    fi

    if ! command -v npm &> /dev/null; then
        missing+=("npm")
    else
        print_success "npm $(npm -v) found"
    fi

    if ! command -v git &> /dev/null; then
        missing+=("git")
    else
        print_success "git $(git --version | cut -d' ' -f3) found"
    fi

    if [ ${#missing[@]} -ne 0 ]; then
        print_error "Missing required tools: ${missing[*]}"
        echo ""
        echo "Please install the missing tools:"
        for tool in "${missing[@]}"; do
            case $tool in
                node|npm)
                    echo "  - Node.js: https://nodejs.org/ (v20 or higher)"
                    ;;
                git)
                    echo "  - Git: https://git-scm.com/"
                    ;;
            esac
        done
        exit 1
    fi
}

# Clone or update repository
clone_or_update() {
    if [ -d "$INSTALL_DIR" ]; then
        print_info "Updating existing installation..."
        cd "$INSTALL_DIR"
        git fetch origin
        git checkout "$BRANCH"
        git pull origin "$BRANCH"
    else
        print_info "Cloning Lynkr repository..."
        git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
        cd "$INSTALL_DIR"
    fi
    print_success "Repository ready at $INSTALL_DIR"
}

# Install dependencies
install_dependencies() {
    print_info "Installing dependencies..."
    cd "$INSTALL_DIR"
    # --omit=dev keeps optionalDependencies (better-sqlite3, hnswlib-node,
    # tree-sitter) which back telemetry, the memory store and routing ML.
    # The postinstall hook (scripts/check-native.js) verifies the native ABI
    # and rebuilds if Node was upgraded — best-effort, never fails the install.
    npm install --omit=dev
    print_success "Dependencies installed"

    # Native optional modules need a C/C++ toolchain only if no prebuilt binary
    # is available for this platform. They degrade gracefully if absent.
    if ! node -e "const D=require('better-sqlite3'); new D(':memory:').close()" >/dev/null 2>&1; then
        print_warning "Native module 'better-sqlite3' is not loadable."
        echo "     Telemetry, the memory store and sessions need it. To enable:"
        echo "       - Ensure a build toolchain is present (Xcode CLT on macOS, build-essential + python3 on Linux), then:"
        echo "       - ${BLUE}cd $INSTALL_DIR && npm run rebuild-native${NC}"
        echo "     Lynkr still runs without it (those features stay disabled)."
    else
        print_success "Native modules OK (telemetry, memory, sessions enabled)"
    fi
}

# Skip .env creation — the install script runs without a TTY when invoked via
# `curl | bash`, so the interactive `lynkr init` wizard can't run here. We leave
# .env unmade so the user is prompted to run `lynkr init` in their own shell
# afterward, which produces a fully-populated config (~150 keys grouped by
# section) instead of the old 892-line .env.example dump.
create_env_file() {
    if [ -f "$INSTALL_DIR/.env" ]; then
        print_warning ".env file already exists, skipping"
        return
    fi
    print_info "Skipping .env creation — run ${BLUE}lynkr init${NC} after install for an interactive setup."
}

# Create symlink for global access
create_symlink() {
    print_info "Setting up global command..."

    # Determine bin directory
    if [ -d "$HOME/.local/bin" ]; then
        BIN_DIR="$HOME/.local/bin"
    elif [ -d "/usr/local/bin" ] && [ -w "/usr/local/bin" ]; then
        BIN_DIR="/usr/local/bin"
    else
        mkdir -p "$HOME/.local/bin"
        BIN_DIR="$HOME/.local/bin"
    fi

    # Create symlink
    ln -sf "$INSTALL_DIR/bin/cli.js" "$BIN_DIR/lynkr"
    chmod +x "$INSTALL_DIR/bin/cli.js"

    # Check if BIN_DIR is in PATH
    if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
        print_warning "$BIN_DIR is not in your PATH"
        echo ""
        echo "Add this to your ~/.bashrc or ~/.zshrc:"
        echo "  export PATH=\"$BIN_DIR:\$PATH\""
        echo ""
    else
        print_success "lynkr command available globally"
    fi
}

# Print next steps
print_next_steps() {
    echo ""
    echo "=============================="
    print_success "Lynkr installed successfully!"
    echo "=============================="
    echo ""
    echo "🚀 Quick Start:"
    echo ""
    echo "  1. Run the setup wizard:"
    echo "     ${BLUE}lynkr init${NC}  ${GREEN}← interactive config (4 prompts, ~30 sec)${NC}"
    echo ""
    echo "     The wizard asks for your usage mode (Claude Pro/Max via wrap, or direct"
    echo "     API), tier picks across 12 supported providers, credentials for what you"
    echo "     chose, and a few routing knobs. It writes a fully-populated .env with"
    echo "     production defaults for everything else (caching, compression, policy"
    echo "     budgets, MCP sandbox, agents, rate limiting)."
    echo ""
    echo "  2. Start Lynkr:"
    echo "     ${BLUE}lynkr${NC}                ${GREEN}← run as a proxy server${NC}"
    echo "     ${BLUE}lynkr wrap claude${NC}    ${GREEN}← OR launch a wrapped AI tool${NC}"
    echo ""
    echo "  3. Point your tool at Lynkr:"
    echo "     ${BLUE}export ANTHROPIC_BASE_URL=http://localhost:8081${NC}"
    echo "     ${BLUE}export ANTHROPIC_API_KEY=any-non-empty-value${NC}"
    echo "     ${BLUE}claude${NC}"
    echo ""
    echo "  ${YELLOW}Manual configuration (alternative)${NC}"
    echo "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "     Copy ${BLUE}.env.example${NC} to ${BLUE}.env${NC} and edit by hand if you prefer."
    echo "     The 892-line template documents every available knob."
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "💡 ${YELLOW}Tip:${NC} Memory system, prompt caching, and TOON compression are all on"
    echo "   by default. The wizard's defaults match a production-grade Lynkr setup."
    echo ""
    echo "📚 Documentation: ${BLUE}https://github.com/Fast-Editor/Lynkr${NC}"
    echo "💬 Discord: ${BLUE}https://discord.gg/qF7DDxrX${NC}"
    echo ""
}

# Alternative: npm global install
npm_install_instructions() {
    echo ""
    echo "Alternative: Install via npm"
    echo "=============================="
    echo ""
    echo "  ${BLUE}npm install -g lynkr${NC}"
    echo "  ${BLUE}lynkr-setup${NC}"
    echo "  ${BLUE}lynkr${NC}"
    echo ""
}

# Main installation flow
main() {
    print_banner

    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            --dir)
                INSTALL_DIR="$2"
                shift 2
                ;;
            --branch)
                BRANCH="$2"
                shift 2
                ;;
            --help|-h)
                echo "Usage: install.sh [OPTIONS]"
                echo ""
                echo "Options:"
                echo "  --dir DIR      Installation directory (default: ~/.lynkr)"
                echo "  --branch NAME  Git branch to install (default: main)"
                echo "  --help         Show this help message"
                echo ""
                echo "Environment variables:"
                echo "  LYNKR_INSTALL_DIR  Installation directory"
                echo "  LYNKR_BRANCH       Git branch to install"
                exit 0
                ;;
            *)
                print_error "Unknown option: $1"
                exit 1
                ;;
        esac
    done

    check_requirements
    clone_or_update
    install_dependencies
    create_env_file
    create_symlink
    print_next_steps
    npm_install_instructions
}

# Run main function
main "$@"
