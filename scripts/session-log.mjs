/**
 * Pallor Sync — session recorder.
 *
 * The active GM client records what happens at the table into a JournalEntry
 * "Pallor Session Log": one text page per session. Each page carries
 *   flags["pallor-sync"].session = { id, name, started, ended, world, users, exported }
 *   flags["pallor-sync"].events  = [{ t, kind, text, data? }, ...]
 * and its text is a readable rendering of the same events. Events are buffered and
 * flushed every few seconds, on "end session" and on page unload.
 */
import { MOD } from "./sync.mjs";

/** Read one of our flags without getFlag (works before the module is active). */
function flagOf(doc, key) { return doc?.flags?.[MOD]?.[key]; }

const LOG_NAME = "Pallor Session Log";
const FLUSH_MS = 8000;
const WATCH = {
  hp: "system.attributes.hp.value",
  temp: "system.attributes.hp.temp",
  xp: "system.details.xp.value",
  level: "system.details.level",
  exhaustion: "system.attributes.exhaustion",
  gp: "system.currency.gp", sp: "system.currency.sp", cp: "system.currency.cp", pp: "system.currency.pp", ep: "system.currency.ep"
};

let buffer = [];
let dirty = false;
let timer = null;
let pageId = null;
const actorCache = new Map();
const qtyCache = new Map();
const journalDebounce = new Map();
let lastScene = null;

function enabled() {
  return game.settings.get(MOD, "logEnabled") && game.user.isGM && (game.users.activeGM?.id ?? game.user.id) === game.user.id;
}

function stripHtml(html) {
  const div = document.createElement("div");
  div.innerHTML = html ?? "";
  return div.textContent.replace(/\s+/g, " ").trim();
}

function actorName(actor) {
  return actor?.name ?? "?";
}

function snapshotActor(actor) {
  const s = {};
  for (const [k, path] of Object.entries(WATCH)) s[k] = foundry.utils.getProperty(actor, path);
  actorCache.set(actor.id, s);
  for (const item of actor.items ?? []) if (item.system?.quantity !== undefined) qtyCache.set(item.uuid, item.system.quantity);
  return s;
}

/* -------------------------------------------- */
/*  Storage                                     */
/* -------------------------------------------- */

async function logEntry() {
  let entry = game.journal.find(j => flagOf(j, "isLog"));
  if (!entry) {
    entry = await JournalEntry.create({
      name: LOG_NAME,
      ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE },
      flags: { [MOD]: { isLog: true } }
    });
  }
  return entry;
}

function currentPage() {
  if (!pageId) return null;
  const entry = game.journal.find(j => flagOf(j, "isLog"));
  return entry?.pages.get(pageId) ?? null;
}

function renderHtml(session, events) {
  const fmt = t => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const rows = events.map(e => `<li><code>${fmt(e.t)}</code> <em>${e.kind}</em> — ${foundry.utils.escapeHTML(e.text)}</li>`).join("");
  const meta = `<p><strong>${foundry.utils.escapeHTML(session.name)}</strong><br>Started ${new Date(session.started).toLocaleString()}${session.ended ? `<br>Ended ${new Date(session.ended).toLocaleString()}` : ""}<br>World: ${session.world} · Players: ${(session.users ?? []).join(", ") || "—"} · Events: ${events.length}</p>`;
  return `${meta}<ol class="pallor-log">${rows}</ol>`;
}

async function flush() {
  if (!dirty) return;
  const page = currentPage();
  if (!page) return;
  const session = flagOf(page, "session") ?? {};
  const events = [...(flagOf(page, "events") ?? []), ...buffer];
  const pending = buffer;
  buffer = [];
  dirty = false;
  try {
    await page.update({ "text.content": renderHtml(session, events), [`flags.${MOD}.events`]: events });
  } catch (err) {
    buffer = [...pending, ...buffer];
    dirty = true;
    console.error(`${MOD} | session log flush failed`, err);
  }
}

function schedule() {
  dirty = true;
  if (timer) return;
  timer = setTimeout(() => { timer = null; flush(); }, FLUSH_MS);
}

/* -------------------------------------------- */
/*  Public session API                          */
/* -------------------------------------------- */

export function record(kind, text, data) {
  if (!pageId || !enabled()) return;
  const e = { t: Date.now(), kind, text: String(text).slice(0, 2000) };
  if (data !== undefined) e.data = data;
  buffer.push(e);
  schedule();
}

