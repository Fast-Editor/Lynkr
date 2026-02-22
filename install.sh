#!/bin/bash
#
# Lynkr Installation Script
# Usage: curl -fsSL https://raw.githubusercontent.com/vishalveerareddy123/Lynkr/main/install.sh | bash
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
    npm install --production
    print_success "Dependencies installed"
}

# Create default .env file
create_env_file() {
    if [ ! -f "$INSTALL_DIR/.env" ]; then
        print_info "Creating .env configuration file..."

        # Try to copy from .env.example (comprehensive configuration)
        if [ -f "$INSTALL_DIR/.env.example" ]; then
            cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
            print_success "Created .env from .env.example (all features documented)"
        else
            # Fallback: create minimal .env if .env.example doesn't exist
            cat > "$INSTALL_DIR/.env" << 'EOF'
# Lynkr Configuration
# For full options, see: https://github.com/vishalveerareddy123/Lynkr/blob/main/.env.example

# Model Provider (databricks, openai, azure-openai, azure-anthropic, openrouter, ollama, llamacpp)
MODEL_PROVIDER=ollama

# Server Configuration
PORT=8080

# Ollama Configuration (default for local development)
OLLAMA_MODEL=qwen2.5-coder:7b
OLLAMA_ENDPOINT=http://localhost:11434

# Tier-based routing (uncomment and configure to enable)
# TIER_SIMPLE=ollama:qwen2.5-coder:7b
# TIER_MEDIUM=ollama:qwen2.5-coder:7b
# TIER_COMPLEX=ollama:qwen2.5-coder:7b
# TIER_REASONING=ollama:qwen2.5-coder:7b

# Long-Term Memory System (Titans-Inspired) - Enabled by default
MEMORY_ENABLED=true
MEMORY_RETRIEVAL_LIMIT=5
MEMORY_SURPRISE_THRESHOLD=0.3

# Uncomment and configure your preferred cloud provider:
# OPENAI_API_KEY=sk-your-key
# OPENROUTER_API_KEY=your-key
# DATABRICKS_API_KEY=your-key
# DATABRICKS_API_BASE=https://your-workspace.databricks.com
EOF
            print_success "Created basic .env file"
        fi

        echo ""
        print_info "📝 Configuration ready! Key settings:"
        echo "     • Default provider: Ollama (local, offline)"
        echo "     • Memory system: Enabled (learns from conversations)"
        echo "     • Port: 8080"
        echo ""
        print_warning "To use cloud providers (Databricks/OpenAI/Azure):"
        echo "     Edit: ${BLUE}nano $INSTALL_DIR/.env${NC}"
        echo "     Add your API keys and change MODEL_PROVIDER"
    else
        print_warning ".env file already exists, skipping"
    fi
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
    echo "🚀 Quick Start Guide:"
    echo ""
    echo "  ${GREEN}Option A: Use Ollama (Free, Local, Offline)${NC}"
    echo "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "  1. Install Ollama (if not already installed):"
    echo "     ${BLUE}lynkr-setup${NC}  ${GREEN}← Automatic Ollama installer${NC}"
    echo ""
    echo "  2. Start Lynkr:"
    echo "     ${BLUE}lynkr${NC}"
    echo ""
    echo "  3. Configure Claude Code CLI:"
    echo "     ${BLUE}export ANTHROPIC_BASE_URL=http://localhost:8080${NC}"
    echo "     ${BLUE}claude${NC}"
    echo ""
    echo "  ${YELLOW}Option B: Use Cloud Providers (Databricks/OpenAI/Azure)${NC}"
    echo "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "  1. Edit configuration file:"
    echo "     ${BLUE}nano $INSTALL_DIR/.env${NC}"
    echo ""
    echo "     Update these lines:"
    echo "     ${BLUE}MODEL_PROVIDER=databricks${NC}  ${GREEN}← Change from 'ollama'${NC}"
    echo "     ${BLUE}DATABRICKS_API_KEY=dapi_xxxxx${NC}  ${GREEN}← Add your key${NC}"
    echo "     ${BLUE}DATABRICKS_API_BASE=https://your-workspace.databricks.com${NC}"
    echo ""
    echo "  2. Start Lynkr:"
    echo "     ${BLUE}lynkr${NC}"
    echo ""
    echo "  3. Configure Claude Code CLI:"
    echo "     ${BLUE}export ANTHROPIC_BASE_URL=http://localhost:8080${NC}"
    echo "     ${BLUE}export ANTHROPIC_API_KEY=any-non-empty-value${NC}  ${GREEN}← Placeholder${NC}"
    echo "     ${BLUE}claude${NC}"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "💡 ${YELLOW}Tip:${NC} Memory system is enabled by default"
    echo "   Lynkr remembers preferences and project context across sessions"
    echo ""
    echo "📚 Documentation: ${BLUE}https://github.com/vishalveerareddy123/Lynkr${NC}"
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
