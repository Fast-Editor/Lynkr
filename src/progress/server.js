/**
 * Progress WebSocket Server
 *
 * Provides real-time progress updates to connected clients via WebSocket.
 * This allows external tools (like the Python progress-listener) to receive
 * live updates during agent execution.
 */

const EventEmitter = require('events');
const WebSocket = require('ws');
const logger = require('../logger');
const config = require('../config');

class ProgressWebSocketServer extends EventEmitter {
  constructor(port = 8765) {
    super();
    this.port = port;
    this.wss = null;
    this.clients = new Set();
    this.clientIdCounter = 0;
  }

  /**
   * Start the WebSocket server
   */
  start() {
    if (this.wss) {
      logger.warn('Progress WebSocket server already running');
      return;
    }

    this.wss = new WebSocket.Server({
      port: this.port,
      perMessageDeflate: false // Disable compression for faster message delivery
    });

    this.wss.on('listening', () => {
      logger.info(
        { port: this.port },
        'Progress WebSocket server started - clients can connect to receive real-time updates'
      );
      this.emit('server:started', { port: this.port });
    });

    this.wss.on('connection', (ws, req) => {
      const clientId = ++this.clientIdCounter;
      const clientIp = req.socket.remoteAddress;

      this.clients.add(ws);

      logger.info(
        { clientId, clientIp, totalClients: this.clients.size },
        'Progress client connected'
      );

      // Send welcome message
      this.sendToClient(ws, {
        type: 'connected',
        clientId,
        serverInfo: {
          version: '1.0.0',
          features: ['agent-loop', 'model-invocation', 'tool-execution', 'progress']
        }
      });

      // Send initial status
      this.sendToClient(ws, {
        type: 'ready',
        message: 'Progress reporting ready - waiting for agent execution...'
      });

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleClientMessage(ws, clientId, message);
        } catch (err) {
          logger.debug({ clientId, error: err.message }, 'Invalid message from client');
        }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        logger.info(
          { clientId, remainingClients: this.clients.size },
          'Progress client disconnected'
        );
        this.emit('client:disconnected', { clientId });
      });

      ws.on('error', (err) => {
        logger.error({ clientId, error: err.message }, 'Progress client error');
        this.clients.delete(ws);
      });

      this.emit('client:connected', { clientId, clientIp });
    });

    this.wss.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        logger.warn(
          { port: this.port },
          'Progress WebSocket server port already in use - progress reporting unavailable'
        );
      } else {
        logger.error({ error: err.message }, 'Progress WebSocket server error');
      }
    });
  }

  /**
   * Stop the WebSocket server
   */
  stop() {
    if (!this.wss) {
      return;
    }

    // Notify all clients of shutdown
    this.broadcast({
      type: 'server:shutdown',
      message: 'Progress server shutting down'
    });

    // Close all client connections
    this.clients.forEach(ws => {
      try {
        ws.close(1000, 'Server shutting down');
      } catch (err) {
        // Ignore close errors
      }
    });

    this.clients.clear();

    // Close the server
    this.wss.close(err => {
      if (err) {
        logger.error({ error: err.message }, 'Error closing Progress WebSocket server');
      } else {
        logger.info('Progress WebSocket server stopped');
      }
    });

    this.wss = null;
  }

  /**
   * Handle messages from clients
   */
  handleClientMessage(ws, clientId, message) {
    switch (message.type) {
      case 'ping':
        this.sendToClient(ws, { type: 'pong' });
        break;

      case 'subscribe':
        // Client wants specific event types
        ws.subscriptions = message.events || [];
        this.sendToClient(ws, {
          type: 'subscribed',
          events: ws.subscriptions
        });
        break;

      case 'get_status':
        this.sendToClient(ws, {
          type: 'status',
          connectedClients: this.clients.size,
          uptime: process.uptime()
        });
        break;

      default:
        logger.debug({ clientId, messageType: message.type }, 'Unknown message type from client');
    }
  }

  /**
   * Send a message to a specific client
   */
  sendToClient(ws, data) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(data));
      } catch (err) {
        logger.debug({ error: err.message }, 'Failed to send message to client');
      }
    }
  }

  /**
   * Broadcast a message to all connected clients
   */
  broadcast(data) {
    if (this.clients.size === 0) {
      return;
    }

    const message = JSON.stringify(data);
    const deadClients = new Set();

    this.clients.forEach(ws => {
      if (ws.readyState !== WebSocket.OPEN) {
        deadClients.add(ws);
        return;
      }

      // Check if client has subscriptions
      if (ws.subscriptions && !ws.subscriptions.includes(data.type)) {
        return;
      }

      try {
        ws.send(message);
      } catch (err) {
        deadClients.add(ws);
      }
    });

    // Remove dead clients
    deadClients.forEach(ws => {
      this.clients.delete(ws);
    });

    if (deadClients.size > 0) {
      logger.debug(
        { removedCount: deadClients.size, remaining: this.clients.size },
        'Cleaned up disconnected clients'
      );
    }
  }

  /**
   * Check if server is running
   */
  isRunning() {
    return this.wss !== null;
  }

  /**
   * Get connection count
   */
  getClientCount() {
    return this.clients.size;
  }
}

// Singleton instance
let serverInstance = null;

/**
 * Get or create the progress WebSocket server singleton
 */
function getProgressServer(port = 8765) {
  if (!serverInstance) {
    serverInstance = new ProgressWebSocketServer(port);
  }
  return serverInstance;
}

/**
 * Initialize and start the progress server if enabled
 */
function initializeProgressServer() {
  const progressConfig = config.progress || {};
  const enabled = progressConfig.enabled !== false;
  const port = progressConfig.port || 8765;

  if (!enabled) {
    logger.info('Progress WebSocket server disabled via config');
    return null;
  }

  const server = getProgressServer(port);
  server.start();

  return server;
}

/**
 * Shutdown the progress server
 */
function shutdownProgressServer() {
  if (serverInstance) {
    serverInstance.stop();
    serverInstance = null;
  }
}

module.exports = {
  ProgressWebSocketServer,
  getProgressServer,
  initializeProgressServer,
  shutdownProgressServer
};