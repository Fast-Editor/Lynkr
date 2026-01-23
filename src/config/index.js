const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

function trimTrailingSlash(value) {
  if (typeof value !== "string") return value;
  return value.replace(/\/$/, "");
}

function parseJson(value, fallback = null) {
  if (typeof value !== "string" || value.trim().length === 0) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseList(value, options = {}) {
  if (typeof value !== "string" || value.trim().length === 0) return [];
  const separator = options.separator ?? ",";
  return value
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseMountList(value) {
  if (typeof value !== "string" || value.trim().length === 0) return [];
  return value
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split(":");
      if (parts.length < 2) return null;
      const host = parts[0]?.trim();
      const container = parts[1]?.trim();
      const mode = parts[2]?.trim() || "rw";
      if (!host || !container) return null;
      return {
        host: path.resolve(host),
        container,
        mode,
      };
    })
    .filter(Boolean);
}

function resolveConfigPath(targetPath) {
  if (typeof targetPath !== "string" || targetPath.trim().length === 0) {
    return null;
  }
  let normalised = targetPath.trim();
  if (normalised.startsWith("~")) {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (home) {
      normalised = path.join(home, normalised.slice(1));
    }
  }
  return path.resolve(normalised);
}

const SUPPORTED_MODEL_PROVIDERS = new Set(["databricks", "azure-anthropic", "ollama", "openrouter", "azure-openai", "openai", "llamacpp", "lmstudio", "bedrock"]);
const rawModelProvider = (process.env.MODEL_PROVIDER ?? "databricks").toLowerCase();

// Validate MODEL_PROVIDER early with a clear error message
if (!SUPPORTED_MODEL_PROVIDERS.has(rawModelProvider)) {
  const supportedList = Array.from(SUPPORTED_MODEL_PROVIDERS).sort().join(", ");
  throw new Error(
    `Unsupported MODEL_PROVIDER: "${process.env.MODEL_PROVIDER}". ` +
    `Valid options are: ${supportedList}`
  );
}

const modelProvider = rawModelProvider;

const rawBaseUrl = trimTrailingSlash(process.env.DATABRICKS_API_BASE);
const apiKey = process.env.DATABRICKS_API_KEY;

const azureAnthropicEndpoint = process.env.AZURE_ANTHROPIC_ENDPOINT ?? null;
const azureAnthropicApiKey = process.env.AZURE_ANTHROPIC_API_KEY ?? null;
const azureAnthropicVersion = process.env.AZURE_ANTHROPIC_VERSION ?? "2023-06-01";

const ollamaEndpoint = process.env.OLLAMA_ENDPOINT ?? "http://localhost:11434";
const ollamaModel = process.env.OLLAMA_MODEL ?? "qwen2.5-coder:7b";
const ollamaTimeout = Number.parseInt(process.env.OLLAMA_TIMEOUT_MS ?? "120000", 10);

// Ollama cluster configuration
function loadOllamaClusterConfig() {
  const configPath = process.env.OLLAMA_CLUSTER_CONFIG
    ?? path.join(process.cwd(), ".lynkr", "ollama-cluster.json");

  try {
    const fs = require("fs");
    if (!fs.existsSync(configPath)) {
      return null; // No cluster config, use single-host mode
    }

    const configFile = fs.readFileSync(configPath, "utf8");
    const config = JSON.parse(configFile);

    // Validate configuration
    if (!config.enabled) {
      return null; // Cluster disabled
    }

    const errors = validateOllamaClusterConfig(config);
    if (errors.length > 0) {
      throw new Error(`Ollama cluster configuration errors:\n${errors.join("\n")}`);
    }

    return config;
  } catch (err) {
    if (err.code === "ENOENT") {
      return null; // File doesn't exist, use single-host mode
    }
    throw new Error(`Failed to load Ollama cluster config from ${configPath}: ${err.message}`);
  }
}

function validateOllamaClusterConfig(config) {
  const errors = [];

  if (!config.hosts || !Array.isArray(config.hosts) || config.hosts.length === 0) {
    errors.push("At least one Ollama host must be configured in 'hosts' array");
    return errors; // Return early if no hosts
  }

  const seenIds = new Set();
  const seenEndpoints = new Set();

  config.hosts.forEach((host, idx) => {
    // Check required fields
    if (!host.endpoint) {
      errors.push(`Host ${idx}: 'endpoint' is required`);
    } else {
      // Check URL format
      try {
        new URL(host.endpoint);
      } catch {
        errors.push(`Host ${idx}: invalid endpoint URL "${host.endpoint}"`);
      }

      // Check for duplicate endpoints
      if (seenEndpoints.has(host.endpoint)) {
        errors.push(`Host ${idx}: duplicate endpoint "${host.endpoint}"`);
      }
      seenEndpoints.add(host.endpoint);
    }

    // Check ID
    if (!host.id) {
      errors.push(`Host ${idx}: 'id' is required`);
    } else if (seenIds.has(host.id)) {
      errors.push(`Host ${idx}: duplicate ID "${host.id}"`);
    } else {
      seenIds.add(host.id);
    }

    // Validate ranges
    if (host.weight !== undefined && host.weight < 1) {
      errors.push(`Host ${host.id || idx}: weight must be >= 1 (got ${host.weight})`);
    }

    if (host.maxConcurrent !== undefined && host.maxConcurrent < 1) {
      errors.push(`Host ${host.id || idx}: maxConcurrent must be >= 1 (got ${host.maxConcurrent})`);
    }

    if (host.timeout !== undefined && host.timeout < 1000) {
      errors.push(`Host ${host.id || idx}: timeout must be >= 1000ms (got ${host.timeout})`);
    }
  });

  // Validate load balancing strategy
  const validStrategies = [
    "round-robin",
    "weighted-round-robin",
    "least-connections",
    "response-time-weighted",
    "model-based",
    "random"
  ];

  if (config.loadBalancing && !validStrategies.includes(config.loadBalancing)) {
    errors.push(
      `Invalid loadBalancing strategy "${config.loadBalancing}". ` +
      `Must be one of: ${validStrategies.join(", ")}`
    );
  }

  return errors;
}

