// Server-side AI proxy. The Gemini key lives ONLY in the Vercel env var GEMINI_API_KEY.
// Only signed-in users who are approved (allowed list, active guest trial, manager or owner) can use it.
const PROJECT = "engrgroup23";
const WEB_KEY = "AIzaSyCKBEzgDUfbvPODuCBzMoNaDIVTV6ryb8A"; // public Firebase web key (same as in index.html)
const OWNERS = ["maherusman1947@gmail.com"];
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const hits = new Map(); // simple per-user rate limit (best effort)

function fail(res, code, msg) {
  res.status(code).json({ error: { status: String(code), message: msg } });
}
async function fsGet(path, token) {
  const r = await fetch(`${FS}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 404) return null;
  if (!r.ok) return undefined;
  return r.json();
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return fail(res, 405, "POST only");
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return fail(res, 401, "Please sign in.");
  const KEY = process.env.GEMINI_API_KEY;
  if (!KEY) return fail(res, 500, "AI is not set up on the server (GEMINI_API_KEY missing).");

  try {
    // 1) who is this? (verifies the Firebase login token)
    const lk = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${WEB_KEY}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token })
    });
    if (!lk.ok) return fail(res, 401, "Login expired. Please sign in again.");
    const u = ((await lk.json()).users || [])[0];
    if (!u) return fail(res, 401, "Login expired. Please sign in again.");
    const id = u.email && u.emailVerified ? String(u.email).toLowerCase()
      : u.phoneNumber ? u.phoneNumber
      : (!u.email ? "guest_" + u.localId : "");
    if (!id) return fail(res, 403, "Verify your email first.");

    // 2) rate limit
    const now = Date.now(), arr = (hits.get(id) || []).filter(t => now - t < 60000);
    if (arr.length >= 15) return fail(res, 429, "Too many AI requests. Wait a minute.");
    arr.push(now); hits.set(id, arr);

    // 3) approved? (reads under the user's own login, so Firestore rules apply)
    let ok = OWNERS.includes(id);
    if (!ok && (await fsGet("managers/" + encodeURIComponent(id), token))) ok = true;
    if (!ok) {
      const a = await fsGet("allowed/" + encodeURIComponent(id), token);
      const f = a && a.fields;
      if (!f || !f.enabled || f.enabled.booleanValue !== true) return fail(res, 403, "No access.");
      if (f.expires && f.expires.timestampValue && Date.parse(f.expires.timestampValue) < now) return fail(res, 403, "Access expired.");
      const c = await fsGet("meta/config", token);
      const cf = c && c.fields;
      if (cf && cf.ai && cf.ai.booleanValue === false) return fail(res, 403, "AI is switched off by the admin.");
    }

    // 4) forward only the safe fields to Gemini
    const b = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const contents = Array.isArray(b.contents) ? b.contents.slice(-30) : [];
    if (!contents.length || JSON.stringify(contents).length > 40000) return fail(res, 400, "Bad request.");
    const payload = { contents };
    if (b.systemInstruction) payload.systemInstruction = b.systemInstruction;
    const gc = b.generationConfig || {};
    payload.generationConfig = { temperature: 0.4, maxOutputTokens: Math.min(+gc.maxOutputTokens || 1024, 2048) };
    if (gc.thinkingConfig) payload.generationConfig.thinkingConfig = { thinkingBudget: 0 };

    const model = process.env.AI_MODEL || "gemini-2.5-flash";
    const g = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": KEY }, body: JSON.stringify(payload)
    });
    res.status(g.status);
    res.setHeader("Content-Type", g.headers.get("content-type") || "text/event-stream");
    res.setHeader("Cache-Control", "no-store");
    for await (const chunk of g.body) res.write(chunk);
    res.end();
  } catch (e) {
    if (!res.headersSent) fail(res, 500, "AI server error.");
    else res.end();
  }
};
