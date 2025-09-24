// confluence.js — v1.0 (create/update/delete page + upload/embed image)
// - Liest Credentials aus channel-config/<channelId>.json  → blocks[].confluence{ baseUrl, email, token, defaultSpace, defaultParentId }
// - ToolCall-Name: "confluencePage"
// - Actions: create | update | delete
// - Optional: image_url -> lädt als Attachment hoch und bettet es mit <ac:image> ein

const axios = require("axios");
const FormData = require("form-data");
const { getChannelConfig } = require("./discord-helper.js");
const { reportError } = require("./error.js");

function pickConfluenceCreds(channelId) {
  const meta = getChannelConfig(String(channelId || ""));
  if (!meta) return null;

  // 1) Bevorzugt: Block mit .confluence
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

  // 2) Fallback: channelMeta.confluence (optional)
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

async function getPageVersion({ baseUrl, headers, pageId }) {
  const url = `${baseUrl}/rest/api/content/${encodeURIComponent(pageId)}?expand=version`;
  const { data } = await axios.get(url, { headers, timeout: 20000, validateStatus: () => true });
  if (!data || !data.version || typeof data.version.number !== "number") {
    throw new Error("CONF_VERSION_LOOKUP_FAILED");
  }
  return data.version.number;
}

function ensureStorageHtml(s) {
  // Erlaubt: bereits fertiges HTML im Storage-Format; bei Plaintext kapseln wir minimal
  const str = String(s || "").trim();
  if (!str) return "<p></p>";
  const hasTags = /<[a-z][\s>]/i.test(str);
  return hasTags ? str : `<p>${str.replace(/[<>&]/g, m => ({ "<":"&lt;", ">":"&gt;", "&":"&amp;" }[m]))}</p>`;
}

async function createPageApi({ baseUrl, headers, spaceKey, title, contentHtml, parentId }) {
  const body = {
    type: "page",
    title,
    space: { key: spaceKey },
    body: { storage: { value: contentHtml, representation: "storage" } }
  };
  if (parentId) body.ancestors = [{ id: String(parentId) }];

  const url = `${baseUrl}/rest/api/content`;
  const res = await axios.post(url, body, { headers: { ...headers, "Content-Type": "application/json" }, timeout: 30000, validateStatus: () => true });
  if (res.status >= 300) throw new Error(`CONF_CREATE_HTTP_${res.status}`);
  return res.data;
}

async function updatePageApi({ baseUrl, headers, pageId, newTitle, newHtml }) {
  const current = await getPageVersion({ baseUrl, headers, pageId });
  const body = {
    id: String(pageId),
    type: "page",
    title: newTitle,
    version: { number: current + 1 },
    body: { storage: { value: newHtml, representation: "storage" } }
  };
  const url = `${baseUrl}/rest/api/content/${encodeURIComponent(pageId)}`;
  const res = await axios.put(url, body, { headers: { ...headers, "Content-Type": "application/json" }, timeout: 30000, validateStatus: () => true });
  if (res.status >= 300) throw new Error(`CONF_UPDATE_HTTP_${res.status}`);
  return res.data;
}

async function deletePageApi({ baseUrl, headers, pageId }) {
  const url = `${baseUrl}/rest/api/content/${encodeURIComponent(pageId)}`;
  const res = await axios.delete(url, { headers, timeout: 30000, validateStatus: () => true });
  if (res.status >= 300) throw new Error(`CONF_DELETE_HTTP_${res.status}`);
  return { ok: true };
}

async function uploadAttachmentApi({ baseUrl, headers, pageId, filename, buffer }) {
  const url = `${baseUrl}/rest/api/content/${encodeURIComponent(pageId)}/child/attachment`;
  const form = new FormData();
  form.append("file", buffer, filename);

  const res = await axios.post(url, form, {
    headers: { ...headers, "X-Atlassian-Token": "no-check", ...form.getHeaders() },
    timeout: 60000,
    maxContentLength: 20 * 1024 * 1024,
    maxBodyLength: 20 * 1024 * 1024,
    validateStatus: () => true
  });
  if (res.status >= 300) throw new Error(`CONF_ATTACH_HTTP_${res.status}`);
  const att = res?.data?.results?.[0];
  if (!att?.title) throw new Error("CONF_ATTACH_PARSE_FAILED");
  return { filename: att.title };
}

function buildImageMacro(filename) {
  const safe = String(filename || "").replace(/[<>&"]/g, s => ({ "<":"&lt;", ">":"&gt;", "&":"&amp;", '"':"&quot;" }[s]));
  return `<ac:image><ri:attachment ri:filename="${safe}" /></ac:image>`;
}

/**
 * Tool entry (single function): "confluencePage"
 * Arguments (JSON):
 * {
 *   "action": "create" | "update" | "delete",
 *   // create:
 *   "space_key": "DOC",
 *   "title": "My title",
 *   "content_html": "<p>text</p>",        // optional (wird ge-wrappt, wenn Plaintext)
 *   "parent_id": "123456",                // optional
 *   "image_url": "https://…/img.png",     // optional: lädt + einbetten
 *   "image_filename": "img.png",          // optional override
 *   // update/delete:
 *   "page_id": "987654321"
 * }
 *
 * Rückgabe (JSON string):
 * { ok: true, id, title, url } | { ok: false, error }
 */
async function confluencePage(toolFunction, _context, _getAIResponse, runtime) {
  try {
    // --- Args robust parsen
    const args = typeof toolFunction?.arguments === "string"
      ? JSON.parse(toolFunction.arguments || "{}")
      : (toolFunction?.arguments || {});

    const action = String(args.action || "").toLowerCase(); // required
    const pageId = args.page_id ? String(args.page_id) : "";
    const spaceKey = String(args.space_key || "");
    const title = String(args.title || "");
    const parentId = args.parent_id ? String(args.parent_id) : "";
    const contentHtml = ensureStorageHtml(args.content_html || args.content || "");
    const imageUrl = String(args.image_url || "");
    const imageFilename = String(args.image_filename || "");

    // --- Credentials aus Channel-Block
    const channelId = runtime?.channel_id || null;
    const creds = pickConfluenceCreds(channelId);
    if (!creds) {
      return JSON.stringify({ ok: false, error: "CONF_CONFIG — Missing confluence credentials in channel-config blocks[].confluence" });
    }
    const headers = authHeader(creds.email, creds.token);
    const effectiveSpace = spaceKey || creds.defaultSpace || "";

    if (!["create","update","delete"].includes(action)) {
      return JSON.stringify({ ok: false, error: "CONF_ARGS — action must be create|update|delete" });
    }

    if (action === "create") {
      if (!effectiveSpace) return JSON.stringify({ ok: false, error: "CONF_ARGS — space_key is required (or blocks[].confluence.defaultSpace)" });
      if (!title) return JSON.stringify({ ok: false, error: "CONF_ARGS — title is required" });

      // Seite anlegen
      const data = await createPageApi({
        baseUrl: creds.baseUrl,
        headers,
        spaceKey: effectiveSpace,
        title,
        contentHtml,
        parentId: parentId || creds.defaultParentId || ""
      });

      const id = data?.id;
      let newTitle = data?.title || title;

      // Optional: Bild hochladen + einbetten
      if (imageUrl) {
        try {
          const img = await axios.get(imageUrl, { responseType: "arraybuffer", timeout: 45000, validateStatus: () => true });
          if (img.status >= 300) throw new Error(`IMG_FETCH_${img.status}`);
          const ct = String(img.headers?.["content-type"] || "").toLowerCase();
          if (!ct.startsWith("image/")) throw new Error("IMG_NOT_IMAGE");

          const fname = imageFilename || imageUrl.split("/").pop()?.split("?")[0] || "image.png";
          await uploadAttachmentApi({
            baseUrl: creds.baseUrl,
            headers,
            pageId: id,
            filename: fname,
            buffer: Buffer.from(img.data)
          });

          const macro = buildImageMacro(fname);
          const html = contentHtml + "\n\n" + macro;

          const upd = await updatePageApi({
            baseUrl: creds.baseUrl,
            headers,
            pageId: id,
            newTitle,
            newHtml: html
          });
          newTitle = upd?.title || newTitle;
        } catch (e) {
          // Bild ist optional → Fehler nur loggen
          await reportError(e, null, "CONF_IMAGE_EMBED", { emit: "channel" });
        }
      }

      const url = data?._links?.webui ? `${creds.baseUrl}${data._links.webui}` : "";
      return JSON.stringify({ ok: true, id, title: newTitle, url });
    }

    if (action === "update") {
      if (!pageId) return JSON.stringify({ ok: false, error: "CONF_ARGS — page_id is required for update" });
      if (!title) return JSON.stringify({ ok: false, error: "CONF_ARGS — title is required for update" });

      let targetHtml = contentHtml;

      // Optional: Bild zuerst hochladen und in HTML einbetten (fügt unten an)
      if (imageUrl) {
        const img = await axios.get(imageUrl, { responseType: "arraybuffer", timeout: 45000, validateStatus: () => true });
        if (img.status >= 300) throw new Error(`IMG_FETCH_${img.status}`);
        const ct = String(img.headers?.["content-type"] || "").toLowerCase();
        if (!ct.startsWith("image/")) throw new Error("IMG_NOT_IMAGE");

        const fname = imageFilename || imageUrl.split("/").pop()?.split("?")[0] || "image.png";
        await uploadAttachmentApi({
          baseUrl: creds.baseUrl,
          headers,
          pageId,
          filename: fname,
          buffer: Buffer.from(img.data)
        });
        targetHtml = (targetHtml || "<p></p>") + "\n\n" + buildImageMacro(fname);
      }

      const upd = await updatePageApi({
        baseUrl: creds.baseUrl,
        headers,
        pageId,
        newTitle: title,
        newHtml: targetHtml
      });

      const url = upd?._links?.webui ? `${creds.baseUrl}${upd._links.webui}` : "";
      return JSON.stringify({ ok: true, id: upd?.id || pageId, title: upd?.title || title, url });
    }

    // delete
    if (!pageId) return JSON.stringify({ ok: false, error: "CONF_ARGS — page_id is required for delete" });
    await deletePageApi({ baseUrl: creds.baseUrl, headers, pageId });
    return JSON.stringify({ ok: true, id: pageId, deleted: true });

  } catch (err) {
    const msg = err?.message || String(err);
    await reportError(err, null, "CONF_TOOL", { emit: "channel" });
    return JSON.stringify({ ok: false, error: msg });
  }
}

module.exports = { confluencePage };
