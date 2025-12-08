#!/usr/bin/env node

/**
 * Lynkr Setup Wizard
 *
 * Automates the installation and configuration of Ollama with Lynkr.
 * This script:
 * 1. Checks if Ollama is installed
 * 2. Installs Ollama if missing (platform-specific)
 * 3. Starts Ollama service
 * 4. Pulls the qwen2.5-coder model
 * 5. Configures environment
 */

const { execSync, spawn } = require("child_process");
const os = require("os");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

// Color codes for terminal output
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

function log(message, color = "reset") {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function exec(command, options = {}) {
  try {
    return execSync(command, { encoding: "utf-8", ...options });
  } catch (error) {
    return null;
  }
}

function promptUser(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().trim());
    });
  });
}

async function checkOllama() {
  log("\n🔍 Checking for Ollama installation...", "cyan");

  const version = exec("ollama --version");
  if (version) {
    log(`✅ Ollama detected: ${version.trim()}`, "green");
    return true;
  }

  log("❌ Ollama not found", "red");
  return false;
}

async function installOllama() {
  const platform = os.platform();

  log("\n📥 Installing Ollama...", "cyan");
  log(`   Platform: ${platform}`, "blue");

  try {
    if (platform === "darwin") {
      // macOS
      log("\n   Using Homebrew to install Ollama...", "blue");
      log("   This may take a few minutes...\n", "yellow");

      // Check if brew is installed
      const brewVersion = exec("brew --version");
      if (!brewVersion) {
        log("❌ Homebrew not found. Please install from: https://brew.sh", "red");
        log("   Or install Ollama manually from: https://ollama.ai/download", "yellow");
        process.exit(1);
      }

      execSync("brew install ollama", { stdio: "inherit" });
      log("\n✅ Ollama installed successfully", "green");

    } else if (platform === "linux") {
      // Linux
      log("\n   Using official install script...", "blue");
      log("   This may take a few minutes...\n", "yellow");

      execSync("curl -fsSL https://ollama.ai/install.sh | sh", {
        stdio: "inherit",
        shell: "/bin/bash"
      });
      log("\n✅ Ollama installed successfully", "green");

    } else if (platform === "win32") {
      // Windows
      log("\n❌ Automatic installation not supported on Windows", "red");
      log("\n   Please download and install Ollama manually:", "yellow");
      log("   https://ollama.ai/download\n", "bright");
      log("   After installation, run: lynkr-setup", "cyan");
      process.exit(1);

    } else {
      log(`\n❌ Unsupported platform: ${platform}`, "red");
      log("   Please install Ollama manually from: https://ollama.ai", "yellow");
      process.exit(1);
    }

    return true;
  } catch (error) {
    log(`\n❌ Failed to install Ollama: ${error.message}`, "red");
    log("   Please install manually from: https://ollama.ai/download", "yellow");
    return false;
  }
}

async function startOllama() {
  log("\n🚀 Starting Ollama service...", "cyan");

  // Check if Ollama is already running
  const isRunning = exec("pgrep -x ollama") || exec("curl -s http://localhost:11434/api/tags");

  if (isRunning) {
    log("✅ Ollama is already running", "green");
    return true;
  }

  // Start Ollama in background
  const platform = os.platform();

  if (platform === "darwin") {
    // macOS - use brew services
    try {
      execSync("brew services start ollama", { stdio: "ignore" });
      log("✅ Ollama service started via Homebrew", "green");
    } catch {
      // Fallback to manual start
      spawn("ollama", ["serve"], {
        detached: true,
        stdio: "ignore",
      }).unref();
      log("✅ Ollama started in background", "green");
    }
  } else if (platform === "linux") {
    // Linux - check for systemd
    const hasSystemd = exec("which systemctl");

    if (hasSystemd) {
      try {
        execSync("sudo systemctl start ollama", { stdio: "inherit" });
        log("✅ Ollama service started via systemd", "green");
      } catch {
        // Fallback to manual start
        spawn("ollama", ["serve"], {
          detached: true,
          stdio: "ignore",
        }).unref();
        log("✅ Ollama started in background", "green");
      }
    } else {
      spawn("ollama", ["serve"], {
        detached: true,
        stdio: "ignore",
      }).unref();
      log("✅ Ollama started in background", "green");
    }
  }

  // Wait for Ollama to be ready
  log("   Waiting for Ollama to be ready...", "blue");

  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const ready = exec("curl -s http://localhost:11434/api/tags");
    if (ready) {
      log("✅ Ollama is ready", "green");
      return true;
    }
  }

  log("⚠️  Ollama may not be ready yet, continuing anyway...", "yellow");
  return true;
}

async function pullModel(modelName = "qwen2.5-coder:latest") {
  log(`\n📦 Downloading ${modelName} model...`, "cyan");
  log("   Model size: ~4.7GB", "blue");
  log("   This may take 10-30 minutes depending on your connection.", "yellow");
  log("   You can cancel and run this later with: ollama pull qwen2.5-coder:latest\n", "yellow");

  const answer = await promptUser("   Continue with model download? [Y/n]: ");

  if (answer === "n" || answer === "no") {
    log("\n⏭️  Skipping model download", "yellow");
    log("   You can download it later with: ollama pull qwen2.5-coder:latest", "cyan");
    return false;
  }

  try {
    execSync(`ollama pull ${modelName}`, { stdio: "inherit" });
    log(`\n✅ Model ${modelName} downloaded successfully`, "green");
    return true;
  } catch (error) {
    log(`\n❌ Failed to download model: ${error.message}`, "red");
    log("   You can download it later with: ollama pull qwen2.5-coder:latest", "yellow");
    return false;
  }
}