export async function startSession(name) {
  if (!game.user.isGM) throw new Error("GM only");
  await flush();
  const entry = await logEntry();
  const started = Date.now();
  const session = {
    id: foundry.utils.randomID(),
    name: name || `Session ${new Date(started).toISOString().slice(0, 10)}`,
    started, ended: null, world: game.world.id,
    users: game.users.filter(u => u.active && !u.isGM).map(u => u.name),
    exported: false
  };
  const [page] = await entry.createEmbeddedDocuments("JournalEntryPage", [{
    name: session.name, type: "text", text: { content: renderHtml(session, []), format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML },
    flags: { [MOD]: { session, events: [] } }
  }]);
  pageId = page.id;
  await game.settings.set(MOD, "currentSession", page.id);
  record("session", `Session started: ${session.name}`);
  await flush();
  return sessionInfo(page);
}

export async function endSession() {
  const page = currentPage();
  if (!page) return null;
  record("session", "Session ended");
  await flush();
  const session = { ...(flagOf(page, "session") ?? {}), ended: Date.now(), users: [...new Set([...(flagOf(page, "session")?.users ?? []), ...game.users.filter(u => u.active && !u.isGM).map(u => u.name)])] };
  await page.update({ [`flags.${MOD}.session`]: session, "text.content": renderHtml(session, flagOf(page, "events") ?? []) });
  pageId = null;
  await game.settings.set(MOD, "currentSession", "");
  return exportSession(page.id);
}

export function note(text) {
  record("note", text);
  return true;
}

function sessionInfo(page) {
  const s = flagOf(page, "session") ?? {};
  return { ...s, pageId: page.id, uuid: page.uuid, events: (flagOf(page, "events") ?? []).length + (page.id === pageId ? buffer.length : 0) };
}

export function currentSession() {
  const page = currentPage();
  return page ? sessionInfo(page) : null;
}

export function listSessions() {
  const entry = game.journal.find(j => flagOf(j, "isLog"));
  return entry ? entry.pages.filter(p => flagOf(p, "session")).map(sessionInfo).sort((a, b) => b.started - a.started) : [];
}

function findPage(idOrName) {
  const entry = game.journal.find(j => flagOf(j, "isLog"));
  if (!entry) return null;
  if (!idOrName) return currentPage() ?? entry.pages.filter(p => flagOf(p, "session")).sort((a, b) => flagOf(b, "session").started - flagOf(a, "session").started)[0] ?? null;
  return entry.pages.get(idOrName) ?? entry.pages.find(p => flagOf(p, "session")?.id === idOrName || p.name === idOrName) ?? null;
}

/** Everything about one session, with a Markdown rendering ready for the vault. */
export function exportSession(idOrName) {
  const page = findPage(idOrName);
  if (!page) return null;
  const session = flagOf(page, "session") ?? {};
  const events = [...(flagOf(page, "events") ?? []), ...(page.id === pageId ? buffer : [])];
  return { ...session, pageId: page.id, uuid: page.uuid, events, markdown: toMarkdown(session, events), summary: summarize(events) };
}

export async function markExported(idOrName, exported = true) {
  const page = findPage(idOrName);
  if (!page) return false;
  await page.update({ [`flags.${MOD}.session.exported`]: exported });
  return true;
}

function summarize(events) {
  const by = kind => events.filter(e => e.kind === kind);
  return {
    events: events.length,
    chat: by("chat").length, rolls: by("roll").length, notes: by("note").map(e => e.text),
    combats: by("combat-start").length,
    itemsGained: by("item-add").map(e => e.text), itemsLost: by("item-remove").map(e => e.text),
    levelUps: by("level").map(e => e.text), xp: by("xp").map(e => e.text),
    scenes: [...new Set(by("scene").map(e => e.data?.name ?? e.text))],
    defeated: by("defeated").map(e => e.text)
  };
}

function toMarkdown(session, events) {
  const fmt = t => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const dur = session.ended ? Math.round((session.ended - session.started) / 60000) : null;
  const lines = [
    `# ${session.name}`, "",
    `- World: ${session.world}`,
    `- Started: ${new Date(session.started).toLocaleString()}`,
    session.ended ? `- Ended: ${new Date(session.ended).toLocaleString()} (${dur} min)` : "- Still running",
    `- Players present: ${(session.users ?? []).join(", ") || "—"}`,
    `- Events: ${events.length}`, ""
  ];
  const s = summarize(events);
  if (s.notes.length) lines.push("## GM notes", ...s.notes.map(n => `- ${n}`), "");
  if (s.scenes.length) lines.push("## Scenes", ...s.scenes.map(n => `- ${n}`), "");
  if (s.itemsGained.length || s.itemsLost.length) lines.push("## Loot & losses", ...s.itemsGained.map(n => `- + ${n}`), ...s.itemsLost.map(n => `- − ${n}`), "");
  if (s.levelUps.length || s.xp.length) lines.push("## XP & levels", ...[...s.xp, ...s.levelUps].map(n => `- ${n}`), "");
  if (s.defeated.length) lines.push("## Defeated", ...s.defeated.map(n => `- ${n}`), "");
  lines.push("## Timeline", ...events.map(e => `- ${fmt(e.t)} [${e.kind}] ${e.text}`), "");
  return lines.join("\n");
}

