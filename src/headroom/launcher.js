/**
 * Headroom Sidecar Container Launcher
 *
 * Uses dockerode to programmatically manage the Headroom sidecar container lifecycle.
 * Provides automatic container creation, health checking, and graceful shutdown.
 */

let Docker;
try {
  Docker = require("dockerode");
} catch {
  Docker = null;
}
const logger = require("../logger");
const config = require("../config");

// Initialize Docker client (only if dockerode is available)
const docker = Docker ? new Docker() : null;

// Launcher state
let containerInstance = null;
let isStarting = false;
let isShuttingDown = false;

/**
 * Get container environment variables for Headroom sidecar
 */
function getContainerEnv() {
  const headroomConfig = config.headroom;
  return [
    `HEADROOM_HOST=0.0.0.0`,
    `HEADROOM_PORT=${headroomConfig.docker.port}`,
    `HEADROOM_LOG_LEVEL=${headroomConfig.logLevel}`,
    `HEADROOM_MODE=${headroomConfig.mode}`,
    `HEADROOM_PROVIDER=${headroomConfig.provider}`,
    // Transforms
    `HEADROOM_SMART_CRUSHER=${headroomConfig.transforms.smartCrusher}`,
    `HEADROOM_SMART_CRUSHER_MIN_TOKENS=${headroomConfig.transforms.smartCrusherMinTokens}`,
    `HEADROOM_SMART_CRUSHER_MAX_ITEMS=${headroomConfig.transforms.smartCrusherMaxItems}`,
    `HEADROOM_TOOL_CRUSHER=${headroomConfig.transforms.toolCrusher}`,
    `HEADROOM_CACHE_ALIGNER=${headroomConfig.transforms.cacheAligner}`,
    `HEADROOM_ROLLING_WINDOW=${headroomConfig.transforms.rollingWindow}`,
    `HEADROOM_KEEP_TURNS=${headroomConfig.transforms.keepTurns}`,
    // CCR
    `HEADROOM_CCR=${headroomConfig.ccr.enabled}`,
    `HEADROOM_CCR_TTL=${headroomConfig.ccr.ttlSeconds}`,
    // LLMLingua
    `HEADROOM_LLMLINGUA=${headroomConfig.llmlingua.enabled}`,
    `HEADROOM_LLMLINGUA_DEVICE=${headroomConfig.llmlingua.device}`,
  ];
}

/**
 * Parse memory limit string to bytes for Docker API
 * Supports formats like "512m", "1g", "256mb", "1gb"
 */
function parseMemoryLimit(limit) {
  if (typeof limit !== "string") return 536870912; // Default 512MB

  const match = limit.toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(b|k|kb|m|mb|g|gb)?$/);
  if (!match) return 536870912;

  const value = parseFloat(match[1]);
  const unit = match[2] || "b";

  const multipliers = {
    b: 1,
    k: 1024,
    kb: 1024,
    m: 1024 * 1024,
    mb: 1024 * 1024,
    g: 1024 * 1024 * 1024,
    gb: 1024 * 1024 * 1024,
  };

  return Math.floor(value * (multipliers[unit] || 1));
}

/**
 * Parse CPU limit to NanoCPUs for Docker API
 * Supports formats like "1.0", "0.5", "2"
 */
function parseCpuLimit(limit) {
  if (typeof limit !== "string") return 1e9; // Default 1 CPU

  const value = parseFloat(limit);
  if (Number.isNaN(value)) return 1e9;

  return Math.floor(value * 1e9); // Convert to NanoCPUs
}

/**
 * Check if the container already exists
 */
async function getExistingContainer() {
  const containerName = config.headroom.docker.containerName;

  try {
    const containers = await docker.listContainers({
      all: true,
      filters: { name: [containerName] },
    });

    // Find exact match (Docker returns partial matches)
    const match = containers.find(
      (c) => c.Names.includes(`/${containerName}`) || c.Names.includes(containerName)
    );

    if (match) {
      return docker.getContainer(match.Id);
    }
    return null;
  } catch (err) {
    logger.error({ err }, "Failed to check for existing container");
    return null;
  }
}

/**
 * Check if the Docker image exists locally
 */
async function imageExists(imageName) {
  try {
    const image = docker.getImage(imageName);
    await image.inspect();
    return true;
  } catch (err) {
    if (err.statusCode === 404) {
      return false;
    }
    throw err;
  }
}

/**
 * Pull the Docker image
 */
