// confluence.js — v2.0 (Generic JSON Proxy to Confluence)
// - Accepts JSON and forwards directly to Confluence; returns raw JSON response
// - Only restriction: default space/parent can be auto-injected from channel-config (toggle via meta)
// - Lazy-require getChannelConfig to avoid circular dependency
// - Debug logs for requests and responses

const axios = require("axios");
const FormData = require("form-data");
const { reportError } = require("./error.js");

/* -------------------- Helpers -------------------- */

function debugLog(label, obj) {
  try {
    console.log(`[Confluence DEBUG] ${label}:`, JSON.stringify(obj, null, 2));
  } catch {
    console.log(`[Confluence DEBUG] ${label}:`, obj);
  }
}

// Lazy require to avoid circular dependency
function getConfigFn() {
  try {
    const mod = require("./discord-helper.js");
    if (mod && typeof mod.getChannelConfig === "function") return mod.getChannelConfig;
  } catch (e) {
    debugLog("Helper Load Error", e?.message || String(e));
  }
  return null;
}

function pickConfluenceCreds(channelId) {
  const getChannelConfig = getConfigFn();
  if (!getChannelConfig) return null;

  const meta = getChannelConfig(String(channelId || ""));
  if (!meta) return null;

  // Prefer blocks[].confluence
  const blocks = Array.isArray(meta.blocks) ? meta.blocks : [];
  for (const b of blocks) {
    const c = b?.confluence || b?.secrets?.confluence || null;
    if (c && c.baseUrl && c.email && c.token) {
      return {
        baseUrl: String(c.baseUrl).replace(/\/+$/, ""),
        email: String(c.email),
        token: String(c.token),
        defaultSpace: c.defaultSpace ? String(c.defaultSpace) : "",
        defaultParentId: c.defaultParentId ? String(c.defaultParentId) : ""
      };
    }
  }

  // Fallback: meta.confluence
  const c = meta.confluence || null;
  if (c && c.baseUrl && c.email && c.token) {
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

function isAbsoluteUrl(u) {
  return /^https?:\/\//i.test(String(u || ""));
}

async function downloadToBuffer(url) {
  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 60000,
    validateStatus: () => true
  });
  if (res.status >= 400) {
    const err = new Error(`FILE_FETCH_${res.status}`);
    err._raw = { status: res.status, headers: res.headers, data: res.data?.toString?.() || null };
    throw err;
  }
  return Buffer.from(res.data);
}

function ensureStorageHtml(s) {
  const str = String(s || "").trim();
  if (!str) return "<p></p>";
  const hasTags = /<[a-z][\s>]/i.test(str);
  return hasTags ? str : `<p>${str.replace(/[<>&]/g, m => ({ "<":"&lt;", ">":"&gt;", "&":"&amp;" }[m]))}</p>`;
}

/**
 * Optional: inject default space/parent into a POST /rest/api/content body
 * if not provided by the caller. Can be disabled via meta flags.
 */
function maybeInjectDefaults(req, creds) {
  try {
    const meta = req?.meta || {};
    const allowSpace = meta.injectDefaultSpace !== false;
    const allowParent = meta.injectDefaultParent !== false;

    // Only for POST to /rest/api/content
    const method = String(req?.method || "GET").toUpperCase();
    const path = String(req?.path || "");
    if (!(method === "POST" && /\/rest\/api\/content\/?$/.test(path))) return req;

    if (!req.body || typeof req.body !== "object") return req;
    const body = req.body;

    // If body.type === 'page', default to storage representation for simple plaintext
    if (body.type === "page" && body.body && body.body.storage && body.body.storage.value) {
      body.body.storage.value = ensureStorageHtml(body.body.storage.value);
      body.body.storage.representation = body.body.storage.representation || "storage";
    }

    if (allowSpace && creds?.defaultSpace) {
      if (!body.space) body.space = {};
      if (!body.space.key) body.space.key = creds.defaultSpace;
    }

    if (allowParent && creds?.defaultParentId && !Array.isArray(body.ancestors)) {
      body.ancestors = [{ id: String(creds.defaultParentId) }];
    }
    return req;
  } catch {
    return req;
  }
}

/* -------------------- Core Proxy -------------------- */

/**
 * Tool entry: "confluencePage" (generic JSON proxy)
 * Accepted arguments:
 *  {
 *    "json": {                    // or put fields top-level; "json" takes precedence
 *      "method": "GET|POST|PUT|DELETE|PATCH",   // default GET
 *      "path": "/rest/api/...",  // or full "url"
 *      "url": "https://.../rest/api/...",       // absolute URL (overrides path)
 *      "query": { ... },         // optional query params
 *      "headers": { ... },       // optional extra headers (Authorization will be overwritten)
 *      "body": { ... } | "raw string",          // JSON body or raw string
 *      "responseType": "json" | "arraybuffer",  // default "json"
 *      "timeoutMs": 60000,                       // optional timeout
 *      // Multipart upload:
 *      "multipart": true,        // if true → build FormData
 *      "form": { key:value },    // optional form fields
 *      "files": [ { name, url, filename } ],    // optional files to upload
 *
 *      // Optional meta flags:
 *      "meta": {
 *        "injectDefaultSpace": true,   // default true
 *        "injectDefaultParent": true   // default true
 *      }
 *    }
 *  }
 *
 * Returns:
 *  {
 *    ok: boolean,
 *    status: number,
 *    url: string,
 *    headers: { ...subset... },
 *    data: any
 *  }
 */
