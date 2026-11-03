// Vercel AI proxy for index.html  ->  POST /api/ai
// Vercel > Settings > Environment Variables:  GEMINI_API_KEY = (aapki Gemini key)
// v3 - Model khud dhoondti hai: agar purana model band ho jaye to naya "flash" model khud chun leti hai.
export const config = { runtime: "edge" };

const FIREBASE_WEB_KEY = "AIzaSyCKBEzgDUfbvPODuCBzMoNaDIVTV6ryb8A"; // public web key (index.html wali)
const BASE = "https://generativelanguage.googleapis.com/v1beta/";
let goodModel = null; // yaad rakhta hai kaunsa model chala

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const err = (status, message) =>
  new Response(JSON.stringify({ error: { code: status, message } }), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

async function listFlashModels(key) {
  try {
    const r = await fetch(BASE + "models?pageSize=200", { headers: { "x-goog-api-key": key } });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map(m => m.name.replace(/^models\//, ""))
      .filter(n => /flash/i.test(n) && !/(image|tts|audio|live|embed|thinking|exp)/i.test(n))
      .sort((a, b) => {
        const v = s => parseFloat((s.match(/gemini-(\d+(\.\d+)?)/) || [0, 0])[1]);
        const lite = s => (/lite/i.test(s) ? 1 : 0);
        const pre = s => (/preview/i.test(s) ? 1 : 0);
        return v(b) - v(a) || lite(a) - lite(b) || pre(a) - pre(b);
      });
  } catch { return []; }
}

const call = (model, key, body) =>
  fetch(BASE + "models/" + model + ":streamGenerateContent?alt=sse", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(body),
  });

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return err(405, "Method not allowed");

  const key = process.env.GEMINI_API_KEY;
  if (!key) return err(500, "Server: GEMINI_API_KEY is not set in Vercel.");

  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return err(401, "Please log in.");
  const check = await fetch(
    "https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + FIREBASE_WEB_KEY,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) }
  );
  if (!check.ok) return err(401, "Login expired. Please log in again.");

  let body;
  try { body = await req.json(); } catch { return err(400, "Bad request"); }
  if (!body || !Array.isArray(body.contents) || body.contents.length > 60) return err(400, "Bad request");

  const first = goodModel || process.env.GEMINI_MODEL || "gemini-2.5-flash";
  let up = await call(first, key, body);
  if (up.ok) { goodModel = first; }
  else if (up.status === 404 || up.status === 400) {
    // model band ho gaya -> naya model khud dhoondo (Google ke error mein bataya hua model pehle)
    let hint = [];
    try { const t = await up.clone().text(); hint = [...t.matchAll(/models\/(gemini-[a-z0-9.\-]+)/gi)].map(x => x[1]).filter(m => m !== first); } catch {}
    const tryList = [...new Set([...hint.reverse(), "gemini-flash-latest", ...(await listFlashModels(key))])].filter(m => m !== first);
    for (const m of tryList.slice(0, 6)) {
      const r = await call(m, key, body);
      if (r.ok) { goodModel = m; up = r; break; }
      if (r.status !== 404 && r.status !== 400) { up = r; break; }
    }
  }
  return new Response(up.body, {
    status: up.status,
    headers: { ...cors, "Content-Type": up.headers.get("content-type") || "text/event-stream", "Cache-Control": "no-store" },
  });
        }
