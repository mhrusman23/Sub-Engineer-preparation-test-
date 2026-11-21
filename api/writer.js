/* Vercel function: /api/writer  (called every minute by cron-job.org). Protected by WRITER_SECRET. */
const admin = require("firebase-admin");
const core = require("./_writer-core.js");

function db() {
  if (!admin.apps.length) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
    if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, "\n");
    admin.initializeApp({ credential: admin.credential.cert(sa) });
  }
  return admin.firestore();
}

module.exports = async (req, res) => {
  const secret = process.env.WRITER_SECRET || "";
  const got = (req.headers.authorization || "").replace(/^Bearer\s+/i, "") || String(req.query.key || "");
  if (!secret || got !== secret) return res.status(401).json({ error: "unauthorized" });
  try {
    core.init(db(), admin.firestore.FieldValue);
    const out = await core.runOnce();
    return res.status(200).json(out || { ok: true });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e).slice(0, 200) });
  }
};
module.exports.config = { maxDuration: 60 };