async function confluencePage(toolFunction, _context, _getAIResponse, runtime) {
  const startedAt = Date.now();
  try {
    // 1) Parse args
    const rawArgs = typeof toolFunction?.arguments === "string"
      ? JSON.parse(toolFunction.arguments || "{}")
      : (toolFunction?.arguments || {});

    const req = rawArgs.json || rawArgs || {};
    debugLog("ToolCall JSON (in)", req);

    // 2) Credentials
    const channelId = runtime?.channel_id || null;
    const creds = pickConfluenceCreds(channelId);
    if (!creds) {
      return JSON.stringify({ ok: false, error: "CONF_CONFIG — Missing confluence credentials in channel-config" });
    }

    // 3) Build request
    let method = String(req.method || "GET").toUpperCase();
    const responseType = req.responseType === "arraybuffer" ? "arraybuffer" : "json";
    const timeout = Number.isFinite(Number(req.timeoutMs)) ? Number(req.timeoutMs) : 60000;

    const baseUrl = creds.baseUrl;
    const url = isAbsoluteUrl(req.url) ? req.url : buildUrl(baseUrl, req.path || "/", req.query || {});
    const headersIn = (req.headers && typeof req.headers === "object") ? { ...req.headers } : {};
    const headers = { ...headersIn, ...authHeader(creds.email, creds.token) };

    // 4) Optional: inject default space/parent for POST content
    const effectiveReq = maybeInjectDefaults(req, creds);

    // 5) Body / Multipart
    let data = undefined;
    let finalHeaders = { ...headers };

    if (effectiveReq.multipart) {
      const form = new FormData();
      if (effectiveReq.form && typeof effectiveReq.form === "object") {
        for (const [k, v] of Object.entries(effectiveReq.form)) {
          if (v === undefined || v === null) continue;
          form.append(k, typeof v === "string" ? v : JSON.stringify(v));
        }
      }
      if (Array.isArray(effectiveReq.files)) {
        for (const f of effectiveReq.files) {
          const name = f?.name || "file";
          const filename = f?.filename || (String(f?.url || "").split("/").pop()?.split("?")[0]) || "upload.bin";
          const buf = await downloadToBuffer(String(f?.url || ""));
          form.append(name, buf, filename);
        }
      }
      data = form;
      finalHeaders = { ...finalHeaders, ...form.getHeaders(), "X-Atlassian-Token": "no-check" };
    } else if (["POST", "PUT", "PATCH"].includes(method)) {
      if (typeof effectiveReq.body === "string") {
        data = effectiveReq.body; // raw string
        if (!finalHeaders["Content-Type"]) {
          finalHeaders["Content-Type"] = "application/json"; // default
        }
      } else if (effectiveReq.body && typeof effectiveReq.body === "object") {
        data = effectiveReq.body;
        finalHeaders["Content-Type"] = "application/json";
      } else {
        data = undefined;
      }
    }

    // 6) Execute
    debugLog("HTTP Request", { method, url, headers: Object.keys(finalHeaders), responseType, timeout });
    const res = await axios.request({
      method,
      url,
      headers: finalHeaders,
      data,
      timeout,
      responseType,
      validateStatus: () => true
    });

    const hdrSubset = {};
    for (const k of ["x-seraph-loginreason", "x-confluence-request-time", "content-type", "content-length", "location"]) {
      if (res.headers?.[k]) hdrSubset[k] = res.headers[k];
    }

    const out = {
      ok: res.status < 400,
      status: res.status,
      url,
      headers: hdrSubset,
      data: responseType === "arraybuffer" ? { bufferLength: Buffer.isBuffer(res.data) ? res.data.length : 0 } : res.data,
      took_ms: Date.now() - startedAt
    };
    debugLog("HTTP Response", { status: res.status, headers: hdrSubset, preview: (responseType === "json" ? res.data : `arraybuffer(${out.data.bufferLength})`) });
    return JSON.stringify(out);

  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    debugLog("Proxy Error", { message: err?.message, status, dataPreview: typeof data === "string" ? data.slice(0, 500) : data });
    await reportError(err, null, "CONF_PROXY", { emit: "channel" });
    return JSON.stringify({
      ok: false,
      error: err?.message || String(err),
      status: status || null,
      data: data || null
    });
  }
}

module.exports = { confluencePage };
