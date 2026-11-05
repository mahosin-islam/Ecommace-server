// backend/api/index.js
const mod = require('../dist/app.js');
module.exports = mod.default || mod;