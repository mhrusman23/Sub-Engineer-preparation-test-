/*
 * AI Writer core (free hosting version). Same logic as the Firebase function, but it runs from any scheduler:
 * Vercel API + cron-job.org, or GitHub Actions. Call init(db, FieldValue) once, then runOnce() each minute.
 */
let db, FV;
function init(_db, _FV) { db = _db; FV = _FV; }
const F = (u, o) => fetch(u, Object.assign({ signal: AbortSignal.timeout(26000) }, o));
const PER_RUN = 6;          // MCQs written per minute
const SEARCH_SHARE = Math.min(1, Math.max(0, Number(process.env.SEARCH_SHARE) || 0.8));   // 0.8 = 80% of runs use web search, 20% are AI only (change with the SEARCH_SHARE variable)
const DAY_CAP = 500;        // stops by itself after this many saved MCQs a day
const PUBLISH_EVERY_MS = 30 * 60 * 1000;
const PUBLISH_QUEUE_MIN = 100;
const CHAPTER = "AI Verified";

/* ---------------- AI ---------------- */
const GEM = "https://generativelanguage.googleapis.com/v1beta/models/";
let LAST_FREE = false;   // true when the free server wrote/checked something in this run
async function callAI(cfg, system, prompt, maxOut) {
  /* main key first; if it fails (limit over, busy, blocked) the extra keys from the admin Settings take over */
  const list = [cfg].concat(cfg.extra || []);
  let lastErr;
  for (const c of list) {
    try { return await callAI1(c, system, prompt, maxOut); } catch (e) { lastErr = e; }
  }
  /* every key failed (limit over, busy, blocked): connect to the free no-key server, if the admin Settings allow it */
  if (cfg.backup) {
    try { const out = await callAI1({ free: true }, system, prompt, maxOut); LAST_FREE = true; return out; }
    catch (e) { lastErr = new Error("All AI keys are at their limit and the free server is busy too. It will try again next minute."); }
  }
  throw lastErr;
}
async function callAI1(cfg, system, prompt, maxOut) {
  if (cfg.free) {
    const r = await F("https://text.pollinations.ai/openai", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai", temperature: 0.4, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }) });
    if (!r.ok) throw new Error("Free AI HTTP " + r.status);
    const j = await r.json();
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
  }
  const key = cfg.key;
  if (!key) throw new Error("No AI key in Firestore meta/ai. Save the key in Admin -> Settings first.");
  const openaiStyle = cfg.provider === "openai" || cfg.baseUrl || /^sk-/.test(key);
  if (openaiStyle) {
    const url = (cfg.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "") + "/chat/completions";
    const r = await F(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify(Object.assign({ model: cfg.model || "gpt-4o-mini", temperature: 0.4, max_tokens: maxOut,
        messages: [{ role: "system", content: system }, { role: "user", content: prompt }] },
        /gpt-oss/i.test(cfg.model || "") ? { reasoning_effort: "low" } : {})),
    });
    if (!r.ok) throw new Error("AI HTTP " + r.status + " " + (await r.text()).slice(0, 160));
    const j = await r.json();
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
  }
  const models = [cfg.model || "gemini-flash-latest"];
  if (!cfg.model) ["gemini-flash-lite-latest", "gemini-flash-latest"].forEach((m) => models.push(m));
  let lastErr = "";
  for (const m of models) {
    for (const think of [true, false]) {
      const gc = { temperature: 0.4, maxOutputTokens: maxOut };
      if (think) gc.thinkingConfig = { thinkingBudget: 0 };
      const r = await F(GEM + encodeURIComponent(m) + ":generateContent", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: gc }),
      });
      if (r.ok) {
        const j = await r.json();
        const c = j.candidates && j.candidates[0];
        return ((c && c.content && c.content.parts) || []).map((p) => (p.thought ? "" : p.text || "")).join("");
      }
      lastErr = "AI " + m + " HTTP " + r.status + " " + (await r.text()).slice(0, 120);
      if (r.status === 400 && think) continue;   // retry without thinkingConfig
      break;                                     // 404/429/503: next model
    }
  }
  throw new Error(lastErr || "AI failed");
}
function parseArr(text) {
  const t = String(text || "").replace(/```json|```/gi, "").trim();
  const a = t.indexOf("["), b = t.lastIndexOf("]");
  if (a < 0 || b < a) throw new Error("AI returned a bad format");
  return JSON.parse(t.slice(a, b + 1));
}
const cut = (x, k) => String(x == null ? "" : x).replace(/\s+/g, " ").trim().slice(0, k);