const ollamaClusterConfig = loadOllamaClusterConfig();

// OpenRouter configuration
const openRouterApiKey = process.env.OPENROUTER_API_KEY ?? null;
const openRouterModel = process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini";
const openRouterEndpoint = process.env.OPENROUTER_ENDPOINT ?? "https://openrouter.ai/api/v1/chat/completions";

// Azure OpenAI configuration
const azureOpenAIEndpoint = process.env.AZURE_OPENAI_ENDPOINT?.trim() || null;
const azureOpenAIApiKey = process.env.AZURE_OPENAI_API_KEY?.trim() || null;
const azureOpenAIDeployment = process.env.AZURE_OPENAI_DEPLOYMENT?.trim() || "gpt-4o";
const azureOpenAIApiVersion = process.env.AZURE_OPENAI_API_VERSION?.trim() || "2024-08-01-preview";

// OpenAI configuration
const openAIApiKey = process.env.OPENAI_API_KEY?.trim() || null;
const openAIModel = process.env.OPENAI_MODEL?.trim() || "gpt-4o";
const openAIEndpoint = process.env.OPENAI_ENDPOINT?.trim() || "https://api.openai.com/v1/chat/completions";
const openAIOrganization = process.env.OPENAI_ORGANIZATION?.trim() || null;

// llama.cpp configuration
const llamacppEndpoint = process.env.LLAMACPP_ENDPOINT?.trim() || "http://localhost:8080";
const llamacppModel = process.env.LLAMACPP_MODEL?.trim() || "default";
const llamacppTimeout = Number.parseInt(process.env.LLAMACPP_TIMEOUT_MS ?? "120000", 10);
const llamacppApiKey = process.env.LLAMACPP_API_KEY?.trim() || null;

// LM Studio configuration
const lmstudioEndpoint = process.env.LMSTUDIO_ENDPOINT?.trim() || "http://localhost:1234";
const lmstudioModel = process.env.LMSTUDIO_MODEL?.trim() || "default";
const lmstudioTimeout = Number.parseInt(process.env.LMSTUDIO_TIMEOUT_MS ?? "120000", 10);
const lmstudioApiKey = process.env.LMSTUDIO_API_KEY?.trim() || null;

// AWS Bedrock configuration
const bedrockRegion = process.env.AWS_BEDROCK_REGION?.trim() || process.env.AWS_REGION?.trim() || "us-east-1";
const bedrockApiKey = process.env.AWS_BEDROCK_API_KEY?.trim() || null; // Bearer token
const bedrockModelId = process.env.AWS_BEDROCK_MODEL_ID?.trim() || "anthropic.claude-3-5-sonnet-20241022-v2:0";

// Hybrid routing configuration
const preferOllama = process.env.PREFER_OLLAMA === "true";
const fallbackEnabled = process.env.FALLBACK_ENABLED !== "false"; // default true
const ollamaMaxToolsForRouting = Number.parseInt(
  process.env.OLLAMA_MAX_TOOLS_FOR_ROUTING ?? "3",
  10
);
const openRouterMaxToolsForRouting = Number.parseInt(
  process.env.OPENROUTER_MAX_TOOLS_FOR_ROUTING ?? "15",
  10
);

const rawFallbackProvider = (process.env.FALLBACK_PROVIDER ?? "databricks").toLowerCase();

// Validate FALLBACK_PROVIDER early with a clear error message
if (!SUPPORTED_MODEL_PROVIDERS.has(rawFallbackProvider)) {
  const supportedList = Array.from(SUPPORTED_MODEL_PROVIDERS).sort().join(", ");
  throw new Error(
    `Unsupported FALLBACK_PROVIDER: "${process.env.FALLBACK_PROVIDER}". ` +
    `Valid options are: ${supportedList}`
  );
}

const fallbackProvider = rawFallbackProvider;

// Tool execution mode: server (default), client, passthrough, local, or synthetic
const toolExecutionMode = (process.env.TOOL_EXECUTION_MODE ?? "server").toLowerCase();
if (!["server", "client", "passthrough", "local", "synthetic"].includes(toolExecutionMode)) {
  throw new Error(
    "TOOL_EXECUTION_MODE must be one of: server, client, passthrough, local, synthetic (default: server)"
  );
}

// Pattern B Configuration (Lynkr on localhost)
const deploymentMode = (process.env.DEPLOYMENT_MODE ?? "pattern-a").toLowerCase();
const patternBEnabled = deploymentMode === "pattern-b" || toolExecutionMode === "local" || toolExecutionMode === "synthetic";

// Local tool execution settings (Pattern B)
const localToolsEnabled = toolExecutionMode === "local" || toolExecutionMode === "synthetic";
const localToolsAllowedOperations = parseList(
  process.env.LOCAL_TOOLS_ALLOWED_OPERATIONS ?? "readFile,writeFile,listDirectory,executeCommand,searchCode"
);
const localToolsRestrictedPaths = parseList(
  process.env.LOCAL_TOOLS_RESTRICTED_PATHS ?? "/etc,/sys,/proc,/root,~/.ssh,~/.gnupg"
);
const localToolsMaxFileSize = Number.parseInt(
  process.env.LOCAL_TOOLS_MAX_FILE_SIZE ?? "10485760", // 10MB default
  10
);
const localToolsCommandTimeout = Number.parseInt(
  process.env.LOCAL_TOOLS_COMMAND_TIMEOUT ?? "30000", // 30s default
  10
);

// Synthetic mode settings (Pattern B)
const syntheticModeEnabled = toolExecutionMode === "synthetic";
const syntheticModePatterns = process.env.SYNTHETIC_MODE_PATTERNS
  ? parseJson(process.env.SYNTHETIC_MODE_PATTERNS)
  : {
      readFile: ["read.*file", "show.*contents", "display.*file"],
      writeFile: ["write.*to.*file", "save.*to.*file", "create.*file"],
      listDirectory: ["list.*files", "show.*directory", "ls.*"],
      executeCommand: ["run.*command", "execute.*"],
      searchCode: ["search.*for", "find.*in.*files", "grep.*"]
    };

