// Vercel AI proxy for index.html  ->  POST /api/ai
// Vercel > Settings > Environment Variables:  GEMINI_API_KEY = (aapki Gemini key)
// Key sirf server par rehti hai, users ko kabhi nazar nahi aati.
export const config = { runtime: "edge" };

const FIREBASE_WEB_KEY = "AIzaSyCKBEzgDUfbvPODuCBzMoNaDIVTV6ryb8A"; // public web key (index.html wali)
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

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

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return err(405, "Method not allowed");

  const key = process.env.GEMINI_API_KEY;
  if (!key) return err(500, "Server: GEMINI_API_KEY is not set in Vercel.");

  // Only logged-in Firebase users
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

  const up = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/" + MODEL + ":streamGenerateContent?alt=sse",
    { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body) }
  );
  return new Response(up.body, {
    status: up.status,
    headers: { ...cors, "Content-Type": up.headers.get("content-type") || "text/event-stream", "Cache-Control": "no-store" },
  });
  }