/* ---- web search: uses whichever search keys exist in the environment (Vercel Environment Variables) ----
   order: TAVILY_API_KEY, EXA_API_KEY, FIRECRAWL_API_KEY, BRAVE_API_KEY, SERPER_API_KEY. If one fails or its quota is over, the next one is used.
   The AI only learns which FACTS are tested; it writes NEW questions with NEW wrong options. */
const clip = (x) => String(x || "").replace(/\s+/g, " ").trim().slice(0, 700);
const SEARCH = [
  { name: "Tavily", env: "TAVILY_API_KEY", async run(q, k) {
      const r = await F("https://api.tavily.com/search", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + k }, body: JSON.stringify({ query: q, search_depth: "basic", max_results: 6 }) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return ((await r.json()).results || []).map((x) => clip(x.content));
  } },
  { name: "Exa", env: "EXA_API_KEY", async run(q, k) {
      const r = await F("https://api.exa.ai/search", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": k }, body: JSON.stringify({ query: q, numResults: 6, contents: { text: { maxCharacters: 700 } } }) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return ((await r.json()).results || []).map((x) => clip(x.text || (x.highlights || []).join(" ")));
  } },
  { name: "Firecrawl", env: "FIRECRAWL_API_KEY", async run(q, k) {
      const r = await F("https://api.firecrawl.dev/v2/search", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + k }, body: JSON.stringify({ query: q, limit: 6 }) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json(), arr = (j.data && (j.data.web || j.data)) || [];
      return (Array.isArray(arr) ? arr : []).map((x) => clip(x.description || x.markdown || x.title));
  } },
  { name: "Brave", env: "BRAVE_API_KEY", async run(q, k) {
      const r = await F("https://api.search.brave.com/res/v1/web/search?count=6&q=" + encodeURIComponent(q), { headers: { Accept: "application/json", "X-Subscription-Token": k } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return (((await r.json()).web || {}).results || []).map((x) => clip([x.description].concat(x.extra_snippets || []).join(" ")));
  } },
  { name: "Serper", env: "SERPER_API_KEY", async run(q, k) {
      const r = await F("https://google.serper.dev/search", { method: "POST", headers: { "Content-Type": "application/json", "X-API-KEY": k }, body: JSON.stringify({ q, num: 6 }) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return ((await r.json()).organic || []).map((x) => clip(x.snippet));
  } },
];
async function searchWeb(query) {
  const errs = [];
  for (const p of SEARCH) {
    const k = String(process.env[p.env] || "").trim();
    if (!k) continue;
    try {
      const items = (await p.run(query, k)).filter(Boolean).map((text) => ({ text }));
      if (items.length) return { items, via: p.name };
      errs.push(p.name + ": no results");
    } catch (e) { errs.push(p.name + ": " + String((e && e.message) || e).slice(0, 40)); }
  }
  if (errs.length) throw new Error(errs.join(" | "));
  return null;   // no search key at all
}
async function getFacts(label) {
  if (!SEARCH.some((p) => String(process.env[p.env] || "").trim())) return null;
  const id = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 100);
  const ref = db.doc("writer_cache/" + id);
  const sn = await ref.get(), d = sn.exists ? sn.data() : null;
  const at = d && d.at && d.at.toMillis ? d.at.toMillis() : 0;
  if (d && Array.isArray(d.items) && d.items.length && Date.now() - at < 4 * 3600 * 1000) return { items: d.items, via: d.via || "" };   // one search per subject per 4 hours (about 2,000-2,500 searches a month)
  const res = await searchWeb(label + " important exam MCQs with answers");
  if (res && res.items.length) await ref.set({ at: FV.serverTimestamp(), items: res.items, via: res.via });
  return res;
}
async function generate(cfg, label, n, have, examples, facts) {
  const system = "You write exam MCQs for Pakistani competitive tests (PPSC, FPSC, NTS, Sub Engineer) in engineering, IT, accounting and finance (ACCA, CA) and general knowledge. Write MCQs only for the subject the user names. Reply with ONLY a valid JSON array, no markdown and no other text.";
  const avoid = have.slice(-20).map((x) => String(x).slice(0, 60)).join(" | ");
  const prompt = "Write exactly " + n + " new multiple-choice questions for the subject: " + label + ".\n" +
    "Focus on important, frequently tested exam topics. Each question must have exactly one clearly correct option; double-check the answer before writing it.\n" +
    (examples && examples.length
      ? "Real exam-style sample questions from this site (use them ONLY as a guide for topic, difficulty and style):\n" +
        examples.map((e, i) => (i + 1) + ". " + e.question + " | " + e.options.map((o, j) => "ABCD".charAt(j) + ") " + o).join("  ") + " | answer: " + "ABCD".charAt(e.correct)).join("\n") +
        "\nWrite NEW questions in the same exam style that test the same kind of concepts, but change the wording, numbers, names and scenario, and write fresh options. Never reuse a sample's text or its options.\n"
      : "Write every question in your own original wording (never copy from books or past papers).\n") +
    (facts && facts.length
      ? "Reference material found on the web (it may contain exam MCQs or notes). Use it ONLY to learn which facts and answers are commonly tested:\n" +
        facts.map((x, i) => "[" + (i + 1) + "] " + x.text).join("\n") +
        "\nFor every question: pick one fact from the material, write the question in YOUR OWN WORDS (never copy a source sentence), keep the correct answer as that fact, and INVENT 3 new plausible wrong options of your own. Never copy any source question or any of its options. Skip anything you are not sure is correct.\n"
      : "") +
    (avoid ? "Do not repeat these: " + avoid + "\n" : "") +
    'Each array item must have exactly these keys: "question" (English), "options" (array of exactly 4 short strings), "correct" (number, 0-based index of the right option), "explanation" (1-2 simple English sentences).';
  const arr = parseArr(await callAI(cfg, system, prompt, 4096));
  const out = [];
  (Array.isArray(arr) ? arr : []).forEach((m) => {
    if (!m || !Array.isArray(m.options) || m.options.length !== 4) return;
    const o = m.options.map((x) => cut(x, 200)), c = Number(m.correct), q = cut(m.question, 500);
    if (!q || o.some((x) => !x) || new Set(o.map((x) => x.toLowerCase())).size < 4 || !Number.isInteger(c) || c < 0 || c > 3) return;
    out.push({ question: q, options: o, correct: c });
  });
  return out.slice(0, n);
}
async function verify(cfg, label, rows, facts) {
  const system = "You are a strict exam reviewer. Reply with ONLY a valid JSON array, no markdown and no other text.";
  const list = rows.map((r, i) => i + ". " + r.question + " | " + r.options.map((o, j) => "ABCD".charAt(j) + ") " + o).join("  ") + " | marked answer: " + "ABCD".charAt(r.correct)).join("\n");
  const ctx = facts && facts.length ? "Reference excerpts that may help you judge (they can be wrong too):\n" + facts.map((x, i) => "[" + (i + 1) + "] " + x.text.slice(0, 300)).join("\n") + "\n\n" : "";
  const prompt = ctx + "Subject: " + label + '. Check each MCQ independently, solving it yourself first. For each return {"i":number,"ok":true or false,"answer":0-based index of the one option you believe is correct}. ok is true ONLY if exactly one option is clearly correct, it is the marked answer, the wording is unambiguous, and the fact is standard textbook knowledge (not a rate, date, limit or rule that changes by year or country).\n\nMCQs:\n' + list;
  const arr = parseArr(await callAI(cfg, system, prompt, 1500));
  return rows.filter((r, i) => {
    const m = (Array.isArray(arr) ? arr : []).find((x) => x && x.i === i);
    return !!m && m.ok === true && Number(m.answer) === r.correct;
  });
}

/* ---------------- bank (same format the website uses: meta/bank + bank/p0..pN) ---------------- */
async function loadBank() {
  const m = await db.doc("meta/bank").get();
  if (!m.exists) return null;
  const md = m.data();
  const docs = await Promise.all(Array.from({ length: md.parts }, (_, i) => db.doc("bank/p" + i).get()));
  if (!docs.every((d) => d.exists && d.data().v === md.version)) return null; // being updated right now
  return { bank: JSON.parse(docs.map((d) => d.data().data).join("")), version: md.version, parts: md.parts };
}
async function publishBank(bank, oldParts) {
  const json = JSON.stringify(bank), CH = 200000, version = Date.now(), pieces = [];
  for (let i = 0; i < json.length;) {
    let e = Math.min(i + CH, json.length);
    if (e < json.length) { const c = json.charCodeAt(e - 1); if (c >= 0xD800 && c <= 0xDBFF) e--; }
    pieces.push(json.slice(i, e)); i = e;
  }
  const b = db.batch();
  pieces.forEach((p, i) => b.set(db.doc("bank/p" + i), { i, v: version, data: p }));
  for (let i = pieces.length; i < oldParts; i++) b.delete(db.doc("bank/p" + i));
  b.set(db.doc("meta/bank"), { version, parts: pieces.length, count: bank.Q0.length, updatedAt: FV.serverTimestamp() });
  await b.commit();
}
function mergeQueue(bank, rows) {
  const seen = new Set(bank.Q0.map((q) => String(q.text).trim().toLowerCase()));
  let n = 0;
  for (const r of rows) {
    const key = String(r.question).trim().toLowerCase();
    if (seen.has(key)) continue;
    let si = bank.SUB.findIndex((y) => y && y.code !== "merged" && y.cat === r.cat && y.name === r.subject);
    if (si < 0) si = bank.SUB.findIndex((y) => y && y.code !== "merged" && y.cat !== "__tmp" && y.name === r.subject);
    if (si < 0) continue;
    let ci = bank.S.findIndex((c) => c && c.sub === si && c.name === CHAPTER);
    if (ci < 0) { bank.S.push({ sub: si, name: CHAPTER, code: CHAPTER }); ci = bank.S.length - 1; }
    bank.Q0.push(Object.assign({ text: r.question, opts: r.options.slice(), ans: r.correct, sec: ci, test: CHAPTER }, r.src ? { src: r.src } : {}, r.via ? { via: r.via } : {}));
    seen.add(key); n++;
  }
  return n;
}
/* sample questions from the site's own bank (same subject first, then the course's past papers): used only as a style guide */
function pickExamples(bank, pick) {
  const S = bank.S || [], lc = (x) => String(x).toLowerCase();
  const cardBy = {}; (bank.CARDS || []).forEach((c) => { if (c) cardBy[c.k] = c; });
  const own = [], paper = [];
  bank.Q0.forEach((q) => {
    const s = S[q.sec]; if (!s) return;
    const y = bank.SUB[s.sub]; if (!y || y.code === "merged") return;
    if (s.sub === pick.i) { if (s.name !== CHAPTER) own.push(q); return; }
    const cd = cardBy[y.cat];
    if (cd && (cd.k === "pp" || cd.t === "Past Papers" || /-pp$/.test(String(cd.k))) && lc(String(cd.course || "Civil")) === lc(pick.course)) paper.push(q);
  });
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  let pool = shuffle(own).slice(0, 4);
  if (pool.length < 3) pool = pool.concat(shuffle(paper).slice(0, 4 - pool.length));
  return pool.map((q) => ({ question: String(q.text).slice(0, 240), options: (q.opts || []).map((o) => String(o).slice(0, 80)), correct: q.ans }));
}
function pickTarget(bank, queued, rot) {
  const cardBy = {};
  (bank.CARDS || []).forEach((c) => { if (c) cardBy[c.k] = c; });
  const cnt = new Array(bank.SUB.length).fill(0);
  bank.Q0.forEach((q) => { const s = bank.S[q.sec]; if (s && s.sub >= 0 && s.sub < cnt.length) cnt[s.sub]++; });
  const qn = {}; queued.forEach((r) => { qn[r.subject] = (qn[r.subject] || 0) + 1; });
  const targets = [];
  bank.SUB.forEach((y, i) => {
    if (!y || y.cat === "__tmp" || y.code !== "Subject") return;
    const cd = cardBy[y.cat];
    if (!cd || cd.k === "pp" || cd.t === "Past Papers" || /-pp$/.test(String(cd.k))) return;
    targets.push({ y, i, cat: y.cat, course: String(cd.course || "Civil").trim() || "Civil", n: cnt[i] + (qn[y.name] || 0) });
  });
  if (!targets.length) return null;
  targets.sort((a, b) => a.n - b.n);
  return targets[rot % Math.min(targets.length, 12)];
}


async function runOnce() {
    const logRef = db.doc("meta/autolog");
    const ls = await logRef.get(), d = ls.exists ? ls.data() : {};
    if (d.writer !== true) return { skipped: "writer is OFF" };
    const lk = d.serverLockAt && d.serverLockAt.toMillis ? d.serverLockAt.toMillis() : 0;
    if (Date.now() - lk < 40 * 1000) return { skipped: "another run is active" };
    await logRef.set({ serverLockAt: FV.serverTimestamp() }, { merge: true });
    const today = new Date().toISOString().slice(0, 10);
    const dayN = d.writerDay === today ? d.writerDayN || 0 : 0;
    if (dayN >= DAY_CAP) return { skipped: "daily cap reached" };

    LAST_FREE = false;
    const cfgDoc = await db.doc("meta/config").get();
    const backup = !(cfgDoc.exists && cfgDoc.data().aiFree === false);   // same "AI backup (free, no key)" switch as the Settings page
    // Admin -> Settings -> "AI keys for each feature": the "Web-search AI Writer" key (meta/aikeys.writer); empty = the main key (meta/ai)
    const kd = await db.doc("meta/aikeys").get();
    const wk = (kd.exists && kd.data().writer) || {};
    const useOwn = String(wk.key || "").trim() !== "";
    const aiDoc = useOwn ? { exists: true, data: () => wk } : await db.doc("meta/ai").get();
    const x = aiDoc.exists ? aiDoc.data() : {};
    const cfg = { backup, key: String(x.key || "").trim(), provider: x.provider || "auto", model: String(x.model || "").trim(), baseUrl: String(x.baseUrl || "").trim(),
      extra: (Array.isArray(x.extra) ? x.extra : []).filter((e) => e && String(e.key || "").trim()).slice(0, 2).map((e) => ({ key: String(e.key).trim(), provider: e.provider || "auto", model: String(e.model || "").trim(), baseUrl: String(e.baseUrl || "").trim() })) };

    const lb = await loadBank();
    if (!lb) { await logRef.set({ serverAt: FV.serverTimestamp(), writerLast: "Server: bank not ready, will retry" }, { merge: true }); return { skipped: "bank not ready" }; }
    const qs = await db.collection("writer_queue").limit(400).get();
    const queued = qs.docs.map((s) => Object.assign({ _id: s.id }, s.data()));

    let saved = 0, note = "", subj = "";
    const pick = pickTarget(lb.bank, queued, d.serverRot || 0);
    if (!pick) note = "No subjects to fill (run 'Organize folders' in the admin panel first).";
    else {
      subj = pick.course + " > " + pick.y.name;
      const label = (/^civil/i.test(pick.course) ? "Civil Engineering" : pick.course) + ": " + pick.y.name;
      try {
        const have = lb.bank.Q0.filter((q) => lb.bank.S[q.sec] && lb.bank.S[q.sec].sub === pick.i).map((q) => q.text)
          .concat(queued.filter((r) => r.subject === pick.y.name).map((r) => r.question));
        let facts = null, via = "";
        const rot = d.serverRot || 0, wantSearch = Math.floor((rot + 1) * SEARCH_SHARE) > Math.floor(rot * SEARCH_SHARE);   // exact 80/20 pattern
        if (wantSearch) { try { const fx = await getFacts(label); if (fx && fx.items && fx.items.length) { facts = fx.items; via = fx.via || ""; } } catch (e) { note = "Search: " + String((e && e.message) || e).slice(0, 100); } }
        const rows = await generate(cfg, label, PER_RUN, have, pickExamples(lb.bank, pick), facts);
        const good = rows.length ? await verify(cfg, label, rows, facts) : [];
        const b = db.batch();
        good.forEach((r) => b.set(db.collection("writer_queue").doc(), { subject: pick.y.name, cat: pick.cat, course: pick.course, question: r.question, options: r.options, correct: r.correct, src: facts ? "search" : "ai", via: [facts ? via : "", LAST_FREE ? "Free AI" : ""].filter(Boolean).join(" + "), createdAt: FV.serverTimestamp() }));
        if (good.length) await b.commit();
        saved = good.length;
        if (!good.length) note = "No MCQ passed the check.";
      } catch (e) { const m = String((e && e.message) || e); note = /429|rate limit|quota/i.test(m) ? "AI limit reached on all keys (waiting for the limit to reset)" : m.slice(0, 160); }
    }

    /* merge the queue into the bank: every 30 minutes or when 100+ are waiting */
    let published = 0;
    const waiting = queued.length + saved;
    const lastPub = d.serverPubAt && d.serverPubAt.toMillis ? d.serverPubAt.toMillis() : 0;
    if (waiting > 0 && (waiting >= PUBLISH_QUEUE_MIN || Date.now() - lastPub >= PUBLISH_EVERY_MS)) {
      try {
        const all = await db.collection("writer_queue").limit(500).get();
        const rows = all.docs.map((s) => s.data());
        const fresh = await db.doc("meta/bank").get();
        if (fresh.exists && fresh.data().version === lb.version) {   // nobody published meanwhile
          published = mergeQueue(lb.bank, rows);
          if (published) await publishBank(lb.bank, lb.parts);
          const del = db.batch(); all.docs.forEach((s) => del.delete(s.ref)); await del.commit();
        } else note = (note ? note + " | " : "") + "Bank changed meanwhile, will merge next time.";
      } catch (e) { note = (note ? note + " | " : "") + "Publish: " + String((e && e.message) || e).slice(0, 120); }
    }

    await logRef.set({
      serverAt: FV.serverTimestamp(), serverRot: (d.serverRot || 0) + 1,
      ...(published || waiting === 0 ? { serverPubAt: FV.serverTimestamp() } : {}),
      writerDay: today, writerDayN: dayN + saved, writerTotal: (d.writerTotal || 0) + saved,
      writerLast: "Free server: " + subj + (saved ? " +" + saved : "") + (published ? " | published " + published + " to bank" : "") + (note ? " \u2014 " + note : ""),
    }, { merge: true });
  return { ok: true, saved, published, subject: subj, note };
}
module.exports = { init, runOnce, _test: { mergeQueue, pickTarget, parseArr, pickExamples } };