// Remote Ollama configuration (Pattern B)
// When Lynkr runs on localhost but Ollama runs on GPU server
const remoteOllamaEnabled = patternBEnabled;
const remoteOllamaEndpoint = process.env.REMOTE_OLLAMA_ENDPOINT ?? ollamaEndpoint;
const remoteOllamaConnectionPooling = process.env.REMOTE_OLLAMA_CONNECTION_POOLING !== "false"; // default true
const remoteOllamaMaxConnections = Number.parseInt(
  process.env.REMOTE_OLLAMA_MAX_CONNECTIONS ?? "10",
  10
);
const remoteOllamaTimeout = Number.parseInt(
  process.env.REMOTE_OLLAMA_TIMEOUT ?? "300000", // 5 minutes
  10
);

// Memory system configuration (Titans-inspired long-term memory)
const memoryEnabled = process.env.MEMORY_ENABLED !== "false"; // default true
const memoryRetrievalLimit = Number.parseInt(process.env.MEMORY_RETRIEVAL_LIMIT ?? "5", 10);
const memorySurpriseThreshold = Number.parseFloat(process.env.MEMORY_SURPRISE_THRESHOLD ?? "0.3");
const memoryMaxAgeDays = Number.parseInt(process.env.MEMORY_MAX_AGE_DAYS ?? "90", 10);
const memoryMaxCount = Number.parseInt(process.env.MEMORY_MAX_COUNT ?? "10000", 10);
const memoryIncludeGlobal = process.env.MEMORY_INCLUDE_GLOBAL !== "false"; // default true
const memoryInjectionFormat = (process.env.MEMORY_INJECTION_FORMAT ?? "system").toLowerCase();
const memoryExtractionEnabled = process.env.MEMORY_EXTRACTION_ENABLED !== "false"; // default true
const memoryDecayEnabled = process.env.MEMORY_DECAY_ENABLED !== "false"; // default true
const memoryDecayHalfLifeDays = Number.parseInt(process.env.MEMORY_DECAY_HALF_LIFE ?? "30", 10);

// Token optimization settings
const tokenTrackingEnabled = process.env.TOKEN_TRACKING_ENABLED !== "false"; // default true
const toolTruncationEnabled = process.env.TOOL_TRUNCATION_ENABLED !== "false"; // default true
const memoryFormat = (process.env.MEMORY_FORMAT ?? "compact").toLowerCase();
const memoryDedupEnabled = process.env.MEMORY_DEDUP_ENABLED !== "false"; // default true
const memoryDedupLookback = Number.parseInt(process.env.MEMORY_DEDUP_LOOKBACK ?? "5", 10);
const systemPromptMode = (process.env.SYSTEM_PROMPT_MODE ?? "dynamic").toLowerCase();
const toolDescriptions = (process.env.TOOL_DESCRIPTIONS ?? "minimal").toLowerCase();
const historyCompressionEnabled = process.env.HISTORY_COMPRESSION_ENABLED !== "false"; // default true
const historyKeepRecentTurns = Number.parseInt(process.env.HISTORY_KEEP_RECENT_TURNS ?? "10", 10);
const historySummarizeOlder = process.env.HISTORY_SUMMARIZE_OLDER !== "false"; // default true
const tokenBudgetWarning = Number.parseInt(process.env.TOKEN_BUDGET_WARNING ?? "100000", 10);
const tokenBudgetMax = Number.parseInt(process.env.TOKEN_BUDGET_MAX ?? "180000", 10);
const tokenBudgetEnforcement = process.env.TOKEN_BUDGET_ENFORCEMENT !== "false"; // default true

// Smart tool selection configuration (always enabled)
const smartToolSelectionMode = (process.env.SMART_TOOL_SELECTION_MODE ?? "heuristic").toLowerCase();
const smartToolSelectionTokenBudget = Number.parseInt(
  process.env.SMART_TOOL_SELECTION_TOKEN_BUDGET ?? "2500",
  10
);

// Only require Databricks credentials if it's the primary provider or used as fallback
if (modelProvider === "databricks" && (!rawBaseUrl || !apiKey)) {
  throw new Error("Set DATABRICKS_API_BASE and DATABRICKS_API_KEY before starting the proxy.");
} else if (modelProvider === "ollama" && !fallbackEnabled && (!rawBaseUrl || !apiKey)) {
  // Relaxed: Allow mock credentials for true Ollama-only mode (fallback disabled)
  if (!rawBaseUrl) process.env.DATABRICKS_API_BASE = "http://localhost:8080";
  if (!apiKey) process.env.DATABRICKS_API_KEY = "mock-key-for-ollama-only";
  console.log("[CONFIG] Using mock Databricks credentials (Ollama-only mode with fallback disabled)");
}

if (modelProvider === "azure-anthropic" && (!azureAnthropicEndpoint || !azureAnthropicApiKey)) {
  throw new Error(
    "Set AZURE_ANTHROPIC_ENDPOINT and AZURE_ANTHROPIC_API_KEY before starting the proxy.",
  );
}

if (modelProvider === "azure-openai" && (!azureOpenAIEndpoint || !azureOpenAIApiKey)) {
  throw new Error(
    "Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY before starting the proxy.",
  );
}

if (modelProvider === "openai" && !openAIApiKey) {
  throw new Error(
    "Set OPENAI_API_KEY before starting the proxy.",
  );
}

if (modelProvider === "ollama") {
  try {
    new URL(ollamaEndpoint);
  } catch (err) {
    throw new Error("OLLAMA_ENDPOINT must be a valid URL (default: http://localhost:11434)");
  }
}

if (modelProvider === "llamacpp") {
  try {
    new URL(llamacppEndpoint);
  } catch (err) {
    throw new Error("LLAMACPP_ENDPOINT must be a valid URL (default: http://localhost:8080)");
  }
}

