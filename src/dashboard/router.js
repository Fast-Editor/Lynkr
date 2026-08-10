const express = require('express');
const path    = require('path');
const fs      = require('fs');
const api     = require('./api');

const router = express.Router();

const DASHBOARD_HTML = path.resolve(__dirname, '../../public/dashboard.html');

router.get(['/', ''], (_req, res) => {
  if (!fs.existsSync(DASHBOARD_HTML)) {
    return res.status(500).json({ error: 'dashboard_unavailable', path: DASHBOARD_HTML });
  }
  res.sendFile(DASHBOARD_HTML);
});

router.get('/api/overview', api.overview);
router.get('/api/usage',    api.usage);
router.get('/api/routing',  api.routing);
router.get('/api/logs',     api.logs);
// Lens (feature/lens-dashboard)
router.get('/api/recommendations', api.recommendations);
router.get('/api/sessions/:id',    api.sessionDetail);
router.get('/api/analytics',       api.analytics);
router.get('/api/statusline',      api.statusline);

module.exports = router;
