/**
 * Pallor Sync — compendium sync engine.
 *
 * Every shared document carries flags["pallor-sync"]:
 *   world copy: { id, worldHash, packHash, pack, folderPath, syncedAt, shared }
 *   pack copy:  { id, folderPath, syncedAt, from }
 * `id` is the sync id (the pack document's _id). Change detection is a three-way
 * compare of content hashes: hash(world now) vs worldHash, hash(pack now) vs packHash.
 */
export const MOD = "pallor-sync";
export const TYPES = ["Item", "Actor", "JournalEntry", "Scene", "RollTable", "Macro", "Playlist"];
const SHARED_PREFIX = "forge-vtt-shared-compendiums-";

/** Read one of our flags without getFlag (which requires the module to be active). */
function flagOf(doc, key) { return doc?.flags?.[MOD]?.[key]; }

/* -------------------------------------------- */
/*  Settings helpers                            */
/* -------------------------------------------- */

/** Pack collection ids per document type, from the setting or auto-detected shared packs. */
export function packMap() {
  const saved = game.settings.get(MOD, "packs") ?? {};
  const map = {};
  for (const type of TYPES) {
    if (saved[type] !== undefined) { if (saved[type]) map[type] = saved[type]; continue; }
    const auto = game.packs.find(p => p.metadata.type === type && p.metadata.packageName?.startsWith(SHARED_PREFIX));
    if (auto) map[type] = auto.collection;
  }
  return map;
}

export function packFor(type) {
  const id = packMap()[type];
  return id ? game.packs.get(id) ?? null : null;
}

