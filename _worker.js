// Cloudflare Pages: is file ko repo mein index.html ke SATH (bahar hi) rakhein. Koi folder nahi chahiye.
// Cloudflare > Pages project > Settings > Variables and Secrets:  GEMINI_API_KEY = (aapki key)
// Website ke baqi pages waise hi chalte rahenge; yeh sirf /api/ai sambhalti hai.

const FIREBASE_WEB_KEY = "AIzaSyCKBEzgDUfbvPODuCBzMoNaDIVTV6ryb8A"; // public web key (index.html wali)

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

async function ai(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return err(405, "Method not allowed");

  const key = env.GEMINI_API_KEY;
  if (!key) return err(500, "Server: GEMINI_API_KEY is not set in Cloudflare.");

  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return err(401, "Please log in.");
  const check = await fetch(
    "https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + FIREBASE_WEB_KEY,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) }
  );
  if (!check.ok) return err(401, "Login expired. Please log in again.");

  let body;
  try { body = await request.json(); } catch { return err(400, "Bad request"); }
  if (!body || !Array.isArray(body.contents) || body.contents.length > 60) return err(400, "Bad request");

  const model = env.GEMINI_MODEL || "gemini-2.5-flash";
  const up = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":streamGenerateContent?alt=sse",
    { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body) }
  );
  return new Response(up.body, {
    status: up.status,
    headers: { ...cors, "Content-Type": up.headers.get("content-type") || "text/event-stream", "Cache-Control": "no-store" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/ai") return ai(request, env);
    // baqi sab (index.html, open.html waghera) bilkul waise hi
    const res = await env.ASSETS.fetch(request);
    if (url.pathname === "/" || url.pathname.endsWith(".html")) {
      const r = new Response(res.body, res);
      r.headers.set("Cache-Control", "no-cache"); // update foran nazar aaye
      return r;
    }
    return res;
  },
};
