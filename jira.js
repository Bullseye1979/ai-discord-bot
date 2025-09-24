// jira.js — v1.7
// Generic JSON Proxy for Jira Cloud + Project Restriction + Always-use /rest/api/3/search/jql + Retries + ORDER BY fix
// + Defaults: request useful fields (summary, status, …) if none provided
// + JQL placeholder sanitization: replace project = KEY / "KEY" / YOUR_PROJECT_KEY (with/without quotes)

const axios = require("axios");
const { reportError } = require("./error.js");

/* -------------------- Utils -------------------- */

function debugLog(label, obj) {
  try { console.log(`[Jira DEBUG] ${label}:`, JSON.stringify(obj, null, 2)); }
  catch { console.log(`[Jira DEBUG] ${label}:`, obj); }
}

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

function asArray(v) {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return v;
  const s = String(v);
  if (s.includes(",")) return s.split(",").map(x => x.trim()).filter(Boolean);
  return [s];
}

/* -------------------- Gentle retries -------------------- */

async function axiosWithRetry(opts, max = 2) {
  let attempt = 0, last;
  while (attempt <= max) {
    const res = await axios.request({ ...opts, validateStatus: () => true });
    if (res.status < 500 && res.status !== 429) return res;
    last = res;
    const delay = Math.min(1500 * (attempt + 1), 4000);
    await new Promise(r => setTimeout(r, delay));
    attempt++;
  }
  return last;
}

/* -------------------- ORDER BY handling + Project restriction -------------- */

function splitJqlOrderBy(jql) {
  const src = String(jql || "");
  const m = src.match(/\border\s+by\b/i);
  if (!m) return { core: src.trim(), orderBy: "" };
  const idx = m.index;
  const core = src.slice(0, idx).trim();
  const orderBy = src.slice(idx).trim();
  return { core, orderBy };
}

function prefixProjectToJql(jql, projectKey) {
  const { core, orderBy } = splitJqlOrderBy(jql);
  const base = String(core || "").trim();
  const proj = `project = "${projectKey}"`;

  if (!projectKey) return [base, orderBy].filter(Boolean).join(" ").trim();
  if (!base) return [proj, orderBy].filter(Boolean).join(" ").trim();

  const re = new RegExp(`project\\s*=\\s*"?${projectKey.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}"?`, "i");
  const coreWithProj = re.test(base) ? base : `${proj} AND (${base})`;
  return [coreWithProj, orderBy].filter(Boolean).join(" ").trim();
}

/* -------------------- Placeholder cleanup ---------------------------------- */

