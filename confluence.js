// confluence.js — v2.4 (Cloud Editor compat + auto-expand)
// - Accepts JSON and forwards directly to Confluence; returns raw JSON
// - Enforces defaultSpace from channel-config unless meta.allowCrossSpace === true
// - Verifies space on update/delete; prefixes CQL with space=KEY on search
// - Optional meta.autoBumpVersion: fetches current version and bumps if missing
// - Optional meta.appendStorageHtml: fetches current storage HTML and appends HTML (keine versehentliche Escapes)
// - Cloud Editor Compatibility scrub for storage XHTML (headings, wrapping, basic cleanup)
// - Auto-Expand: GET immer (konfigurierbar) body.storage (und optional ADF) mitliefern
// - After POST/PUT: optionaler Follow-up GET mit expand, damit Chat IMMER Text hat
// - Multipart upload with external file fetch
// - Lazy-require getChannelConfig to avoid circular dependency

const axios = require("axios");
const FormData = require("form-data");
const { reportError } = require("./error.js");

/* -------------------- Utils -------------------- */

function debugLog(label, obj) {
  try { console.log(`[Confluence DEBUG] ${label}:`, JSON.stringify(obj, null, 2)); }
  catch { console.log(`[Confluence DEBUG] ${label}:`, obj); }
}

// Lazy to avoid circular dependency
function getConfigFn() {
  try {
    const mod = require("./discord-helper.js");
    if (mod && typeof mod.getChannelConfig === "function") return mod.getChannelConfig;
  } catch (e) { debugLog("Helper Load Error", e?.message || String(e)); }
  return null;
}

function pickConfluenceCreds(channelId) {
  const getChannelConfig = getConfigFn();
  if (!getChannelConfig) return null;
  const meta = getChannelConfig(String(channelId || ""));
  if (!meta) return null;

  const blocks = Array.isArray(meta.blocks) ? meta.blocks : [];
  for (const b of blocks) {
    const c = b?.confluence || b?.secrets?.confluence || null;
    if (c?.baseUrl && c?.email && c?.token) {
      return {
        baseUrl: String(c.baseUrl).replace(/\/+$/, ""),
        email: String(c.email),
        token: String(c.token),
        defaultSpace: c.defaultSpace ? String(c.defaultSpace) : "",
        defaultParentId: c.defaultParentId ? String(c.defaultParentId) : ""
      };
    }
  }
  const c = meta.confluence || null;
  if (c?.baseUrl && c?.email && c?.token) {
    return {
      baseUrl: String(c.baseUrl).replace(/\/+$/, ""),
      email: String(c.email),
      token: String(c.token),
      defaultSpace: c.defaultSpace ? String(c.defaultSpace) : "",
      defaultParentId: c.defaultParentId ? String(c.defaultParentId) : ""
    };
  }
  return null;
}

function authHeader(email, token) {
  const basic = Buffer.from(`${email}:${token}`).toString("base64");
  return { Authorization: `Basic ${basic}` };
}

function buildUrl(baseUrl, path, query) {
  const root = String(baseUrl || "").replace(/\/+$/, "");
  const p = String(path || "").trim();
  const rel = p.startsWith("/") ? p : `/${p}`;
  const qs = new URLSearchParams();
  if (query && typeof query === "object") {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) v.forEach(val => qs.append(k, String(val)));
      else qs.append(k, String(v));
    }
  }
  const q = qs.toString();
  return q ? `${root}${rel}?${q}` : `${root}${rel}`;
}

