/**
 * Cluster Mode — Multi-Core Scaling
 *
 * Forks one worker per CPU core. Each worker runs a full Lynkr
 * instance with its own Express server, event loop, and connection pool.
 *
 * Enable: CLUSTER_ENABLED=true (default: false for dev, recommended for prod)
 * Workers: CLUSTER_WORKERS=auto (default) or a number
 *
 * Architecture:
 *   Primary process → forks N workers → each worker calls start()
 *   Primary handles: signal forwarding, worker respawning, health monitoring
 *   Workers handle: HTTP requests, LLM proxying, tool execution
 *
 * Shared state considerations:
 *   - SQLite: WAL mode supports concurrent readers across processes
 *   - In-memory caches (prompt, circuit breaker): per-worker (not shared)
 *   - Rate limiting: per-worker (sessions are sticky via round-robin)
 *
 * @module cluster
 */

const cluster = require('node:cluster');
const os = require('node:os');

const WORKER_COUNT = (() => {
  const env = process.env.CLUSTER_WORKERS;
  if (!env || env === 'auto') return Math.max(os.cpus().length - 1, 1);
  const n = parseInt(env, 10);
  return Number.isNaN(n) || n < 1 ? Math.max(os.cpus().length - 1, 1) : n;
})();

function startCluster() {
  if (cluster.isPrimary) {
    console.log(`[cluster] Primary ${process.pid} starting ${WORKER_COUNT} workers`);

    // Fork workers
    for (let i = 0; i < WORKER_COUNT; i++) {
      cluster.fork();
    }

    // Respawn crashed workers
    cluster.on('exit', (worker, code, signal) => {
      if (signal) {
        console.log(`[cluster] Worker ${worker.process.pid} killed by signal ${signal}`);
      } else if (code !== 0) {
        console.log(`[cluster] Worker ${worker.process.pid} exited with code ${code}, respawning...`);
        cluster.fork();
      } else {
        console.log(`[cluster] Worker ${worker.process.pid} exited cleanly`);
      }
    });

    // Forward SIGTERM/SIGINT to all workers for graceful shutdown
    const shutdown = (sig) => {
      console.log(`[cluster] Primary received ${sig}, shutting down workers...`);
      for (const id in cluster.workers) {
        cluster.workers[id].process.kill(sig);
      }
      // Give workers 10s to drain, then force exit
      setTimeout(() => {
        console.log('[cluster] Force exit after 10s drain timeout');
        process.exit(0);
      }, 10000).unref();
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Log worker status
    cluster.on('online', (worker) => {
      console.log(`[cluster] Worker ${worker.process.pid} online`);
    });

  } else {
    // Worker process — start the normal Lynkr server
    const { start } = require('./server');
    start();
  }
}

module.exports = { startCluster, WORKER_COUNT };