function sanitizeJqlPlaceholders(jql, defaultProjectKey) {
  let s = String(jql || "").trim();
  if (!s) return s;

  // Match variants:
  // project = KEY
  // project = "KEY"
  // project = YOUR_PROJECT_KEY
  // project = 'YOUR_PROJECT_KEY'
  // (case-insensitive; optional quotes and whitespace)
  const variants = [
    /project\s*=\s*("?|')?KEY\1/gi,
    /project\s*=\s*("?|')?YOUR_PROJECT_KEY\1/gi
  ];

  for (const re of variants) {
    if (defaultProjectKey) {
      s = s.replace(re, `project = "${defaultProjectKey}"`);
    } else {
      // remove the clause entirely if we don't know the project key
      s = s.replace(re, "").trim();
    }
  }

  // Remove accidental empty parens and fix dangling AND/OR due to removals
  // e.g., "AND ()", "() AND", duplicate spaces, etc.
  s = s
    .replace(/\(\s*\)/g, "")                 // empty parentheses
    .replace(/\s{2,}/g, " ")                 // multiple spaces
    .replace(/^\s*(AND|OR)\s+/i, "")         // leading AND/OR
    .replace(/\s+(AND|OR)\s*$/i, "")         // trailing AND/OR
    .replace(/\s+(AND|OR)\s+(AND|OR)\s+/gi, " $2 ") // collapse double operators
    .trim();

  return s;
}

/* -------------------- Search normalization + default fields ---------------- */

const DEFAULT_FIELDS = [
  "summary",
  "status",
  "issuetype",
  "priority",
  "assignee",
  "reporter",
  "created",
  "updated"
];

function normalizeSearchRequest(req, defaultProjectKey) {
  const allowCross = !!(req?.meta && req.meta.allowCrossProject === true);
  const isSearchPath = (p) =>
    /^https?:\/\/[^/]+\/rest\/api\/3\/search(?:\/jql)?\/?$|^\/rest\/api\/3\/search(?:\/jql)?\/?$/i
      .test(String(p || ""));
  const p = req.path || req.url || "";
  if (!isSearchPath(p)) return req;

  const q = req.query || {};
  const bodyIn = (req.body && typeof req.body === "object") ? { ...req.body } : {};

  let jql        = (bodyIn.jql ?? q.jql ?? "").toString();
  const startAt  = (bodyIn.startAt ?? q.startAt);
  let maxResults = (bodyIn.maxResults ?? q.maxResults);
  let fields     = asArray(bodyIn.fields ?? q.fields);
  let expand     = asArray(bodyIn.expand ?? q.expand);

  // Sanitize placeholders first
  jql = sanitizeJqlPlaceholders(jql, defaultProjectKey);

  // Default JQL if nothing left
  if (!jql) jql = "ORDER BY created DESC";

  // Project restriction unless explicitly allowed
  if (!allowCross && defaultProjectKey) {
    jql = prefixProjectToJql(jql, defaultProjectKey);
  }

  // Sensible defaults
  if (!fields || fields.length === 0) fields = DEFAULT_FIELDS.slice();
  if (!expand || expand.length === 0) expand = ["renderedFields"];
  if (maxResults === undefined || maxResults === null) maxResults = 50;

  debugLog("Effective JQL", { jql });

  return {
    ...req,
    method: "POST",
    path: "/rest/api/3/search/jql",
    url: undefined,
    query: {},
    headers: {
      ...(req.headers || {}),
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: {
      jql,
      ...(startAt    !== undefined ? { startAt: Number(startAt) } : {}),
      ...(maxResults !== undefined ? { maxResults: Number(maxResults) } : {}),
      ...(fields && fields.length ? { fields } : {}),
      ...(expand && expand.length ? { expand } : {})
    }
  };
}

/* -------------------- Core Proxy ------------------------------------------ */

async function jiraRequest(toolFunction, _context, _getAIResponse, runtime) {
  const startedAt = Date.now();
  try {
    const rawArgs = typeof toolFunction?.arguments === "string"
      ? JSON.parse(toolFunction.arguments || "{}")
      : (toolFunction?.arguments || {});
    const reqIn = rawArgs.json || rawArgs || {};
    debugLog("ToolCall JSON (in)", reqIn);

    if (!reqIn || typeof reqIn !== "object" || !reqIn.method || (!reqIn.path && !reqIn.url)) {
      debugLog("Bad Tool Args", reqIn);
      return JSON.stringify({
        ok: false,
        error: "BAD_TOOL_ARGS",
        hint: "jiraRequest requires {json:{method:'GET|POST|PUT|DELETE|PATCH', path:'/rest/api/...'} }"
      });
    }

    const channelId = runtime?.channel_id || null;
    const creds = pickJiraCreds(channelId);
    if (!creds) {
      return JSON.stringify({ ok: false, error: "JIRA_CONFIG — Missing Jira credentials in channel-config" });
    }

    const baseUrl = creds.baseUrl;
    const headersIn = (reqIn.headers && typeof reqIn.headers === "object") ? { ...reqIn.headers } : {};
    const headers = { ...headersIn, ...authHeader(creds.email, creds.token) };

    // Always normalize search to /search/jql + project + default fields
    let req = { ...reqIn, headers };
    req = normalizeSearchRequest(req, creds.defaultProjectKey);

    let method = String(req.method || "GET").toUpperCase();
    const responseType = req.responseType === "arraybuffer" ? "arraybuffer" : "json";
    const timeout = Number.isFinite(Number(req.timeoutMs)) ? Number(req.timeoutMs) : 60000;

    const finalUrl = isAbsoluteUrl(req.url) ? req.url : buildUrl(baseUrl, req.path || "/", req.query || {});
    let data = undefined;
    let finalHeaders = { ...(req.headers || headers) };

    if (["POST", "PUT", "PATCH"].includes(method)) {
      if (typeof req.body === "string") {
        data = req.body;
        if (!finalHeaders["Content-Type"]) finalHeaders["Content-Type"] = "application/json";
      } else if (req.body && typeof req.body === "object") {
        data = req.body;
        finalHeaders["Content-Type"] = "application/json";
      }
    }

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
    for (const k of ["x-arequestid", "content-type", "content-length", "location", "x-ratelimit-remaining", "retry-after"]) {
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
      dataPreview: typeof data === "string" ? data.slice(0, 500) : data
    });
    await reportError(err, null, "JIRA_PROXY", { emit: "channel" });
    return JSON.stringify({
      ok: false,
      error: err?.message || String(err),
      status: status || null,
      data: data || null
    });
  }
}

module.exports = { jiraRequest };