async function createEnvFile() {
  log("\n⚙️  Configuring environment...", "cyan");

  const envPath = path.join(process.cwd(), ".env");
  const envExamplePath = path.join(__dirname, "..", ".env.example");

  // Check if .env already exists
  if (fs.existsSync(envPath)) {
    log("   .env file already exists", "blue");
    const answer = await promptUser("   Overwrite? [y/N]: ");

    if (answer !== "y" && answer !== "yes") {
      log("   Keeping existing .env file", "yellow");
      return;
    }
  }

  // Copy .env.example to .env if it exists
  if (fs.existsSync(envExamplePath)) {
    fs.copyFileSync(envExamplePath, envPath);
    log("✅ Created .env file from template", "green");
    log("\n   ⚠️  Please edit .env and add your Databricks credentials:", "yellow");
    log("   - DATABRICKS_API_BASE", "cyan");
    log("   - DATABRICKS_API_KEY", "cyan");
  } else {
    // Create minimal .env file
    const envContent = `# Lynkr Configuration
PREFER_OLLAMA=true
OLLAMA_ENDPOINT=http://localhost:11434
OLLAMA_MODEL=qwen2.5-coder:latest
OLLAMA_FALLBACK_PROVIDER=databricks
OLLAMA_FALLBACK_ENABLED=true

# Add your Databricks credentials below
DATABRICKS_API_BASE=https://your-workspace.cloud.databricks.com
DATABRICKS_API_KEY=your-databricks-pat-token

PORT=8080
LOG_LEVEL=info
`;

    fs.writeFileSync(envPath, envContent);
    log("✅ Created .env file with default configuration", "green");
    log("\n   ⚠️  Please edit .env and add your Databricks credentials:", "yellow");
    log("   - DATABRICKS_API_BASE", "cyan");
    log("   - DATABRICKS_API_KEY", "cyan");
  }
}

async function printSummary(modelDownloaded) {
  log("\n" + "=".repeat(60), "green");
  log("🎉 Lynkr Setup Complete!", "green");
  log("=".repeat(60), "green");

  log("\n📋 What was installed:", "cyan");
  log("   ✅ Ollama service", "green");
  if (modelDownloaded) {
    log("   ✅ qwen2.5-coder:latest model", "green");
  } else {
    log("   ⏭️  Model (skipped - run: ollama pull qwen2.5-coder:latest)", "yellow");
  }

  log("\n🚀 Next Steps:", "cyan");

  if (!modelDownloaded) {
    log("   1. Download model: ollama pull qwen2.5-coder:latest", "blue");
    log("   2. Edit .env with your Databricks credentials", "blue");
    log("   3. Start Lynkr: lynkr", "blue");
  } else {
    log("   1. Edit .env with your Databricks credentials", "blue");
    log("   2. Start Lynkr: lynkr", "blue");
  }

  log("\n📚 Documentation:", "cyan");
  log("   - README.md - Full documentation", "blue");
  log("   - DEPLOYMENT.md - Deployment options", "blue");
  log("   - TESTING.md - Testing guide", "blue");

  log("\n💡 Quick Commands:", "cyan");
  log("   lynkr                    Start Lynkr server", "blue");
  log("   ollama list              List downloaded models", "blue");
  log("   ollama pull <model>      Download a model", "blue");
  log("   ollama serve             Start Ollama manually", "blue");

  log("\n🌐 Endpoints:", "cyan");
  log("   http://localhost:8080    Lynkr API", "blue");
  log("   http://localhost:11434   Ollama API", "blue");

  log("\n");
}

async function main() {
  log("\n" + "=".repeat(60), "bright");
  log("🔧 Lynkr Setup Wizard", "bright");
  log("=".repeat(60), "bright");
  log("\nThis wizard will help you set up Lynkr with Ollama.", "blue");
  log("Ollama enables local, cost-free AI inference with hybrid routing.\n", "blue");

  try {
    // Step 1: Check/Install Ollama
    const ollamaExists = await checkOllama();

    if (!ollamaExists) {
      const answer = await promptUser("\nInstall Ollama automatically? [Y/n]: ");

      if (answer === "n" || answer === "no") {
        log("\n⏭️  Skipping Ollama installation", "yellow");
        log("   Please install manually from: https://ollama.ai/download", "cyan");
        log("   Then run: lynkr-setup", "cyan");
        process.exit(0);
      }

      const installed = await installOllama();
      if (!installed) {
        process.exit(1);
      }
    }

    // Step 2: Start Ollama
    await startOllama();

    // Step 3: Pull Model
    const modelDownloaded = await pullModel();

    // Step 4: Create .env file
    await createEnvFile();

    // Step 5: Print summary
    await printSummary(modelDownloaded);

  } catch (error) {
    log(`\n❌ Setup failed: ${error.message}`, "red");
    log("   Please check the error and try again", "yellow");
    log("   Or install manually: https://ollama.ai/download", "cyan");
    process.exit(1);
  }
}

// Run setup
main();
