// jira.js — v1.9
// Generic JSON Proxy for Jira Cloud
// - Project Restriction
// - Always use /rest/api/3/search/jql (legacy /search GET/POST normalized)
// - Respect original verb for search: GET -> query params, POST -> JSON body
// - ORDER BY kept at the end when prefixing project
// - Defaults for fields/expand/maxResults on search
// - JQL placeholder sanitization (KEY / "KEY" / YOUR_PROJECT_KEY)
// - Gentle retries for 5xx/429
// - Transitions support:
//   * GET  /rest/api/3/issue/{issueIdOrKey}/transitions        → passthrough
//   * POST /rest/api/3/issue/{issueIdOrKey}/transitions        → accepts {transition:{id}, fields?} OR {transitionId, transitionName}
//   * PUT/PATCH /rest/api/3/issue/{issueIdOrKey} with fields.status/statusName → auto-convert to transition (name→id), apply fields (without status) during transition

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

  const variants = [
    /project\s*=\s*("?|')?KEY\1/gi,
    /project\s*=\s*("?|')?YOUR_PROJECT_KEY\1/gi
  ];

  for (const re of variants) {
    if (defaultProjectKey) {
      s = s.replace(re, `project = "${defaultProjectKey}"`);
    } else {
      s = s.replace(re, "").trim();
    }
  }

  // Clean up after removals
  s = s
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^\s*(AND|OR)\s+/i, "")
    .replace(/\s+(AND|OR)\s*$/i, "")
    .replace(/\s+(AND|OR)\s+(AND|OR)\s+/gi, " $2 ")
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

function normalizeSearchRequest(reqIn, defaultProjectKey) {
  const allowCross = !!(reqIn?.meta && reqIn.meta.allowCrossProject === true);
  const isSearchPath = (p) =>
    /^https?:\/\/[^/]+\/rest\/api\/3\/search(?:\/jql)?\/?$|^\/rest\/api\/3\/search(?:\/jql)?\/?$/i
      .test(String(p || ""));
  const p = reqIn.path || reqIn.url || "";
  if (!isSearchPath(p)) return reqIn;

  const origMethod = String(reqIn.method || "GET").toUpperCase();
  const q = reqIn.query || {};
  const bodyIn = (reqIn.body && typeof reqIn.body === "object") ? { ...reqIn.body } : {};

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

  // Respect the original method:
  if (origMethod === "GET") {
    // GET /rest/api/3/search/jql?jql=...&maxResults=...&startAt=...&fields=...&expand=...
    const query = {
      jql,
      ...(startAt    !== undefined ? { startAt: String(Number(startAt)) } : {}),
      ...(maxResults !== undefined ? { maxResults: String(Number(maxResults)) } : {}),
      ...(fields && fields.length ? { fields: fields.join(",") } : {}),
      ...(expand && expand.length ? { expand: expand.join(",") } : {})
    };
    return {
      ...reqIn,
      method: "GET",
      path: "/rest/api/3/search/jql",
      url: undefined,
      query,
      headers: {
        ...(reqIn.headers || {}),
        Accept: "application/json"
      },
      body: undefined
    };
  }

  // POST /rest/api/3/search/jql with JSON body
  return {
    ...reqIn,
    method: "POST",
    path: "/rest/api/3/search/jql",
    url: undefined,
    query: {},
    headers: {
      ...(reqIn.headers || {}),
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

/* -------------------- Transition helpers ---------------------------------- */

function parseIssueFromPath(pathOrUrl) {
  const s = String(pathOrUrl || "");
  const m = s.match(/\/rest\/api\/3\/issue\/([^\/\?\s]+)(?:\/|$)/i);
  return m ? m[1] : null;
}

function isTransitionsPath(pathOrUrl) {
  return /\/rest\/api\/3\/issue\/[^\/]+\/transitions\/?$/i.test(String(pathOrUrl || ""));
}

function isIssueUpdatePath(pathOrUrl) {
  return /\/rest\/api\/3\/issue\/[^\/]+\/?$/i.test(String(pathOrUrl || ""));
}

function desiredStatusFromBody(body) {
  if (!body) return null;
  // Accept several shapes
  if (typeof body.statusName === "string") return body.statusName;
  if (typeof body.status === "string") return body.status;
  if (body.status && typeof body.status.name === "string") return body.status.name;
  if (body.fields && body.fields.status && typeof body.fields.status.name === "string") return body.fields.status.name;
  return null;
}

function stripStatusFromFields(fields) {
  if (!fields || typeof fields !== "object") return fields;
  const copy = { ...fields };
  if (copy.status) {
    const { status, ...rest } = copy;
    return rest;
  }
  return copy;
}

async function listTransitions(baseUrl, issue, headers, query) {
  const url = buildUrl(baseUrl, `/rest/api/3/issue/${encodeURIComponent(issue)}/transitions`, query || {});
  return axiosWithRetry({ method: "GET", url, headers, responseType: "json", timeout: 60000 });
}

async function postTransition(baseUrl, issue, headers, transitionId, fields) {
  const url = buildUrl(baseUrl, `/rest/api/3/issue/${encodeURIComponent(issue)}/transitions`);
  const body = {
    transition: { id: String(transitionId) },
    ...(fields && Object.keys(fields).length ? { fields } : {})
  };
  return axiosWithRetry({
    method: "POST",
    url,
    headers: { ...headers, "Content-Type": "application/json", Accept: "application/json" },
    data: body,
    responseType: "json",
    timeout: 60000
  });
}

async function resolveTransitionIdByName(baseUrl, issue, headers, name) {
  const res = await listTransitions(baseUrl, issue, headers, { expand: "transitions.fields" });
  const transitions = Array.isArray(res?.data?.transitions) ? res.data.transitions : [];
  const wanted = String(name || "").trim().toLowerCase();
  const hit = transitions.find(t => String(t.name || "").trim().toLowerCase() === wanted);
  return hit ? String(hit.id) : null;
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

    // Normalize search to /search/jql, respecting original verb
    let req = { ...reqIn, headers };
    req = normalizeSearchRequest(req, creds.defaultProjectKey);

    // --- Transitions: passthrough for GET/POST transitions, and auto-convert status updates ---
    const pathOrUrl = req.path || req.url || "";
    const method = String(req.method || "GET").toUpperCase();

    // 1) Explicit transitions listing
    if (isTransitionsPath(pathOrUrl) && method === "GET") {
      const issue = parseIssueFromPath(pathOrUrl);
      const res = await listTransitions(baseUrl, issue, req.headers || headers, req.query || {});
      const out = {
        ok: res.status < 400,
        status: res.status,
        url: res.config?.url,
        headers: subsetHeaders(res.headers),
        data: res.data,
        took_ms: Date.now() - startedAt
      };
      debugLog("HTTP Response (transitions GET)", { status: res.status, preview: res.data });
      return JSON.stringify(out);
    }

    // 2) Explicit transitions POST (accepts transitionName or transitionId)
    if (isTransitionsPath(pathOrUrl) && method === "POST") {
      const issue = parseIssueFromPath(pathOrUrl);
      const b = (req.body && typeof req.body === "object") ? req.body : {};
      let transitionId =
        b?.transition?.id ||
        b?.transitionId ||
        (typeof b?.id === "string" ? b.id : null);

      const transitionName =
        b?.transition?.name ||
        b?.transitionName ||
        (typeof b?.name === "string" ? b.name : null);

      let fields = (b.fields && typeof b.fields === "object") ? b.fields : undefined;

      if (!transitionId && transitionName) {
        transitionId = await resolveTransitionIdByName(baseUrl, issue, req.headers || headers, transitionName);
        if (!transitionId) {
          return JSON.stringify({
            ok: false,
            error: "TRANSITION_NOT_FOUND",
            hint: `No transition named '${transitionName}' available for issue ${issue}.`
          });
        }
      }
      if (!transitionId) {
        return JSON.stringify({
          ok: false,
          error: "MISSING_TRANSITION",
          hint: "Provide transitionId or transitionName."
        });
      }

      const res = await postTransition(baseUrl, issue, req.headers || headers, transitionId, fields);
      const out = {
        ok: res.status < 400,
        status: res.status,
        url: res.config?.url,
        headers: subsetHeaders(res.headers),
        data: res.data,
        took_ms: Date.now() - startedAt
      };
      debugLog("HTTP Response (transitions POST)", { status: res.status, preview: res.data });
      return JSON.stringify(out);
    }

    // 3) Issue update with a desired status → auto-convert to transition
    if (isIssueUpdatePath(pathOrUrl) && (method === "PUT" || method === "PATCH")) {
      const desired = desiredStatusFromBody(req.body);
      if (desired) {
        const issue = parseIssueFromPath(pathOrUrl);
        // Remove status from fields for use in transition fields
        const fieldsIn = (req.body && typeof req.body === "object") ? (req.body.fields || {}) : {};
        const fields = stripStatusFromFields(fieldsIn);

        const transitionId = await resolveTransitionIdByName(baseUrl, issue, req.headers || headers, desired);
        if (!transitionId) {
          return JSON.stringify({
            ok: false,
            error: "TRANSITION_NOT_FOUND",
            hint: `No transition named '${desired}' available for issue ${issue}.`
          });
        }

        const res = await postTransition(baseUrl, issue, req.headers || headers, transitionId, fields);
        const out = {
          ok: res.status < 400,
          status: res.status,
          url: res.config?.url,
          headers: subsetHeaders(res.headers),
          data: res.data,
          took_ms: Date.now() - startedAt,
          info: { autoConvertedFrom: method, desiredStatus: desired }
        };
        debugLog("HTTP Response (auto-transition via issue update)", { status: res.status, preview: res.data });
        return JSON.stringify(out);
      }
    }

    // --- Default proxy path: anything else (including normalized search) ---
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

    const out = {
      ok: res.status < 400,
      status: res.status,
      url: finalUrl,
      headers: subsetHeaders(res.headers),
      data: responseType === "arraybuffer"
        ? { bufferLength: Buffer.isBuffer(res.data) ? res.data.length : 0 }
        : res.data,
      took_ms: Date.now() - startedAt
    };
    debugLog("HTTP Response", { status: res.status, headers: subsetHeaders(res.headers), preview: (responseType === "json" ? res.data : `arraybuffer(${out.data.bufferLength})`) });
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

function subsetHeaders(h) {
  const hdrSubset = {};
  for (const k of ["x-arequestid", "content-type", "content-length", "location", "x-ratelimit-remaining", "retry-after"]) {
    if (h?.[k]) hdrSubset[k] = h[k];
  }
  return hdrSubset;
}

module.exports = { jiraRequest };
