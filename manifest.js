/* /api/manifest: builds the app manifest from the website name saved in Admin > Website settings,
   so the installed app name (home screen) follows the name you set. */
const KEY = "AIzaSyCKBEzgDUfbvPODuCBzMoNaDIVTV6ryb8A";
const URL_STYLE = "https://firestore.googleapis.com/v1/projects/engrgroup23/databases/(default)/documents/sitedata/style?key=" + KEY;

module.exports = async function handler(req, res) {
  let name = "Engrgroup23";
  try {
    const r = await fetch(URL_STYLE);
    if (r.ok) {
      const j = await r.json();
      const n = j && j.fields && j.fields.name && j.fields.name.stringValue;
      if (n && String(n).trim()) name = String(n).trim();
    }
  } catch (e) {}
  const short = name.length > 12 ? name.slice(0, 12) : name;
  const m = {
    id: "/",
    name: name,
    short_name: short,
    description: name + " - PPSC Sub Engineer Civil past papers and MCQs",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0B1530",
    theme_color: "#0B1530",
    lang: "en",
    prefer_related_applications: false,
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
    ]
  };
  res.setHeader("Content-Type", "application/manifest+json; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=120, stale-while-revalidate=600");
  res.status(200).send(JSON.stringify(m));
};