function isAbsoluteUrl(u) { return /^https?:\/\//i.test(String(u || "")); }

async function downloadToBuffer(url) {
  const res = await axios.get(url, { responseType: "arraybuffer", timeout: 60000, validateStatus: () => true });
  if (res.status >= 400) {
    const err = new Error(`FILE_FETCH_${res.status}`);
    err._raw = { status: res.status, headers: res.headers, data: res.data?.toString?.() || null };
    throw err;
  }
  return Buffer.from(res.data);
}

/* -------------------- Cloud-Editor Compat (Storage XHTML) -------------------- */
/**
 * Confluence Cloud Editor (v2) zeigt weiterhin 'storage' an, aber:
 * - <h1> ist reserviert (Seitentitel) → in <h2> umwandeln
 * - lose Textknoten vermeiden → Notfalls <p> wrappen
 * - übermäßig viele <br> normalisieren
 * - triviale self-closing normalisieren (<br> → <br/>)
 * - (Optional) Weitere harte Verbote könnten hier ergänzt werden
 */
function scrubStorageForCloudEditor(html) {
  if (!html || typeof html !== "string") return html;

  let s = html;

  // h1 -> h2 (Cloud nutzt H1 für den Titel)
  s = s.replace(/<\s*h1(\s[^>]*)?>/gi, "<h2$1>");
  s = s.replace(/<\s*\/\s*h1\s*>/gi, "</h2>");

  // <br> → <br/> und Runs von <br/><br/><br/> auf max 2 kürzen
  s = s.replace(/<br\s*>/gi, "<br/>");
  s = s.replace(/(?:<br\/>\s*){3,}/gi, "<br/><br/>");

  // Top-level reiner Text → in <p> wrappen (nur wenn es nicht schon valider Block ist)
  // Heuristik: wenn das Ganze keine Tags enthält, übernehmen ensureStorageHtml ohnehin das Wrapping.
  // Hier noch: Texte außerhalb von Block-Tag-Gruppen schnell einschließen.
  // (Sehr einfache Heuristik, bewusst konservativ)
  const trimmed = s.trim();
  if (!/^<([a-z]+:)?[a-z]/i.test(trimmed)) {
    s = `<p>${escapeText(trimmed)}</p>`;
  }

  return s;
}

function escapeText(str) {
  return String(str || "").replace(/[<>&]/g, m => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[m]));
}

/**
 * ensureStorageHtml
 * - Lässt gültiges Storage-XHTML (inkl. Namespaces wie <ac:image>, <ri:attachment>, <ri:page>) UNVERÄNDERT
 *   (bis auf Cloud-Compat-Scrub).
 * - Wrappt nur reinen Text in <p>…</p> und escapt ihn.
 */
function ensureStorageHtml(s) {
  const str = String(s || "").trim();
  if (!str) return "<p></p>";

  // Erkenne HTML/Storage-XHTML Tags:
  const hasTags = /<([a-z]+:)?[a-z][^>]*>/i.test(str);
  if (hasTags) {
    // Cloud-Editor-Compat-Scrub auf bestehendem HTML
    return scrubStorageForCloudEditor(str);
  }

  // Sonst: als reinen Text behandeln
  return `<p>${escapeText(str)}</p>`;
}

/* -------------------- Helper: axios with gentle retries -------------------- */

async function axiosWithRetry(opts, max = 2) {
  let attempt = 0;
  let last;
  while (attempt <= max) {
    const res = await axios.request({ ...opts, validateStatus: () => true });
    // Pass through anything < 500 and not 429
    if (res.status < 500 && res.status !== 429) return res;
    last = res;
    const delay = Math.min(1500 * (attempt + 1), 4000);
    await new Promise(r => setTimeout(r, delay));
    attempt++;
  }
  return last;
}

/* -------------------- Space helpers -------------------- */