if (modelProvider === "lmstudio") {
  try {
    new URL(lmstudioEndpoint);
  } catch (err) {
    throw new Error("LMSTUDIO_ENDPOINT must be a valid URL (default: http://localhost:1234)");
  }
}

// Validate Bedrock credentials when it's the primary provider
if (modelProvider === "bedrock" && !bedrockApiKey) {
  throw new Error(
    "AWS Bedrock requires AWS_BEDROCK_API_KEY (Bearer token). " +
    "Generate from AWS Console → Bedrock → API Keys, then set AWS_BEDROCK_API_KEY in your .env file."
  );
}

// Validate hybrid routing configuration
if (preferOllama) {
  if (!ollamaEndpoint) {
    throw new Error("PREFER_OLLAMA is set but OLLAMA_ENDPOINT is not configured");
  }
  if (fallbackEnabled && !SUPPORTED_MODEL_PROVIDERS.has(fallbackProvider)) {
    throw new Error(
      `FALLBACK_PROVIDER must be one of: ${Array.from(SUPPORTED_MODEL_PROVIDERS).join(", ")}`
    );
  }

  // Prevent local providers from being used as fallback (they can fail just like Ollama)
  const localProviders = ["ollama", "llamacpp", "lmstudio"];
  if (fallbackEnabled && localProviders.includes(fallbackProvider)) {
    throw new Error(`FALLBACK_PROVIDER cannot be '${fallbackProvider}' (local providers should not be fallbacks). Use cloud providers: databricks, azure-anthropic, azure-openai, openrouter, openai, bedrock`);
  }

  // Ensure fallback provider is properly configured (only if fallback is enabled)
  if (fallbackEnabled) {
    if (fallbackProvider === "databricks" && (!rawBaseUrl || !apiKey)) {
      throw new Error("FALLBACK_PROVIDER is set to 'databricks' but DATABRICKS_API_BASE and DATABRICKS_API_KEY are not configured. Please set these environment variables or choose a different fallback provider.");
    }
    if (fallbackProvider === "azure-anthropic" && (!azureAnthropicEndpoint || !azureAnthropicApiKey)) {
      throw new Error("FALLBACK_PROVIDER is set to 'azure-anthropic' but AZURE_ANTHROPIC_ENDPOINT and AZURE_ANTHROPIC_API_KEY are not configured. Please set these environment variables or choose a different fallback provider.");
    }
    if (fallbackProvider === "azure-openai" && (!azureOpenAIEndpoint || !azureOpenAIApiKey)) {
      throw new Error("FALLBACK_PROVIDER is set to 'azure-openai' but AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY are not configured. Please set these environment variables or choose a different fallback provider.");
    }
    if (fallbackProvider === "bedrock" && !bedrockApiKey) {
      throw new Error("FALLBACK_PROVIDER is set to 'bedrock' but AWS_BEDROCK_API_KEY is not configured. Please set this environment variable or choose a different fallback provider.");
    }
  }
}

const endpointPath =
  process.env.DATABRICKS_ENDPOINT_PATH ??
  "/serving-endpoints/databricks-claude-sonnet-4-5/invocations";

const databricksUrl =
  rawBaseUrl && endpointPath
    ? `${rawBaseUrl}${endpointPath.startsWith("/") ? "" : "/"}${endpointPath}`
    : null;

const defaultModel =
  process.env.MODEL_DEFAULT ??
  (modelProvider === "azure-anthropic" ? "claude-opus-4-5" : "databricks-claude-sonnet-4-5");

const port = Number.parseInt(process.env.PORT ?? "8080", 10);
const sessionDbPath =
  process.env.SESSION_DB_PATH ?? path.join(process.cwd(), "data", "sessions.db");
const workspaceRoot = path.resolve(process.env.WORKSPACE_ROOT ?? process.cwd());

// Rate limiting configuration
const rateLimitEnabled = process.env.RATE_LIMIT_ENABLED !== "false"; // default true
const rateLimitWindow = Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "60000", 10); // 1 minute
const rateLimitMax = Number.parseInt(process.env.RATE_LIMIT_MAX ?? "100", 10); // 100 requests per window
const rateLimitKeyBy = process.env.RATE_LIMIT_KEY_BY ?? "session"; // "session", "ip", or "both"

const defaultWebEndpoint = process.env.WEB_SEARCH_ENDPOINT ?? "http://localhost:8888/search";
let webEndpointHost = null;
try {
  const { hostname } = new URL(defaultWebEndpoint);
  webEndpointHost = hostname.toLowerCase();
} catch {
  webEndpointHost = null;
}

const allowAllWebHosts = process.env.WEB_SEARCH_ALLOW_ALL !== "false";
const configuredAllowedHosts =
  process.env.WEB_SEARCH_ALLOWED_HOSTS?.split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean) ?? [];
const webAllowedHosts = allowAllWebHosts
  ? null
  : new Set([webEndpointHost, "localhost", "127.0.0.1"].filter(Boolean).concat(configuredAllowedHosts));
const webTimeoutMs = Number.parseInt(process.env.WEB_SEARCH_TIMEOUT_MS ?? "10000", 10);
const webFetchBodyPreviewMax = Number.parseInt(process.env.WEB_FETCH_BODY_PREVIEW_MAX ?? "10000", 10);
const webSearchRetryEnabled = process.env.WEB_SEARCH_RETRY_ENABLED !== "false"; // default true
const webSearchMaxRetries = Number.parseInt(process.env.WEB_SEARCH_MAX_RETRIES ?? "2", 10);

const policyMaxSteps = Number.parseInt(process.env.POLICY_MAX_STEPS ?? "8", 10);
const policyMaxToolCalls = Number.parseInt(process.env.POLICY_MAX_TOOL_CALLS ?? "12", 10);
const policyDisallowedTools =
  process.env.POLICY_DISALLOWED_TOOLS?.split(",")
    .map((tool) => tool.trim())
    .filter(Boolean) ?? [];
