// jira.js — v1.0
// Generic JSON Proxy + Project Restriction + Retries + Multipart Upload
// - Accepts JSON and forwards directly to Jira Cloud; returns raw JSON
// - Enforces defaultProjectKey from channel-config unless json.meta.allowCrossProject === true
// - Verifies project on read/update/delete/transition; prefixes JQL with project=KEY on search
// - Multipart upload with external file fetch (for attachments)
// - Lazy-require getChannelConfig to avoid circular dependency

const axios = require("axios");
const FormData = require("form-data");
const { reportError } = require("./error.js");

/* -------------------- Utils -------------------- */

function debugLog(label, obj) {
  try { console.log(`[Jira DEBUG] ${label}:`, JSON.stringify(obj, null, 2)); }
  catch { console.log(`[Jira DEBUG] ${label}:`, obj); }
}

// Lazy to avoid circular dependency
function getConfigFn() {
  try {
    const mod = require("./discord-helper.js");
    if (mod && typeof mod.getChannelConfig === "function") return mod.getChannelConfig;
  } catch (e) { debugLog("Helper Load Error", e?.message || String(e)); }
  return null;
}

function pickJiraCreds(channelId) {
  const getChannelConfig = getConfigFn();
  if (!getChannelConfig) return null;
  const meta = getChannelConfig(String(channelId || ""));
  if (!meta) return null;

  const blocks = Array.isArray(meta.blocks) ? meta.blocks : [];
  for (const b of blocks) {
    const j = b?.jira || b?.secrets?.jira || null;
    if (j?.baseUrl && j?.email && j?.token) {
      return {
        baseUrl: String(j.baseUrl).replace(/\/+$/, ""),
        email: String(j.email),
        token: String(j.token),
        defaultProjectKey: j.defaultProjectKey ? String(j.defaultProjectKey) : ""
      };
    }
  }
  const j = meta.jira || null;
  if (j?.baseUrl && j?.email && j?.token) {
    return {
      baseUrl: String(j.baseUrl).replace(/\/+$/, ""),
      email: String(j.email),
      token: String(j.token),
      defaultProjectKey: j.defaultProjectKey ? String(j.defaultProjectKey) : ""
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

/* -------------------- Project helpers -------------------- */

// Normalize: inject default project for POST /rest/api/3/issue
function maybeInjectDefaults(req, creds) {
  try {
    const meta = req?.meta || {};
    const allowProject = meta.injectDefaultProject !== false;

    const method = String(req?.method || "GET").toUpperCase();
    const path = String(req?.path || "");

    if (method === "POST" && /\/rest\/api\/3\/issue\/?$/.test(path)) {
      if (allowProject && creds?.defaultProjectKey) {
        if (!req.body || typeof req.body !== "object") req.body = {};
        if (!req.body.fields || typeof req.body.fields !== "object") req.body.fields = {};
        const f = req.body.fields;
        if (!f.project || typeof f.project !== "object") f.project = {};
        f.project.key = creds.defaultProjectKey; // enforce default project on create
      }
      return req;
    }

    return req;
  } catch {
    return req;
  }
}

// Enforce allowed project on various endpoints unless allowCrossProject === true
async function enforceProjectRestriction(req, creds, headers) {
  const allowCross = !!(req?.meta && req.meta.allowCrossProject === true);
  if (allowCross || !creds?.defaultProjectKey) return req;

  const method = String(req?.method || "GET").toUpperCase();
  const path = String(req?.path || "");
  const projectKey = creds.defaultProjectKey;

  // 1) CREATE issue → project already injected in maybeInjectDefaults
  if (method === "POST" && /\/rest\/api\/3\/issue\/?$/.test(path)) {
    if (req?.body && typeof req.body === "object") {
      if (!req.body.fields) req.body.fields = {};
      if (!req.body.fields.project) req.body.fields.project = {};
      req.body.fields.project.key = projectKey; // hard enforce
    }
    return req;
  }

  // 2) SEARCH (JQL) → prefix with project = KEY AND (...)
  if (method === "GET" && /\/rest\/api\/3\/search\/?$/.test(path)) {
    const q = req.query || {};
    const jql = String(q.jql || "").trim();
    const wrapped = jql ? `project = "${projectKey}" AND (${jql})` : `project = "${projectKey}"`;
    req.query = { ...q, jql: wrapped };
    return req;
  }

  // 3) ISSUE operations by idOrKey → verify the issue belongs to the project first
  const issueMatch = path.match(/\/rest\/api\/3\/issue\/([^/]+)(?:\/.*)?$/);
  if (issueMatch) {
    const keyOrId = issueMatch[1];

    // Fetch issue's project
    const checkUrl = `${creds.baseUrl}/rest/api/3/issue/${encodeURIComponent(keyOrId)}?fields=project`;
    const res = await axiosWithRetry({
      method: "GET",
      url: checkUrl,
      headers,
      timeout: 20000
    });

    const key = res?.data?.fields?.project?.key || null;
    if (res.status >= 400 || !key) {
      const err = new Error(`PROJECT_CHECK_FAILED_${res?.status || "ERR"}`);
      err._raw = res?.data;
      throw err;
    }
    if (key !== projectKey) {
      const err = new Error("FORBIDDEN_PROJECT");
      err._project = { expected: projectKey, got: key, issue: keyOrId };
      throw err;
    }
    return req;
  }

  // 4) Everything else: pass through
  return req;
}

/* -------------------- Core Proxy -------------------- */

async function jiraRequest(toolFunction, _context, _getAIResponse, runtime) {
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
        hint: "jiraRequest requires {json:{method:'GET|POST|PUT|DELETE|PATCH', path:'/rest/api/3/...'} }"
      });
    }

    // Credentials
    const channelId = runtime?.channel_id || null;
    const creds = pickJiraCreds(channelId);
    if (!creds) {
      return JSON.stringify({ ok: false, error: "JIRA_CONFIG — Missing jira credentials in channel-config" });
    }

    // Build request basics
    let method = String(req.method || "GET").toUpperCase();
    const responseType = req.responseType === "arraybuffer" ? "arraybuffer" : "json";
    const timeout = Number.isFinite(Number(req.timeoutMs)) ? Number(req.timeoutMs) : 60000;

    const baseUrl = creds.baseUrl;
    const url = isAbsoluteUrl(req.url) ? req.url : buildUrl(baseUrl, req.path || "/", req.query || {});
    const headersIn = (req.headers && typeof req.headers === "object") ? { ...req.headers } : {};
    const headers = { ...headersIn, ...authHeader(creds.email, creds.token), Accept: "application/json" };

    // Inject defaults for issue create, then enforce project restriction
    const withDefaults = maybeInjectDefaults({ ...req }, creds);
    const guardedReq = await enforceProjectRestriction(withDefaults, creds, headers);

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
          const buf = await downloadToBuffer(String(f?.url || "")); // external fetch
          form.append(name, buf, filename);
        }
      }
      data = form;
      finalHeaders = { ...finalHeaders, ...form.getHeaders(), "X-Atlassian-Token": "no-check" };
      // Jira attachments require no Content-Type override; FormData sets it
    } else if (["POST", "PUT", "PATCH"].includes(method)) {
      if (typeof guardedReq.body === "string") {
        data = guardedReq.body;
        if (!finalHeaders["Content-Type"]) finalHeaders["Content-Type"] = "application/json";
      } else if (guardedReq.body && typeof guardedReq.body === "object") {
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
    for (const k of ["x-seraph-loginreason", "x-arequestid", "content-type", "content-length", "location"]) {
      if (res.headers?.[k]) hdrSubset[k] = res.headers[k];
    }

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
    debugLog("HTTP Response", { status: res.status, headers: hdrSubset, preview: (responseType === "json" ? res.data : `arraybuffer(${out.data.bufferLength})`) });
    return JSON.stringify(out);

  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    debugLog("Proxy Error", {
      message: err?.message,
      status,
      dataPreview: typeof data === "string" ? data.slice(0, 500) : data,
      project: err?._project
    });
    await reportError(err, null, "JIRA_PROXY", { emit: "channel" });
    return JSON.stringify({
      ok: false,
      error: err?.message || String(err),
      status: status || null,
      data: data || null,
      project: err?._project || null
    });
  }
}

module.exports = { jiraRequest };
