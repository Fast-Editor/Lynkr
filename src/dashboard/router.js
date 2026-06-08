const express = require('express');
const path    = require('path');
const api     = require('./api');

const router = express.Router();

router.get(['/', ''],      (_req, res) => res.sendFile(path.join(__dirname, '../../public/dashboard.html')));
router.get('/api/overview', api.overview);
router.get('/api/usage',    api.usage);
router.get('/api/routing',  api.routing);
router.get('/api/logs',     api.logs);

module.exports = router;