const policyGitAllowPush = process.env.POLICY_GIT_ALLOW_PUSH === "true";
const policyGitAllowPull = process.env.POLICY_GIT_ALLOW_PULL !== "false";
const policyGitAllowCommit = process.env.POLICY_GIT_ALLOW_COMMIT !== "false";
const policyGitTestCommand = process.env.POLICY_GIT_TEST_COMMAND ?? null;
const policyGitRequireTests = process.env.POLICY_GIT_REQUIRE_TESTS === "true";
const policyGitCommitRegex = process.env.POLICY_GIT_COMMIT_REGEX ?? null;
const policyGitAutoStash = process.env.POLICY_GIT_AUTOSTASH === "true";

const policyFileAllowedPaths = parseList(
  process.env.POLICY_FILE_ALLOWED_PATHS ?? "",
);
const policyFileBlockedPaths = parseList(
  process.env.POLICY_FILE_BLOCKED_PATHS ?? "/.env,.env,/etc/passwd,/etc/shadow",
);
const policySafeCommandsEnabled = process.env.POLICY_SAFE_COMMANDS_ENABLED !== "false";
const policySafeCommandsConfig = parseJson(process.env.POLICY_SAFE_COMMANDS_CONFIG ?? "", null);

const sandboxEnabled = process.env.MCP_SANDBOX_ENABLED !== "false";
const sandboxImage = process.env.MCP_SANDBOX_IMAGE ?? null;
const sandboxRuntime = process.env.MCP_SANDBOX_RUNTIME ?? "docker";
const sandboxContainerWorkspace =
  process.env.MCP_SANDBOX_CONTAINER_WORKSPACE ?? "/workspace";
const sandboxMountWorkspace = process.env.MCP_SANDBOX_MOUNT_WORKSPACE !== "false";
const sandboxAllowNetworking = process.env.MCP_SANDBOX_ALLOW_NETWORKING === "true";
const sandboxNetworkMode = sandboxAllowNetworking
  ? process.env.MCP_SANDBOX_NETWORK_MODE ?? "bridge"
  : "none";
const sandboxPassthroughEnv = parseList(
  process.env.MCP_SANDBOX_PASSTHROUGH_ENV ?? "PATH,LANG,LC_ALL,TERM,HOME",
);
const sandboxExtraMounts = parseMountList(process.env.MCP_SANDBOX_EXTRA_MOUNTS ?? "");
const sandboxDefaultTimeoutMs = Number.parseInt(
  process.env.MCP_SANDBOX_TIMEOUT_MS ?? "20000",
  10,
);
const sandboxUser = process.env.MCP_SANDBOX_USER ?? null;
const sandboxEntrypoint = process.env.MCP_SANDBOX_ENTRYPOINT ?? null;
const sandboxReuseSessions = process.env.MCP_SANDBOX_REUSE_SESSION !== "false";
const sandboxReadOnlyRoot = process.env.MCP_SANDBOX_READ_ONLY_ROOT === "true";
const sandboxNoNewPrivileges = process.env.MCP_SANDBOX_NO_NEW_PRIVILEGES !== "false";
const sandboxDropCapabilities = parseList(
  process.env.MCP_SANDBOX_DROP_CAPABILITIES ?? "ALL",
);
const sandboxAddCapabilities = parseList(
  process.env.MCP_SANDBOX_ADD_CAPABILITIES ?? "",
);
const sandboxMemoryLimit = process.env.MCP_SANDBOX_MEMORY_LIMIT ?? "512m";
const sandboxCpuLimit = process.env.MCP_SANDBOX_CPU_LIMIT ?? "1.0";
const sandboxPidsLimit = Number.parseInt(
  process.env.MCP_SANDBOX_PIDS_LIMIT ?? "100",
  10,
);

const sandboxPermissionMode =
  (process.env.MCP_SANDBOX_PERMISSION_MODE ?? "auto").toLowerCase();
const sandboxPermissionAllow = parseList(process.env.MCP_SANDBOX_PERMISSION_ALLOW ?? "");
const sandboxPermissionDeny = parseList(process.env.MCP_SANDBOX_PERMISSION_DENY ?? "");

const sandboxManifestPath = resolveConfigPath(process.env.MCP_SERVER_MANIFEST ?? null);

let manifestDirList = null;
if (process.env.MCP_MANIFEST_DIRS === "") {
  manifestDirList = [];
} else if (process.env.MCP_MANIFEST_DIRS) {
  manifestDirList = parseList(process.env.MCP_MANIFEST_DIRS);
} else {
  manifestDirList = ["~/.claude/mcp"];
}
const sandboxManifestDirs = manifestDirList
  .map((dir) => resolveConfigPath(dir))
  .filter((dir) => typeof dir === "string" && dir.length > 0);

const promptCacheEnabled = process.env.PROMPT_CACHE_ENABLED !== "false";
const promptCacheMaxEntriesRaw = Number.parseInt(
  process.env.PROMPT_CACHE_MAX_ENTRIES ?? "64",
  10,
);
const promptCacheTtlRaw = Number.parseInt(
  process.env.PROMPT_CACHE_TTL_MS ?? "300000",
  10,
);

const testDefaultCommand = process.env.WORKSPACE_TEST_COMMAND ?? null;
const testDefaultArgs = parseList(process.env.WORKSPACE_TEST_ARGS ?? "");
const testTimeoutMs = Number.parseInt(process.env.WORKSPACE_TEST_TIMEOUT_MS ?? "600000", 10);
const testSandboxMode = (process.env.WORKSPACE_TEST_SANDBOX ?? "auto").toLowerCase();
let testCoverageFiles = parseList(
  process.env.WORKSPACE_TEST_COVERAGE_FILES ?? "coverage/coverage-summary.json",
);
if (testCoverageFiles.length === 0) {
  testCoverageFiles = [];
}
const testProfiles = parseJson(process.env.WORKSPACE_TEST_PROFILES ?? "", null);