// Normalize: inject defaultSpace/parent for POST /rest/api/content
function maybeInjectDefaults(req, creds) {
  try {
    const meta = req?.meta || {};
    const allowSpace = meta.injectDefaultSpace !== false;
    const allowParent = meta.injectDefaultParent !== false;

    const method = String(req?.method || "GET").toUpperCase();
    const path = String(req?.path || "");
    if (!(method === "POST" && /\/rest\/api\/content\/?$/.test(path))) return req;

    if (!req.body || typeof req.body !== "object") return req;
    const body = req.body;

    // Normalize storage body (Cloud-compat)
    if (body.type === "page" && body?.body?.storage?.value) {
      body.body.storage.value = ensureStorageHtml(body.body.storage.value);
      body.body.storage.representation = body.body.storage.representation || "storage";
    }

    if (allowSpace && creds?.defaultSpace) {
      if (!body.space) body.space = {};
      body.space.key = creds.defaultSpace; // enforce default space on create
    }

    if (allowParent && creds?.defaultParentId && !Array.isArray(body.ancestors)) {
      body.ancestors = [{ id: String(creds.defaultParentId) }];
    }
    return req;
  } catch {
    return req;
  }
}

// Enforce allowed space on various endpoints unless allowCrossSpace === true
async function enforceSpaceRestriction(req, creds, headers) {
  const allowCross = !!(req?.meta && req.meta.allowCrossSpace === true);
  if (allowCross || !creds?.defaultSpace) return req;

  const method = String(req?.method || "GET").toUpperCase();
  const path = String(req?.path || "");
  const spaceKey = creds.defaultSpace;

  // 1) CREATE page → space already injected
  if (method === "POST" && /\/rest\/api\/content\/?$/.test(path)) {
    if (req?.body && typeof req.body === "object") {
      if (!req.body.space) req.body.space = {};
      req.body.space.key = spaceKey;
    }
    return req;
  }

  // 2) SEARCH → prefix CQL with space=KEY AND (...)
  if (method === "GET" && /\/rest\/api\/content\/search\/?$/.test(path)) {
    const q = req.query || {};
    const cql = String(q.cql || "").trim();
    const wrapped = cql ? `space = "${spaceKey}" AND (${cql})` : `space = "${spaceKey}"`;
    req.query = { ...q, cql: wrapped };
    return req;
  }

  // 3) LIST content → force spaceKey param
  if (method === "GET" && /\/rest\/api\/content\/?$/.test(path)) {
    const q = req.query || {};
    q.spaceKey = spaceKey;
    req.query = q;
    return req;
  }

  // 4) UPDATE/DELETE/CHILD on a page id → verify page space first
  const idMatch = path.match(/\/rest\/api\/content\/(\d+)(?:\/.*)?$/);
  if ((method === "PUT" || method === "DELETE" || method === "POST" || method === "GET") && idMatch) {
    const pageId = idMatch[1];

    const checkUrl = `${creds.baseUrl}/rest/api/content/${encodeURIComponent(pageId)}?expand=space`;
    const res = await axiosWithRetry({
      method: "GET",
      url: checkUrl,
      headers,
      timeout: 20000
    });

    const key = res?.data?.space?.key || null;
    if (res.status >= 400 || !key) {
      const err = new Error(`SPACE_CHECK_FAILED_${res?.status || "ERR"}`);
      err._raw = res?.data;
      throw err;
    }
    if (key !== spaceKey) {
      const err = new Error("FORBIDDEN_SPACE");
      err._space = { expected: spaceKey, got: key, pageId };
      throw err;
    }
    return req;
  }

  // 5) Everything else: pass through
  return req;
}

/* -------------------- Content helpers -------------------- */

async function fetchVersionNumber(baseUrl, id, headers) {
  const url = `${baseUrl}/rest/api/content/${encodeURIComponent(id)}?expand=version`;
  const r = await axiosWithRetry({ method: "GET", url, headers, timeout: 20000 });
  if (r.status >= 400 || !r.data?.version?.number) {
    const e = new Error(`FETCH_VERSION_FAILED_${r.status}`);
    e._raw = r.data;
    throw e;
  }
  return Number(r.data.version.number);
}