async function pullImage(imageName) {
  logger.info({ image: imageName }, "Pulling Headroom sidecar image");

  return new Promise((resolve, reject) => {
    docker.pull(imageName, (err, stream) => {
      if (err) {
        return reject(err);
      }

      docker.modem.followProgress(
        stream,
        (err, output) => {
          if (err) {
            reject(err);
          } else {
            logger.info({ image: imageName }, "Image pull complete");
            resolve(output);
          }
        },
        (event) => {
          if (event.status === "Downloading" || event.status === "Extracting") {
            logger.debug({ status: event.status, progress: event.progress }, "Image pull progress");
          }
        }
      );
    });
  });
}

/**
 * Build the Docker image from local context
 */
async function buildImage(imageName, buildContext) {
  logger.info({ image: imageName, context: buildContext }, "Building Headroom sidecar image");

  const path = require("path");
  const fs = require("fs");
  const { execSync } = require("child_process");

  // Resolve build context path
  const contextPath = path.resolve(process.cwd(), buildContext);

  if (!fs.existsSync(contextPath)) {
    throw new Error(`Build context not found: ${contextPath}`);
  }

  if (!fs.existsSync(path.join(contextPath, "Dockerfile"))) {
    throw new Error(`Dockerfile not found in: ${contextPath}`);
  }

  // Use docker build command for simplicity (dockerode build is complex with tar)
  try {
    execSync(`docker build -t ${imageName} ${contextPath}`, {
      stdio: "inherit",
      encoding: "utf8",
    });
    logger.info({ image: imageName }, "Image build complete");
  } catch (err) {
    throw new Error(`Failed to build image: ${err.message}`);
  }
}

/**
 * Create and start the Headroom container
 */
async function createContainer() {
  const headroomConfig = config.headroom;
  const dockerConfig = headroomConfig.docker;

  const containerConfig = {
    Image: dockerConfig.image,
    name: dockerConfig.containerName,
    Env: getContainerEnv(),
    ExposedPorts: {
      [`${dockerConfig.port}/tcp`]: {},
    },
    HostConfig: {
      PortBindings: {
        [`${dockerConfig.port}/tcp`]: [{ HostPort: String(dockerConfig.port) }],
      },
      Memory: parseMemoryLimit(dockerConfig.memoryLimit),
      NanoCpus: parseCpuLimit(dockerConfig.cpuLimit),
      RestartPolicy: {
        Name: dockerConfig.restartPolicy,
      },
    },
    Healthcheck: {
      Test: ["CMD", "curl", "-f", `http://localhost:${dockerConfig.port}/health`],
      Interval: 30 * 1e9, // 30s in nanoseconds
      Timeout: 10 * 1e9, // 10s
      StartPeriod: 30 * 1e9, // 30s
      Retries: 3,
    },
  };

  // Add network if specified
  if (dockerConfig.network) {
    containerConfig.HostConfig.NetworkMode = dockerConfig.network;
  }

  logger.info(
    {
      name: dockerConfig.containerName,
      image: dockerConfig.image,
      port: dockerConfig.port,
      memory: dockerConfig.memoryLimit,
    },
    "Creating Headroom container"
  );

  const container = await docker.createContainer(containerConfig);
  await container.start();

  logger.info({ name: dockerConfig.containerName }, "Headroom container started");

  return container;
}

/**
 * Wait for the container to be healthy
 */