// Agents configuration
const agentsEnabled = process.env.AGENTS_ENABLED === "true";
const agentsMaxConcurrent = Number.parseInt(process.env.AGENTS_MAX_CONCURRENT ?? "10", 10);
const agentsDefaultModel = process.env.AGENTS_DEFAULT_MODEL ?? "haiku";
const agentsMaxSteps = Number.parseInt(process.env.AGENTS_MAX_STEPS ?? "15", 10);
const agentsTimeout = Number.parseInt(process.env.AGENTS_TIMEOUT ?? "120000", 10);

// LLM Audit logging configuration
const auditEnabled = process.env.LLM_AUDIT_ENABLED === "true"; // default false
const auditLogFile = process.env.LLM_AUDIT_LOG_FILE ?? path.join(process.cwd(), "logs", "llm-audit.log");
const auditMaxContentLength = Number.parseInt(process.env.LLM_AUDIT_MAX_CONTENT_LENGTH ?? "5000", 10);
const auditMaxFiles = Number.parseInt(process.env.LLM_AUDIT_MAX_FILES ?? "30", 10);
const auditMaxSize = process.env.LLM_AUDIT_MAX_SIZE ?? "100M";

// LLM Audit deduplication configuration
const auditDeduplicationEnabled = process.env.LLM_AUDIT_DEDUP_ENABLED !== "false"; // default true
const auditDeduplicationDictPath =
  process.env.LLM_AUDIT_DEDUP_DICT_PATH ?? path.join(process.cwd(), "logs", "llm-audit-dictionary.jsonl");
const auditDeduplicationMinSize = Number.parseInt(process.env.LLM_AUDIT_DEDUP_MIN_SIZE ?? "500", 10);
const auditDeduplicationCacheSize = Number.parseInt(process.env.LLM_AUDIT_DEDUP_CACHE_SIZE ?? "100", 10);

