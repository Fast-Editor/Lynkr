if (process.env.CLUSTER_ENABLED === 'true') {
  const { startCluster } = require('./src/cluster');
  startCluster();
} else {
  const { start } = require('./src/server');
  start();
}