/* -------------------------------------------- */
/*  Hooks                                       */
/* -------------------------------------------- */

export function installRecorder() {
  Hooks.once("ready", async () => {
    if (!game.user.isGM) return;
    for (const a of game.actors) snapshotActor(a);
    lastScene = canvas?.scene?.id ?? null;
    const saved = game.settings.get(MOD, "currentSession");
    const entry = game.journal.find(j => flagOf(j, "isLog"));
    if (saved && entry?.pages.get(saved)) pageId = saved;
    else if (game.settings.get(MOD, "logEnabled") && game.settings.get(MOD, "autoStartSession")) await startSession();
    window.addEventListener("beforeunload", () => { flush(); });
  });

  Hooks.on("chatMessage", (log, message) => {
    if (!game.user.isGM || !pageId) return true;
    if (message.startsWith("!note ")) { note(message.slice(6).trim()); ui.notifications.info(game.i18n.localize("PSYNC.Notify.NoteSaved")); return false; }
    return true;
  });

  Hooks.on("createChatMessage", msg => {
    if (!enabled() || !pageId) return;
    const who = msg.alias ?? msg.speaker?.alias ?? msg.author?.name ?? "?";
    const whisper = msg.whisper?.length ? " (whisper)" : "";
    if (msg.isRoll && msg.rolls?.length) {
      const rolls = msg.rolls.map(r => `${r.formula} = ${r.total}`).join("; ");
      record("roll", `${who}${whisper}: ${stripHtml(msg.flavor) || "roll"} → ${rolls}`, { formula: msg.rolls.map(r => r.formula), total: msg.rolls.map(r => r.total) });
    } else {
      const text = stripHtml(msg.content);
      if (text) record("chat", `${who}${whisper}: ${text}`);
    }
  });

  Hooks.on("updateActor", (actor, changes) => {
    if (!enabled() || !pageId) return;
    const prev = actorCache.get(actor.id) ?? snapshotActor(actor);
    const flat = foundry.utils.flattenObject(changes);
    const now = snapshotActor(actor);
    const name = actorName(actor);
    if ((flat[WATCH.hp] !== undefined || flat[WATCH.temp] !== undefined) && (prev.hp !== now.hp || prev.temp !== now.temp)) {
      const max = foundry.utils.getProperty(actor, "system.attributes.hp.max");
      record("hp", `${name}: HP ${prev.hp ?? "?"} → ${now.hp ?? "?"}${max ? `/${max}` : ""}${now.temp ? ` (+${now.temp} temp)` : ""}`, { from: prev.hp, to: now.hp });
    }
    if (flat[WATCH.xp] !== undefined && prev.xp !== now.xp) record("xp", `${name}: XP ${prev.xp ?? 0} → ${now.xp}`);
    if (flat[WATCH.level] !== undefined && prev.level !== now.level) record("level", `${name}: level ${prev.level} → ${now.level}`);
    if (flat[WATCH.exhaustion] !== undefined && prev.exhaustion !== now.exhaustion) record("condition", `${name}: exhaustion ${prev.exhaustion ?? 0} → ${now.exhaustion}`);
    const coins = ["pp", "gp", "ep", "sp", "cp"].filter(c => flat[WATCH[c]] !== undefined && prev[c] !== now[c]);
    if (coins.length) record("currency", `${name}: ${coins.map(c => `${c} ${prev[c] ?? 0} → ${now[c]}`).join(", ")}`);
    if (changes.name && changes.name !== prev.name) record("actor", `Actor renamed: ${changes.name}`);
  });

  const itemOwner = item => item.parent instanceof Actor ? item.parent : null;
  Hooks.on("createItem", item => {
    if (!enabled() || !pageId) return;
    const owner = itemOwner(item);
    if (item.system?.quantity !== undefined) qtyCache.set(item.uuid, item.system.quantity);
    if (owner) record("item-add", `${actorName(owner)} gained ${item.name}${item.system?.quantity > 1 ? ` ×${item.system.quantity}` : ""}`, { actor: owner.name, item: item.name, type: item.type });
    else record("created", `Item created: ${item.name} (${item.type})`);
  });
  Hooks.on("deleteItem", item => {
    if (!enabled() || !pageId) return;
    const owner = itemOwner(item);
    qtyCache.delete(item.uuid);
    if (owner) record("item-remove", `${actorName(owner)} lost ${item.name}`, { actor: owner.name, item: item.name, type: item.type });
  });
  Hooks.on("updateItem", (item, changes) => {
    if (!enabled() || !pageId) return;
    const owner = itemOwner(item);
    const q = foundry.utils.getProperty(changes, "system.quantity");
    if (owner && q !== undefined) {
      const prev = qtyCache.get(item.uuid);
      qtyCache.set(item.uuid, q);
      if (prev !== undefined && prev !== q) record("item-qty", `${actorName(owner)}: ${item.name} ×${prev} → ×${q}`);
    }
    const eq = foundry.utils.getProperty(changes, "system.equipped");
    if (owner && eq !== undefined) record("equip", `${actorName(owner)} ${eq ? "equipped" : "unequipped"} ${item.name}`);
    const att = foundry.utils.getProperty(changes, "system.attunement");
    if (owner && att !== undefined) record("equip", `${actorName(owner)} attunement of ${item.name}: ${att || "none"}`);
  });

  Hooks.on("createActiveEffect", effect => {
    if (!enabled() || !pageId || !(effect.parent instanceof Actor)) return;
    record("effect-add", `${actorName(effect.parent)}: +${effect.name}`);
  });
  Hooks.on("deleteActiveEffect", effect => {
    if (!enabled() || !pageId || !(effect.parent instanceof Actor)) return;
    record("effect-remove", `${actorName(effect.parent)}: −${effect.name}`);
  });

  Hooks.on("combatStart", combat => {
    if (!enabled() || !pageId) return;
    record("combat-start", `Combat started (${combat.combatants.map(c => c.name).join(", ")})`, { scene: combat.scene?.name });
  });
  Hooks.on("combatRound", (combat, update) => {
    if (!enabled() || !pageId) return;
    record("round", `Round ${update.round ?? combat.round}`);
  });
  Hooks.on("deleteCombat", combat => {
    if (!enabled() || !pageId) return;
    record("combat-end", `Combat ended after ${combat.round ?? 0} round(s)`);
  });
  Hooks.on("updateCombatant", (combatant, changes) => {
    if (!enabled() || !pageId || changes.defeated === undefined) return;
    if (changes.defeated) record("defeated", `${combatant.name} defeated`);
  });

  Hooks.on("canvasReady", cv => {
    if (!enabled() || !pageId) return;
    const scene = cv?.scene;
    if (!scene || scene.id === lastScene) return;
    lastScene = scene.id;
    record("scene", `Scene: ${scene.name}`, { name: scene.name, id: scene.id });
  });

  Hooks.on("updateWorldTime", (worldTime, delta) => {
    if (!enabled() || !pageId || Math.abs(delta) < 60) return;
    const h = Math.round(delta / 360) / 10;
    record("time", `World time ${delta > 0 ? "advanced" : "rewound"} ${Math.abs(h)} h`, { delta });
  });

  const journalEdit = (entryName, pageName) => {
    const key = `${entryName}/${pageName ?? ""}`;
    const last = journalDebounce.get(key) ?? 0;
    if (Date.now() - last < 60000) return;
    journalDebounce.set(key, Date.now());
    record("journal", `Journal edited: ${entryName}${pageName ? ` / ${pageName}` : ""}`);
  };
  Hooks.on("updateJournalEntryPage", (page, changes) => {
    if (!enabled() || !pageId || flagOf(page.parent, "isLog")) return;
    if (changes.text || changes.name) journalEdit(page.parent?.name ?? "?", page.name);
  });
  Hooks.on("createJournalEntry", entry => {
    if (!enabled() || !pageId || flagOf(entry, "isLog")) return;
    record("created", `Journal created: ${entry.name}`);
  });
  Hooks.on("createScene", scene => { if (enabled() && pageId) record("created", `Scene created: ${scene.name}`); });
  Hooks.on("createActor", actor => { if (enabled() && pageId) { snapshotActor(actor); record("created", `Actor created: ${actor.name} (${actor.type})`); } });
  Hooks.on("deleteActor", actor => { if (enabled() && pageId) record("deleted", `Actor deleted: ${actor.name}`); });
}

export const session = { start: startSession, end: endSession, note, current: currentSession, list: listSessions, export: exportSession, markExported, flush };