async function fetchStorageHtml(baseUrl, id, headers, { includeADF = false } = {}) {
  const expand = includeADF ? "body.storage,body.atlas_doc_format,version" : "body.storage,version";
  const url = `${baseUrl}/rest/api/content/${encodeURIComponent(id)}?expand=${encodeURIComponent(expand)}`;
  const r = await axiosWithRetry({ method: "GET", url, headers, timeout: 20000 });
  if (r.status >= 400 || !r.data?.body?.storage?.value) {
    const e = new Error(`FETCH_STORAGE_FAILED_${r.status}`);
    e._raw = r.data;
    throw e;
  }
  return { page: r.data, html: String(r.data.body.storage.value), version: Number(r.data.version?.number || 1) };
}

/* -------------------- Core Proxy -------------------- */

async function confluencePage(toolFunction, _context, _getAIResponse, runtime) {
  const startedAt = Date.now();
  try {
    const rawArgs = typeof toolFunction?.arguments === "string"
      ? JSON.parse(toolFunction.arguments || "{}")
      : (toolFunction?.arguments || {});
    const req = rawArgs.json || rawArgs || {};
    debugLog("ToolCall JSON (in)", req);

    // Early validation
    if (!req || typeof req !== "object" || !req.method || (!req.path && !req.url)) {
      debugLog("Bad Tool Args", req);
      return JSON.stringify({
        ok: false,
        error: "BAD_TOOL_ARGS",
        hint: "confluencePage requires {json:{method:'GET|POST|PUT|DELETE|PATCH', path:'/rest/api/...'} }"
      });
    }

    // Credentials
    const channelId = runtime?.channel_id || null;
    const creds = pickConfluenceCreds(channelId);
    if (!creds) {
      return JSON.stringify({ ok: false, error: "CONF_CONFIG — Missing confluence credentials in channel-config" });
    }

    // Build request basics
    let method = String(req.method || "GET").toUpperCase();
    const responseType = req.responseType === "arraybuffer" ? "arraybuffer" : "json";
    const timeout = Number.isFinite(Number(req.timeoutMs)) ? Number(req.timeoutMs) : 60000;

    const baseUrl = creds.baseUrl;
    const headersIn = (req.headers && typeof req.headers === "object") ? { ...req.headers } : {};
    const headers = { ...headersIn, ...authHeader(creds.email, creds.token) };

    // Defaults
    const meta = req.meta || {};
    const autoExpandGET = meta.autoExpandGET !== false;               // default true
    const includeADF = meta.includeADF === true;                      // opt-in ADF return
    const followUpExpandOnWrite = meta.followUpExpandOnWrite !== false; // default true

    // Inject defaults for create page, then enforce space restriction
    const withDefaults = maybeInjectDefaults({ ...req }, creds);
    const guardedReq = await enforceSpaceRestriction(withDefaults, creds, headers);

    // ---- Auto-Expand for GETs ----
    if (autoExpandGET && String(guardedReq.method || "").toUpperCase() === "GET") {
      const p = String(guardedReq.path || "");
      const isContentGet = /\/rest\/api\/content(\/\d+)?\/?$/.test(p) || /\/rest\/api\/content\/\d+$/i.test(p);
      const isSearch = /\/rest\/api\/content\/search\/?$/.test(p);
      if (isContentGet && !isSearch) {
        const q = guardedReq.query || {};
        const existing = String(q.expand || "").split(",").map(s => s.trim()).filter(Boolean);
        const wanted = ["body.storage", "version"];
        if (includeADF) wanted.push("body.atlas_doc_format");
        const final = Array.from(new Set([...existing, ...wanted])).join(",");
        guardedReq.query = { ...q, expand: final };
      }
    }

    // ---- Meta features: append storage + auto-bump version (preparation) ----

    // If appendStorageHtml is requested on PUT page, fetch current HTML & version and merge
    if (
      String(guardedReq.method || "").toUpperCase() === "PUT" &&
      guardedReq.meta?.appendStorageHtml &&
      typeof guardedReq.body === "object" &&
      guardedReq.body?.type === "page"
    ) {
      const idMatch = (guardedReq.path || "").match(/\/rest\/api\/content\/(\d+)(?:\/.*)?$/);
      const pageId = idMatch?.[1] || guardedReq.body?.id;
      if (pageId) {
        const { html: oldHtml, version: v } = await fetchStorageHtml(baseUrl, pageId, headers, { includeADF });
        const add = ensureStorageHtml(guardedReq.meta.appendStorageHtml);
        const merged = scrubStorageForCloudEditor(oldHtml + add);

        if (!guardedReq.body.body) guardedReq.body.body = {};
        guardedReq.body.body.storage = {
          value: merged,
          representation: "storage"
        };

        // If version not set, provisionally set to current+1; can be overridden by autoBumpVersion below
        if (!guardedReq.body.version || !Number.isFinite(Number(guardedReq.body.version.number))) {
          guardedReq.body.version = { number: v + 1 };
        }
      }
    }

    // If autoBumpVersion is requested on PUT page, ensure version.number exists
    if (
      String(guardedReq.method || "").toUpperCase() === "PUT" &&
      typeof guardedReq.body === "object" &&
      guardedReq.body?.type === "page" &&
      guardedReq.meta?.autoBumpVersion === true
    ) {
      const idMatch = (guardedReq.path || "").match(/\/rest\/api\/content\/(\d+)(?:\/.*)?$/);
      const pageId = idMatch?.[1] || guardedReq.body?.id;
      if (pageId) {
        const current = await fetchVersionNumber(baseUrl, pageId, headers);
        if (!guardedReq.body.version || typeof guardedReq.body.version !== "object") {
          guardedReq.body.version = {};
        }
        if (!Number.isFinite(Number(guardedReq.body.version.number))) {
          guardedReq.body.version.number = current + 1;
        }
      }
    }

    // Body / Multipart
    let data = undefined;
    let finalHeaders = { ...headers };

    if (guardedReq.multipart) {
      const form = new FormData();
      if (guardedReq.form && typeof guardedReq.form === "object") {
        for (const [k, v] of Object.entries(guardedReq.form)) {
          if (v === undefined || v === null) continue;
          form.append(k, typeof v === "string" ? v : JSON.stringify(v));
        }
      }
      if (Array.isArray(guardedReq.files)) {
        for (const f of guardedReq.files) {
          const name = f?.name || "file";
          const filename = f?.filename || (String(f?.url || "").split("/").pop()?.split("?")[0]) || "upload.bin";
          const buf = await downloadToBuffer(String(f?.url || ""));
          form.append(name, buf, filename);
        }
      }
      data = form;
      finalHeaders = { ...finalHeaders, ...form.getHeaders(), "X-Atlassian-Token": "no-check" };
    } else if (["POST", "PUT", "PATCH"].includes(method)) {
      if (typeof guardedReq.body === "string") {
        data = guardedReq.body;
        if (!finalHeaders["Content-Type"]) finalHeaders["Content-Type"] = "application/json";
      } else if (guardedReq.body && typeof guardedReq.body === "object") {
        // Cloud-Compat auf body.body.storage.value anwenden (falls vorhanden)
        if (guardedReq.body?.type === "page" && guardedReq.body?.body?.storage?.value) {
          guardedReq.body.body.storage.value = ensureStorageHtml(guardedReq.body.body.storage.value);
          guardedReq.body.body.storage.representation = guardedReq.body.body.storage.representation || "storage";
        }
        data = guardedReq.body;
        finalHeaders["Content-Type"] = "application/json";
      } else {
        data = undefined;
      }
    }

    const finalUrl = isAbsoluteUrl(guardedReq.url) ? guardedReq.url : buildUrl(baseUrl, guardedReq.path || "/", guardedReq.query || {});

    // Execute with retries
    debugLog("HTTP Request", { method, url: finalUrl, headers: Object.keys(finalHeaders), responseType, timeout });
    const res = await axiosWithRetry({
      method,
      url: finalUrl,
      headers: finalHeaders,
      data,
      timeout,
      responseType
    });

    const hdrSubset = {};
    for (const k of ["x-seraph-loginreason", "x-confluence-request-time", "content-type", "content-length", "location"]) {
      if (res.headers?.[k]) hdrSubset[k] = res.headers[k];
    }

    // Basis-Out
    const out = {
      ok: res.status < 400,
      status: res.status,
      url: finalUrl,
      headers: hdrSubset,
      data: responseType === "arraybuffer"
        ? { bufferLength: Buffer.isBuffer(res.data) ? res.data.length : 0 }
        : res.data,
      took_ms: Date.now() - startedAt
    };

    // Nach POST/PUT: wenn Page-ID vorhanden und followUpExpandOnWrite aktiv → expand nachziehen
    const mayFollowUp = followUpExpandOnWrite && ["POST", "PUT"].includes(method) && !responseType !== "arraybuffer";
    if (mayFollowUp) {
      try {
        const newId =
          out?.data?.id ||
          // einige Endpoints liefern location-Header …/content/{id}
          (typeof hdrSubset.location === "string" ? (hdrSubset.location.match(/content\/(\d+)/)?.[1] || null) : null);

        if (newId) {
          const expand = includeADF ? "body.storage,body.atlas_doc_format,version,space" : "body.storage,version,space";
          const followUrl = `${baseUrl}/rest/api/content/${encodeURIComponent(newId)}?expand=${encodeURIComponent(expand)}`;
          const follow = await axiosWithRetry({
            method: "GET",
            url: followUrl,
            headers: finalHeaders,
            timeout: 20000,
            responseType: "json"
          });

          // **Wichtig:** Originaldaten NICHT überschreiben, sondern zusätzlich bereitstellen
          out.data_expanded = follow?.data || null;
          // und für Chat-Komfort einen „previewText“ (reiner Text) extrahieren
          const storageHtml = follow?.data?.body?.storage?.value || "";
          out.preview_text = extractPlainTextFromStorage(storageHtml).slice(0, 4000);
        }
      } catch (e) {
        debugLog("Follow-up expand failed", e?.message || String(e));
      }
    }

    debugLog("HTTP Response", { status: out.status, headers: hdrSubset, preview: (responseType === "json" ? out.data : `arraybuffer(${out.data.bufferLength})`) });
    return JSON.stringify(out);

  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    debugLog("Proxy Error", {
      message: err?.message,
      status,
      dataPreview: typeof data === "string" ? data.slice(0, 500) : data,
      space: err?._space
    });
    await reportError(err, null, "CONF_PROXY", { emit: "channel" });
    return JSON.stringify({
      ok: false,
      error: err?.message || String(err),
      status: status || null,
      data: data || null,
      space: err?._space || null
    });
  }
}

/* ---------- Helpers: Plaintext-Extraction (für Chat-Vorschau) ---------- */
function extractPlainTextFromStorage(html) {
  if (!html || typeof html !== "string") return "";
  // Sehr einfache, robuste Ent-Taggung für Chat-Zwecke (kein perfekter Renderer!)
  let s = html;

  // Zeilenumbrüche um Block-Elemente
  s = s.replace(/<\/(p|h[2-6]|li|div|tr)>/gi, "</$1>\n");

  // Listen-Bullets grob markieren
  s = s.replace(/<li[^>]*>/gi, "- ");

  // Tags strippen
  s = s.replace(/<[^>]+>/g, "");

  // Entities
  s = s.replace(/&nbsp;/g, " ");
  s = s.replace(/&amp;/g, "&");
  s = s.replace(/&lt;/g, "<");
  s = s.replace(/&gt;/g, ">");

  // Whitespace normalisieren
  s = s.replace(/\r?\n\s*\n\s*\n+/g, "\n\n").trim();
  return s;
}

module.exports = { confluencePage };