const config = {
  env: process.env.NODE_ENV ?? "development",
  port: Number.isNaN(port) ? 8080 : port,
  databricks: {
    baseUrl: rawBaseUrl,
    apiKey,
    endpointPath,
    url: databricksUrl,
  },
  azureAnthropic: {
    endpoint: azureAnthropicEndpoint,
    apiKey: azureAnthropicApiKey,
    version: azureAnthropicVersion,
  },
  ollama: {
    endpoint: ollamaEndpoint,
    model: ollamaModel,
    timeout: Number.isNaN(ollamaTimeout) ? 120000 : ollamaTimeout,
    cluster: ollamaClusterConfig, // null if cluster not configured
  },
  openrouter: {
    apiKey: openRouterApiKey,
    model: openRouterModel,
    endpoint: openRouterEndpoint,
  },
  azureOpenAI: {
    endpoint: azureOpenAIEndpoint,
    apiKey: azureOpenAIApiKey,
    deployment: azureOpenAIDeployment,
    apiVersion: azureOpenAIApiVersion
  },
  openai: {
    apiKey: openAIApiKey,
    model: openAIModel,
    endpoint: openAIEndpoint,
    organization: openAIOrganization,
  },
  llamacpp: {
    endpoint: llamacppEndpoint,
    model: llamacppModel,
    timeout: Number.isNaN(llamacppTimeout) ? 120000 : llamacppTimeout,
    apiKey: llamacppApiKey,
  },
  lmstudio: {
    endpoint: lmstudioEndpoint,
    model: lmstudioModel,
    timeout: Number.isNaN(lmstudioTimeout) ? 120000 : lmstudioTimeout,
    apiKey: lmstudioApiKey,
  },
  bedrock: {
    region: bedrockRegion,
    apiKey: bedrockApiKey,
    modelId: bedrockModelId,
  },
  modelProvider: {
    type: modelProvider,
    defaultModel,
    // Hybrid routing settings
    preferOllama,
    fallbackEnabled,
    ollamaMaxToolsForRouting,
    openRouterMaxToolsForRouting,
    fallbackProvider,
  },
  toolExecutionMode,
  patternB: {
    enabled: patternBEnabled,
    deploymentMode,
    localTools: {
      enabled: localToolsEnabled,
      allowedOperations: localToolsAllowedOperations,
      restrictedPaths: localToolsRestrictedPaths,
      maxFileSize: localToolsMaxFileSize,
      commandTimeout: localToolsCommandTimeout,
    },
    syntheticMode: {
      enabled: syntheticModeEnabled,
      patterns: syntheticModePatterns,
    },
    remoteOllama: {
      enabled: remoteOllamaEnabled,
      endpoint: remoteOllamaEndpoint,
      connectionPooling: remoteOllamaConnectionPooling,
      maxConnections: remoteOllamaMaxConnections,
      timeout: remoteOllamaTimeout,
    },
  },
  gpuDiscovery: {
    enabled: process.env.GPU_DISCOVERY_ENABLED !== "false", // default true
    probe_on_startup: process.env.GPU_DISCOVERY_PROBE_ON_STARTUP !== "false", // default true
    probe_local: process.env.GPU_DISCOVERY_PROBE_LOCAL !== "false", // default true
    health_check_interval_seconds: Number.parseInt(
      process.env.GPU_DISCOVERY_HEALTH_CHECK_INTERVAL ?? "300", // 5 minutes
      10
    ),
    nvidia_smi_timeout_ms: Number.parseInt(
      process.env.GPU_DISCOVERY_NVIDIA_SMI_TIMEOUT ?? "5000",
      10
    ),
    cache_path: process.env.GPU_DISCOVERY_CACHE_PATH || "/tmp/lynkr_gpu_inventory.json",
    detection_method: (process.env.GPU_DISCOVERY_METHOD ?? "auto").toLowerCase(), // "auto" | "ollama-api" | "nvidia-smi"
    ssh_config: {
      enabled: process.env.GPU_DISCOVERY_SSH_ENABLED === "true",
      user: process.env.GPU_DISCOVERY_SSH_USER || null,
      key_path: process.env.GPU_DISCOVERY_SSH_KEY_PATH || "~/.ssh/id_rsa",
    },
  },
  gpuOrchestration: {
    enabled: process.env.GPU_ORCHESTRATION_ENABLED !== "false", // default true
    auto_profile_new_models: process.env.GPU_ORCHESTRATION_AUTO_PROFILE !== "false", // default true
    model_profiles_path: process.env.GPU_ORCHESTRATION_PROFILES_PATH || "/tmp/ollama_model_profiles.json",
  },
  taskModels: {
    // User can override via ~/.lynkr/config.json or environment
    // Format: TASK_MODELS_<TASK>_PRIMARY, TASK_MODELS_<TASK>_FALLBACK
    planning: {
      primary: process.env.TASK_MODELS_PLANNING_PRIMARY || "qwen2.5:14b",
      fallback: process.env.TASK_MODELS_PLANNING_FALLBACK || "llama3.1:8b",
    },
    coding: {
      primary: process.env.TASK_MODELS_CODING_PRIMARY || "qwen2.5-coder:32b",
      fallback: process.env.TASK_MODELS_CODING_FALLBACK || "qwen2.5-coder:7b",
    },
    debugging: {
      primary: process.env.TASK_MODELS_DEBUGGING_PRIMARY || "deepseek-coder-v2:16b",
      fallback: process.env.TASK_MODELS_DEBUGGING_FALLBACK || "llama3.1:8b",
    },
    refactoring: {
      primary: process.env.TASK_MODELS_REFACTORING_PRIMARY || "qwen2.5-coder:32b",
      fallback: process.env.TASK_MODELS_REFACTORING_FALLBACK || "qwen2.5:14b",
    },
    documentation: {
      primary: process.env.TASK_MODELS_DOCUMENTATION_PRIMARY || "llama3.2:11b",
      fallback: process.env.TASK_MODELS_DOCUMENTATION_FALLBACK || "llama3.1:8b",
    },
    testing: {
      primary: process.env.TASK_MODELS_TESTING_PRIMARY || "qwen2.5-coder:14b",
      fallback: process.env.TASK_MODELS_TESTING_FALLBACK || "llama3.1:8b",
    },
    review: {
      primary: process.env.TASK_MODELS_REVIEW_PRIMARY || "qwen2.5:14b",
      fallback: process.env.TASK_MODELS_REVIEW_FALLBACK || "llama3.1:8b",
    },
    analysis: {
      primary: process.env.TASK_MODELS_ANALYSIS_PRIMARY || "qwen2.5:14b",
      fallback: process.env.TASK_MODELS_ANALYSIS_FALLBACK || "llama3.1:8b",
    },
    general: {
      primary: process.env.TASK_MODELS_GENERAL_PRIMARY || "llama3.1:8b",
      fallback: process.env.TASK_MODELS_GENERAL_FALLBACK || "llama3.1:8b",
    },
  },
  palMcp: {
    enabled: process.env.PAL_MCP_ENABLED === "true",
    serverPath: process.env.PAL_MCP_SERVER_PATH || path.join(__dirname, "../../external/pal-mcp-server"),
    pythonPath: process.env.PAL_MCP_PYTHON_PATH || "python3",
    autoStart: process.env.PAL_MCP_AUTO_START !== "false", // default true if enabled
    // Orchestration settings (for avoiding expensive cloud fallback)
    useForComplexRequests: process.env.PAL_MCP_USE_FOR_COMPLEX_REQUESTS !== "false", // default true if enabled
    maxToolsBeforeOrchestration: Number.parseInt(
      process.env.PAL_MCP_MAX_TOOLS_BEFORE_ORCHESTRATION ?? "3",
      10
    ),
  },
  server: {
    jsonLimit: process.env.REQUEST_JSON_LIMIT ?? "1gb",
  },
  rateLimit: {
    enabled: rateLimitEnabled,
    windowMs: rateLimitWindow,
    max: rateLimitMax,
    keyBy: rateLimitKeyBy,
  },
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
  },
  sessionStore: {
    dbPath: sessionDbPath,
  },
  workspace: {
    root: workspaceRoot,
  },
  webSearch: {
    endpoint: defaultWebEndpoint,
    apiKey: process.env.WEB_SEARCH_API_KEY ?? null,
    allowedHosts: allowAllWebHosts ? null : Array.from(webAllowedHosts ?? []),
    allowAllHosts: allowAllWebHosts,
    enabled: true,
    timeoutMs: Number.isNaN(webTimeoutMs) ? 10000 : webTimeoutMs,
    bodyPreviewMax: Number.isNaN(webFetchBodyPreviewMax) ? 10000 : webFetchBodyPreviewMax,
    retryEnabled: webSearchRetryEnabled,
    maxRetries: Number.isNaN(webSearchMaxRetries) ? 2 : webSearchMaxRetries,
  },
  policy: {
    maxStepsPerTurn: Number.isNaN(policyMaxSteps) ? 8 : policyMaxSteps,
    maxToolCallsPerTurn: Number.isNaN(policyMaxToolCalls) ? 12 : policyMaxToolCalls,
    disallowedTools: policyDisallowedTools,
    git: {
      allowPush: policyGitAllowPush,
      allowPull: policyGitAllowPull,
      allowCommit: policyGitAllowCommit,
      testCommand: policyGitTestCommand,
      requireTests: policyGitRequireTests,
      commitMessageRegex: policyGitCommitRegex,
      autoStash: policyGitAutoStash,
    },
    fileAccess: {
      allowedPaths: policyFileAllowedPaths,
      blockedPaths: policyFileBlockedPaths,
    },
    safeCommandsEnabled: policySafeCommandsEnabled,
    safeCommands: policySafeCommandsConfig,
  },
  mcp: {
    sandbox: {
      enabled: sandboxEnabled && Boolean(sandboxImage),
      runtime: sandboxRuntime,
      image: sandboxImage,
      containerWorkspace: sandboxContainerWorkspace,
      mountWorkspace: sandboxMountWorkspace,
      allowNetworking: sandboxAllowNetworking,
      networkMode: sandboxNetworkMode,
      passthroughEnv: sandboxPassthroughEnv,
      extraMounts: sandboxExtraMounts,
      defaultTimeoutMs: Number.isNaN(sandboxDefaultTimeoutMs)
        ? 20000
        : sandboxDefaultTimeoutMs,
      user: sandboxUser,
      entrypoint: sandboxEntrypoint,
      reuseSession: sandboxReuseSessions,
      readOnlyRoot: sandboxReadOnlyRoot,
      noNewPrivileges: sandboxNoNewPrivileges,
      dropCapabilities: sandboxDropCapabilities,
      addCapabilities: sandboxAddCapabilities,
      memoryLimit: sandboxMemoryLimit,
      cpuLimit: sandboxCpuLimit,
      pidsLimit: Number.isNaN(sandboxPidsLimit) ? 100 : sandboxPidsLimit,
    },
    permissions: {
      mode: ["auto", "require", "deny"].includes(sandboxPermissionMode)
        ? sandboxPermissionMode
        : "auto",
      allow: sandboxPermissionAllow,
      deny: sandboxPermissionDeny,
    },
    servers: {
      manifestPath: sandboxManifestPath,
      manifestDirs: sandboxManifestDirs,
    },
  },
  promptCache: {
    enabled: promptCacheEnabled,
    maxEntries: Number.isNaN(promptCacheMaxEntriesRaw) ? 64 : promptCacheMaxEntriesRaw,
    ttlMs: Number.isNaN(promptCacheTtlRaw) ? 300000 : promptCacheTtlRaw,
  },
  agents: {
    enabled: agentsEnabled,
    maxConcurrent: Number.isNaN(agentsMaxConcurrent) ? 10 : agentsMaxConcurrent,
    defaultModel: agentsDefaultModel,
    maxSteps: Number.isNaN(agentsMaxSteps) ? 15 : agentsMaxSteps,
    timeout: Number.isNaN(agentsTimeout) ? 120000 : agentsTimeout,
  },
  tests: {
    defaultCommand: testDefaultCommand ? testDefaultCommand.trim() : null,
    defaultArgs: testDefaultArgs,
    timeoutMs: Number.isNaN(testTimeoutMs) ? 600000 : testTimeoutMs,
    sandbox: ["always", "never", "auto"].includes(testSandboxMode) ? testSandboxMode : "auto",
    coverage: {
      files: testCoverageFiles,
    },
    profiles: Array.isArray(testProfiles) ? testProfiles : null,
  },
  memory: {
    enabled: memoryEnabled,
    retrievalLimit: Number.isNaN(memoryRetrievalLimit) ? 5 : memoryRetrievalLimit,
    surpriseThreshold: Number.isNaN(memorySurpriseThreshold) ? 0.3 : memorySurpriseThreshold,
    maxAgeDays: Number.isNaN(memoryMaxAgeDays) ? 90 : memoryMaxAgeDays,
    maxCount: Number.isNaN(memoryMaxCount) ? 10000 : memoryMaxCount,
    includeGlobalMemories: memoryIncludeGlobal,
    injectionFormat: ["system", "assistant_preamble"].includes(memoryInjectionFormat)
      ? memoryInjectionFormat
      : "system",
    format: memoryFormat,
    dedupEnabled: memoryDedupEnabled,
    dedupLookback: memoryDedupLookback,
    extraction: {
      enabled: memoryExtractionEnabled,
    },
    decay: {
      enabled: memoryDecayEnabled,
      halfLifeDays: Number.isNaN(memoryDecayHalfLifeDays) ? 30 : memoryDecayHalfLifeDays,
    },
  },
  tokenTracking: {
    enabled: tokenTrackingEnabled,
  },
  toolTruncation: {
    enabled: toolTruncationEnabled,
  },
  systemPrompt: {
    mode: systemPromptMode,
    toolDescriptions: toolDescriptions,
  },
  historyCompression: {
    enabled: historyCompressionEnabled,
    keepRecentTurns: historyKeepRecentTurns,
    summarizeOlder: historySummarizeOlder,
  },
  tokenBudget: {
    warning: tokenBudgetWarning,
    max: tokenBudgetMax,
    enforcement: tokenBudgetEnforcement,
  },
  smartToolSelection: {
    enabled: true,  // HARDCODED - always enabled
    mode: smartToolSelectionMode,
    tokenBudget: smartToolSelectionTokenBudget,
    minimalMode: false,  // HARDCODED - disabled
  },
  security: {
    // Content filtering
    contentFilterEnabled: process.env.SECURITY_CONTENT_FILTER_ENABLED !== "false", // default true
    blockOnDetection: process.env.SECURITY_BLOCK_ON_DETECTION !== "false", // default true

    // Rate limiting
    rateLimitEnabled: process.env.SECURITY_RATE_LIMIT_ENABLED !== "false", // default true
    perIpLimit: Number.parseInt(process.env.SECURITY_PER_IP_LIMIT ?? "100", 10), // requests per minute
    perEndpointLimit: Number.parseInt(process.env.SECURITY_PER_ENDPOINT_LIMIT ?? "1000", 10), // requests per minute

    // Audit logging
    auditLogEnabled: process.env.SECURITY_AUDIT_LOG_ENABLED !== "false", // default true
    auditLogDir: process.env.SECURITY_AUDIT_LOG_DIR ?? path.join(process.cwd(), "logs"),
  },
  audit: {
    enabled: auditEnabled,
    logFile: auditLogFile,
    maxContentLength: Number.isNaN(auditMaxContentLength) ? 5000 : auditMaxContentLength,
    rotation: {
      maxFiles: Number.isNaN(auditMaxFiles) ? 30 : auditMaxFiles,
      maxSize: auditMaxSize,
    },
    deduplication: {
      enabled: auditDeduplicationEnabled,
      dictionaryPath: auditDeduplicationDictPath,
      minSize: Number.isNaN(auditDeduplicationMinSize) ? 500 : auditDeduplicationMinSize,
      cacheSize: Number.isNaN(auditDeduplicationCacheSize) ? 100 : auditDeduplicationCacheSize,
    },
  },
};

module.exports = config;