async function waitForHealthy(container, maxRetries = 30, intervalMs = 1000) {
  const headroomConfig = config.headroom;

  for (let i = 0; i < maxRetries; i++) {
    try {
      // Check container state
      const info = await container.inspect();

      if (info.State.Health?.Status === "healthy") {
        logger.info("Headroom container is healthy");
        return true;
      }

      if (info.State.Status === "exited" || info.State.Status === "dead") {
        throw new Error(`Container exited unexpectedly: ${info.State.Status}`);
      }

      // Also try direct HTTP health check
      try {
        const response = await fetch(`${headroomConfig.endpoint}/health`, {
          signal: AbortSignal.timeout(2000),
        });

        if (response.ok) {
          const data = await response.json();
          if (data.headroom_loaded) {
            logger.info("Headroom sidecar is ready (HTTP health check passed)");
            return true;
          }
        }
      } catch {
        // HTTP check failed, continue waiting
      }

      logger.debug({ attempt: i + 1, maxRetries }, "Waiting for Headroom container to be healthy");
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    } catch (err) {
      if (err.message?.includes("exited unexpectedly")) {
        throw err;
      }
      logger.debug({ err: err.message }, "Health check attempt failed");
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  throw new Error(`Headroom container failed to become healthy after ${maxRetries} attempts`);
}

/**
 * Ensure the Headroom container is running
 * Creates it if it doesn't exist, starts it if stopped
 */
async function ensureRunning() {
  const headroomConfig = config.headroom;

  if (!headroomConfig.enabled) {
    logger.debug("Headroom is disabled, skipping container launch");
    return { started: false, reason: "disabled" };
  }

  if (!headroomConfig.docker.enabled) {
    logger.debug("Headroom Docker management is disabled");
    return { started: false, reason: "docker_disabled" };
  }

  if (isStarting) {
    logger.debug("Headroom container is already starting");
    return { started: false, reason: "already_starting" };
  }

  if (isShuttingDown) {
    logger.debug("Headroom is shutting down, skipping start");
    return { started: false, reason: "shutting_down" };
  }

  isStarting = true;

  try {
    // Check for existing container
    let container = await getExistingContainer();

    if (container) {
      const info = await container.inspect();
      const state = info.State;

      logger.info(
        { name: headroomConfig.docker.containerName, state: state.Status },
        "Found existing Headroom container"
      );

      if (state.Running) {
        // Container is already running
        containerInstance = container;
        await waitForHealthy(container);
        return { started: true, action: "existing_running" };
      }

      // Container exists but is stopped, start it
      logger.info("Starting existing Headroom container");
      await container.start();
      containerInstance = container;
      await waitForHealthy(container);
      return { started: true, action: "started_existing" };
    }

    // No container exists, need to create one
    // First ensure the image exists
    const exists = await imageExists(headroomConfig.docker.image);

    if (!exists) {
      if (headroomConfig.docker.autoBuild) {
        await buildImage(headroomConfig.docker.image, headroomConfig.docker.buildContext);
      } else {
        await pullImage(headroomConfig.docker.image);
      }
    }

    // Create and start the container
    container = await createContainer();
    containerInstance = container;
    await waitForHealthy(container);

    return { started: true, action: "created_new" };
  } catch (err) {
    logger.error({ err }, "Failed to ensure Headroom container is running");
    throw err;
  } finally {
    isStarting = false;
  }
}

/**
 * Stop and optionally remove the Headroom container
 */
async function stop(removeContainer = false) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  try {
    const container = containerInstance || (await getExistingContainer());

    if (!container) {
      logger.debug("No Headroom container to stop");
      return;
    }

    const info = await container.inspect();

    if (info.State.Running) {
      logger.info({ name: config.headroom.docker.containerName }, "Stopping Headroom container");
      await container.stop({ t: 10 }); // 10 second timeout
      logger.info("Headroom container stopped");
    }

    if (removeContainer) {
      logger.info({ name: config.headroom.docker.containerName }, "Removing Headroom container");
      await container.remove();
      logger.info("Headroom container removed");
    }

    containerInstance = null;
  } catch (err) {
    if (err.statusCode === 304) {
      // Container already stopped
      logger.debug("Headroom container was already stopped");
    } else if (err.statusCode === 404) {
      // Container doesn't exist
      logger.debug("Headroom container does not exist");
    } else {
      logger.error({ err }, "Failed to stop Headroom container");
    }
  } finally {
    isShuttingDown = false;
  }
}

/**
 * Get container status
 */
async function getStatus() {
  try {
    const container = containerInstance || (await getExistingContainer());

    if (!container) {
      return { exists: false, running: false };
    }

    const info = await container.inspect();

    return {
      exists: true,
      running: info.State.Running,
      status: info.State.Status,
      health: info.State.Health?.Status || "unknown",
      startedAt: info.State.StartedAt,
      id: info.Id.substring(0, 12),
      name: info.Name,
      image: info.Config.Image,
    };
  } catch (err) {
    logger.error({ err }, "Failed to get Headroom container status");
    return { exists: false, running: false, error: err.message };
  }
}

/**
 * Get container logs
 */
async function getLogs(tail = 100) {
  try {
    const container = containerInstance || (await getExistingContainer());

    if (!container) {
      return null;
    }

    const logs = await container.logs({
      stdout: true,
      stderr: true,
      tail,
      timestamps: true,
    });

    return logs.toString("utf8");
  } catch (err) {
    logger.error({ err }, "Failed to get Headroom container logs");
    return null;
  }
}

/**
 * Restart the container
 */
async function restart() {
  try {
    const container = containerInstance || (await getExistingContainer());

    if (!container) {
      // No container exists, create one
      return ensureRunning();
    }

    logger.info({ name: config.headroom.docker.containerName }, "Restarting Headroom container");
    await container.restart({ t: 10 });
    await waitForHealthy(container);

    return { restarted: true };
  } catch (err) {
    logger.error({ err }, "Failed to restart Headroom container");
    throw err;
  }
}

module.exports = {
  ensureRunning,
  stop,
  getStatus,
  getLogs,
  restart,
  waitForHealthy,
};
