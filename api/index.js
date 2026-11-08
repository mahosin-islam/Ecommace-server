// Vercel Serverless Function entrypoint
const app = require('../dist/app.js');

module.exports = app.default || app;
