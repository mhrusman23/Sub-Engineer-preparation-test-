// Vercel serverless function: /api/ip  (upload as  api/ip.js)  - returns the visitor's IP for the one-guest-per-network check
module.exports = function handler(req, res) {
  const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = xf || String(req.headers["x-real-ip"] || "") || (req.socket && req.socket.remoteAddress) || "";
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ ip }));
};
