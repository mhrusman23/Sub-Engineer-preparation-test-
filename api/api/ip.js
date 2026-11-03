// Returns the visitor's IP as seen by the server (cannot be faked from the page).
module.exports = (req, res) => {
  const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = String(req.headers["x-real-ip"] || xf || (req.socket && req.socket.remoteAddress) || "").trim();
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ ip });
};
