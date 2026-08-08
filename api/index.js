// Vercel serverless entrypoint — the Express app already owns all routing
// (API, /embed/*, static public/, page routes; see backend/server.js), so
// this just hands every request Vercel forwards here to that same app.
module.exports = require('../backend/server').app;