export function sharedFolderNames() {
  return (game.settings.get(MOD, "sharedFolders") ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

function ignoredIds() {
  return new Set(game.settings.get(MOD, "ignored") ?? []);
}

export async function ignore(sid, on = true) {
  const set = ignoredIds();
  on ? set.add(sid) : set.delete(sid);
  await game.settings.set(MOD, "ignored", [...set]);
}

/* -------------------------------------------- */
/*  Hashing                                     */
/* -------------------------------------------- */

const VOLATILE = {
  Scene: ["thumb", "active"],
  Macro: ["author"],
  Playlist: ["playing"]
};

function stripStats(obj) {
  if (Array.isArray(obj)) { for (const v of obj) stripStats(v); return obj; }
  if (obj && typeof obj === "object") {
    delete obj._stats;
    for (const v of Object.values(obj)) stripStats(v);
  }
  return obj;
}

/** Content-only copy of a document's source data: no ids, stats, folder, sort, ownership, sync flags. */
export function normalize(data, type) {
  const d = foundry.utils.deepClone(data);
  delete d._id; delete d.folder; delete d.sort; delete d.ownership;
  stripStats(d);
  if (d.flags) {
    delete d.flags[MOD];
    delete d.flags.exportSource;
    if (d.flags.core) { delete d.flags.core.sourceId; if (!Object.keys(d.flags.core).length) delete d.flags.core; }
  }
  for (const k of VOLATILE[type] ?? []) delete d[k];
  if (type === "Playlist") for (const s of d.sounds ?? []) { delete s.playing; delete s.pausedTime; }
  if (type === "RollTable") for (const r of d.results ?? []) delete r.drawn;
  return d;
}

function stableStringify(v) {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v).filter(k => v[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

export async function hashOf(doc) {
  const text = stableStringify(normalize(doc.toObject(), doc.documentName));
  if (globalThis.crypto?.subtle) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
  }
  return fnv1a(text);
}

/** Paths that only exist in this world's own folder — they break in the other world. */
function assetWarnings(doc) {
  const text = JSON.stringify(normalize(doc.toObject(), doc.documentName));
  const hits = new Set();
  for (const m of text.matchAll(/"(worlds\/[^"]+\.[a-z0-9]{2,5})"/gi)) hits.add(m[1]);
  return [...hits].slice(0, 8);
}

/* -------------------------------------------- */
/*  Shared-ness and folders                     */
/* -------------------------------------------- */

export function folderPathOf(doc) {
  const names = [];
  for (let f = doc.folder; f; f = f.folder) names.unshift(f.name);
  return names.join("/");
}

export function inSharedFolder(doc) {
  const names = sharedFolderNames();
  if (!names.length) return false;
  for (let f = doc.folder; f; f = f.folder) if (names.includes(f.name.toLowerCase())) return true;
  return false;
}

export function isShared(doc) {
  const flag = doc.flags?.[MOD];
  return !!(flag?.id || flag?.shared) || inSharedFolder(doc);
}

async function ensureFolderPath(type, path, pack = null) {
  if (!path) return null;
  let parent = null;
  for (const name of path.split("/")) {
    const folders = pack ? pack.folders.contents : game.folders.filter(f => f.type === type);
    let f = folders.find(x => x.name === name && (x.folder?.id ?? null) === (parent?.id ?? null));
    if (!f) f = await Folder.create({ name, type, folder: parent?.id ?? null }, pack ? { pack: pack.collection } : {});
    parent = f;
  }
  return parent?.id ?? null;
}

/* -------------------------------------------- */
/*  Scan                                        */
/* -------------------------------------------- */

function entry(type, action, reason, extra = {}) {
  return { type, action, reason, warnings: [], ...extra };
}

/**
 * Compare every shared world document with its shared-pack copy.
 * Actions: push, pull, conflict, link, same, available (unlinked shared doc), ignored.
 * @returns {Promise<{entries: object[], packs: object, counts: object, problems: string[]}>}
 */
export async function scan() {
  const entries = [], problems = [];
  const packs = packMap();
  const ignored = ignoredIds();
  for (const type of TYPES) {
    const pack = packs[type] ? game.packs.get(packs[type]) : null;
    const collection = game.collections.get(type);
    const worldShared = collection.filter(isShared);
    if (!pack) {
      if (worldShared.length) problems.push(game.i18n.format("PSYNC.Problem.NoPack", { type, n: worldShared.length }));
      continue;
    }
    if (pack.locked) { problems.push(game.i18n.format("PSYNC.Problem.Locked", { pack: pack.metadata.label })); continue; }
    const packDocs = await pack.getDocuments();
    const byId = new Map(packDocs.map(d => [flagOf(d, "id") ?? d.id, d]));
    const claimed = new Set();
    const nameKey = d => `${d.type ?? ""}|${d.name.trim().toLowerCase()}`;
    const unlinkedByName = new Map();
    for (const d of packDocs) if (!flagOf(d, "id")) unlinkedByName.set(nameKey(d), d);

    for (const doc of worldShared) {
      const flag = doc.flags?.[MOD] ?? {};
      const base = { name: doc.name, worldUuid: doc.uuid, folderPath: folderPathOf(doc), pack: pack.collection };
      const sid = flag.id ?? null;
      const packDoc = sid ? byId.get(sid) : null;
      if (!packDoc) {
        const match = unlinkedByName.get(nameKey(doc));
        if (match && !claimed.has(match.id)) {
          claimed.add(match.id);
          const [hW, hP] = await Promise.all([hashOf(doc), hashOf(match)]);
          const same = hW === hP;
          const e = entry(type, same ? "link" : "conflict", same ? "link-same" : "link-differs",
            { ...base, sid: match.id, packUuid: match.uuid, link: true, choice: "world" });
          e.warnings = assetWarnings(doc);
          entries.push(e);
          continue;
        }
        const e = entry(type, "push", sid ? "missing-in-shared" : "new", { ...base, sid: sid ?? doc.id });
        e.warnings = assetWarnings(doc);
        entries.push(e);
        continue;
      }
      claimed.add(packDoc.id);
      const [hW, hP] = await Promise.all([hashOf(doc), hashOf(packDoc)]);
      const worldChanged = hW !== flag.worldHash, packChanged = hP !== flag.packHash;
      const ext = { ...base, sid, packUuid: packDoc.uuid };
      let e;
      if (hW === hP) e = entry(type, "same", worldChanged || packChanged ? "touch" : "same", ext);
      else if (worldChanged && !packChanged) e = entry(type, "push", "world-changed", ext);
      else if (!worldChanged && packChanged) e = entry(type, "pull", "shared-changed", ext);
      else e = entry(type, "conflict", "both-changed", { ...ext, choice: "world" });
      if (e.action === "push" || e.action === "conflict") e.warnings = assetWarnings(doc);
      entries.push(e);
    }

    for (const d of packDocs) {
      if (claimed.has(d.id)) continue;
      const sid = flagOf(d, "id");
      const linked = !!sid;
      const id = sid ?? d.id;
      const base = { name: d.name, sid: id, packUuid: d.uuid, pack: pack.collection, folderPath: flagOf(d, "folderPath") ?? "" };
      if (ignored.has(id)) { entries.push(entry(type, "ignored", linked ? "new-from-shared" : "unlinked", base)); continue; }
      entries.push(entry(type, linked ? "pull" : "available", linked ? "new-from-shared" : "unlinked", base));
    }
  }
  const counts = {};
  for (const e of entries) counts[e.action] = (counts[e.action] ?? 0) + 1;
  return { world: game.world.id, scannedAt: Date.now(), packs, entries, counts, problems };
}

/* -------------------------------------------- */
/*  Apply                                       */
/* -------------------------------------------- */

function exportData(doc) {
  const d = stripStats(doc.toObject());
  delete d._id; delete d.folder; delete d.sort; delete d.ownership;
  d.flags ??= {};
  return d;
}

async function writeWorldFlags(worldDoc, packDoc, pack) {
  const [worldHash, packHash] = await Promise.all([hashOf(worldDoc), hashOf(packDoc)]);
  await worldDoc.update({ [`flags.${MOD}`]: { id: packDoc.id, worldHash, packHash, pack: pack.collection, folderPath: folderPathOf(worldDoc), syncedAt: Date.now(), shared: true } });
}

async function pushOne(e) {
  const pack = game.packs.get(e.pack);
  const worldDoc = await fromUuid(e.worldUuid);
  if (!worldDoc) throw new Error(`World document missing: ${e.worldUuid}`);
  const cls = CONFIG[e.type].documentClass;
  const data = exportData(worldDoc);
  data.flags[MOD] = { id: e.sid, folderPath: e.folderPath, syncedAt: Date.now(), from: game.world.id };
  data.folder = await ensureFolderPath(e.type, e.folderPath, pack);
  let packDoc = e.packUuid ? await fromUuid(e.packUuid) : await pack.getDocument(e.sid).catch(() => null);
  if (packDoc) {
    delete data.type;
    await packDoc.update(data, { recursive: false, diff: false });
  } else {
    data._id = e.sid;
    packDoc = await cls.create(data, { pack: pack.collection, keepId: true });
  }
  packDoc = await pack.getDocument(packDoc.id);
  await writeWorldFlags(worldDoc, packDoc, pack);
  return { action: "push", type: e.type, name: worldDoc.name, sid: packDoc.id };
}

async function pullOne(e) {
  const pack = game.packs.get(e.pack);
  const packDoc = await fromUuid(e.packUuid);
  if (!packDoc) throw new Error(`Shared document missing: ${e.packUuid}`);
  const cls = CONFIG[e.type].documentClass;
  const collection = game.collections.get(e.type);
  const data = exportData(packDoc);
  const folderPath = flagOf(packDoc, "folderPath") ?? e.folderPath ?? "";
  let worldDoc = e.worldUuid ? await fromUuid(e.worldUuid) : null;
  if (e.type === "Macro") data.author = game.user.id;
  if (e.type === "Scene") data.active = false;
  if (worldDoc) {
    delete data.type;
    data.folder = worldDoc.folder?.id ?? null;
    data.ownership = foundry.utils.deepClone(worldDoc.ownership);
    await worldDoc.update(data, { recursive: false, diff: false });
  } else {
    data.folder = await ensureFolderPath(e.type, folderPath);
    data.ownership = { default: packDoc.ownership?.default ?? CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE };
    const keepId = !collection.has(e.sid);
    if (keepId) data._id = e.sid;
    worldDoc = await cls.create(data, { keepId });
  }
  if (!flagOf(packDoc, "id")) await packDoc.update({ [`flags.${MOD}`]: { id: packDoc.id, folderPath, syncedAt: Date.now(), from: null } });
  await writeWorldFlags(worldDoc, packDoc, pack);
  return { action: "pull", type: e.type, name: worldDoc.name, sid: packDoc.id };
}

async function linkOne(e) {
  const pack = game.packs.get(e.pack);
  const worldDoc = await fromUuid(e.worldUuid);
  const packDoc = await fromUuid(e.packUuid);
  if (!flagOf(packDoc, "id")) await packDoc.update({ [`flags.${MOD}`]: { id: packDoc.id, folderPath: folderPathOf(worldDoc), syncedAt: Date.now(), from: game.world.id } });
  await writeWorldFlags(worldDoc, packDoc, pack);
  return { action: "link", type: e.type, name: worldDoc.name, sid: packDoc.id };
}

/**
 * Apply plan entries. `choices` maps sid -> "world" | "shared" for conflicts.
 * @returns {Promise<{done: object[], errors: object[]}>}
 */
export async function apply(entries, choices = {}) {
  const done = [], errors = [];
  for (const e of entries) {
    try {
      const choice = choices[e.sid] ?? e.choice ?? "world";
      let r;
      if (e.action === "push") r = await pushOne(e);
      else if (e.action === "pull" || e.action === "available") r = await pullOne(e);
      else if (e.action === "link" || e.action === "same") r = await linkOne(e);
      else if (e.action === "conflict") r = choice === "shared" ? await pullOne(e) : await pushOne(e);
      else continue;
      done.push(r);
    } catch (err) {
      console.error(`${MOD} |`, e, err);
      errors.push({ type: e.type, name: e.name, action: e.action, error: err.message });
    }
  }
  return { done, errors };
}

/** Mark a world document as shared (it is pushed on the next sync). */
export async function share(doc) {
  if (isShared(doc)) return false;
  await doc.update({ [`flags.${MOD}.shared`]: true });
  return true;
}

/** Stop sharing: drop the world flags and optionally delete the shared copy. */
export async function unshare(doc, { deleteShared = false } = {}) {
  const flag = doc.flags?.[MOD];
  if (flag?.id && deleteShared) {
    const pack = game.packs.get(flag.pack) ?? packFor(doc.documentName);
    const packDoc = pack ? await pack.getDocument(flag.id).catch(() => null) : null;
    if (packDoc) await packDoc.delete();
  }
  await doc.update({ [`flags.-=${MOD}`]: null });
  return true;
}

/** Entries that are safe to apply without a GM decision. */
export function autoEntries(plan, { includeAvailable = false } = {}) {
  return plan.entries.filter(e =>
    e.action === "push" || e.action === "pull" || e.action === "link" ||
    (e.action === "same" && e.reason === "touch") ||
    (includeAvailable && e.action === "available"));
}

/** Scan, apply everything except conflicts, return the report. */
export async function syncAll(options = {}) {
  const plan = await scan();
  const result = await apply(autoEntries(plan, options));
  return {
    ...result,
    conflicts: plan.entries.filter(e => e.action === "conflict"),
    available: plan.entries.filter(e => e.action === "available"),
    problems: plan.problems,
    counts: plan.counts
  };
}
