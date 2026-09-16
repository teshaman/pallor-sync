import { MOD, TYPES, scan, apply, autoEntries, syncAll, share, unshare, ignore, packMap, sharedModules, migratePack, isShared, hashOf } from "./sync.mjs";
import { session, installRecorder } from "./session-log.mjs";
import { SyncApp, PackConfigApp, SharePickerApp } from "./apps.mjs";

const DIRECTORY_CLASSES = {
  Item: "ItemDirectory", Actor: "ActorDirectory", JournalEntry: "JournalDirectory", Scene: "SceneDirectory",
  RollTable: "RollTableDirectory", Macro: "MacroDirectory", Playlist: "PlaylistDirectory"
};

Hooks.once("init", () => {
  const reg = (key, data) => game.settings.register(MOD, key, { scope: "world", ...data });
  reg("packs", { config: false, type: Object, default: {} });
  reg("ignored", { config: false, type: Array, default: [] });
  reg("currentSession", { config: false, type: String, default: "" });
  reg("sharedFolders", { name: "PSYNC.Settings.SharedFolders.Name", hint: "PSYNC.Settings.SharedFolders.Hint", config: true, type: String, default: "Shared" });
  reg("scanOnReady", { name: "PSYNC.Settings.ScanOnReady.Name", hint: "PSYNC.Settings.ScanOnReady.Hint", config: true, type: Boolean, default: true });
  reg("openOnChanges", { name: "PSYNC.Settings.OpenOnChanges.Name", hint: "PSYNC.Settings.OpenOnChanges.Hint", config: true, type: Boolean, default: true });
  reg("autoApply", { name: "PSYNC.Settings.AutoApply.Name", hint: "PSYNC.Settings.AutoApply.Hint", config: true, type: Boolean, default: false });
  reg("logEnabled", { name: "PSYNC.Settings.LogEnabled.Name", hint: "PSYNC.Settings.LogEnabled.Hint", config: true, type: Boolean, default: true });
  reg("autoStartSession", { name: "PSYNC.Settings.AutoStart.Name", hint: "PSYNC.Settings.AutoStart.Hint", config: true, type: Boolean, default: true });

  game.settings.registerMenu(MOD, "packsMenu", { name: "PSYNC.Packs.Title", label: "PSYNC.Packs.Open", hint: "PSYNC.Packs.Hint", icon: "fa-solid fa-book-atlas", type: PackConfigApp, restricted: true });
  game.settings.registerMenu(MOD, "syncMenu", { name: "PSYNC.Title", label: "PSYNC.Open", hint: "PSYNC.Settings.Menu.Hint", icon: "fa-solid fa-arrows-rotate", type: SyncApp, restricted: true });

  const resolve = async target => {
    if (typeof target === "string") return fromUuid(target);
    if (target?.documentName) return target;
    if (target?.type && target?.name) return game.collections.get(target.type)?.getName(target.name) ?? null;
    return null;
  };

  game.modules.get(MOD).api = {
    TYPES,
    /** Compare shared world documents with the shared packs. Returns {entries, counts, problems}. */
    scan,
    /** Apply scan entries; choices = { [sid]: "world" | "shared" } for conflicts. */
    apply,
    /** Entries safe to apply without a decision (push, pull, link). */
    autoEntries,
    /** Scan and apply everything except conflicts. Returns {done, errors, conflicts, available, problems, counts}. */
    sync: syncAll,
    /** Mark a document (document, uuid, or {type, name}) as shared. */
    share: async target => { const d = await resolve(target); return d ? share(d) : false; },
    /** Stop sharing; {deleteShared: true} also removes the shared copy. */
    unshare: async (target, options) => { const d = await resolve(target); return d ? unshare(d, options) : false; },
    ignore,
    isShared,
    hash: hashOf,
    packs: packMap,
    sharedModules,
    /** Copy a whole pack into another of the same type (ids and folders kept); {deleteSource: true} empties the old one afterwards. */
    migratePack,
    open: (plan) => SyncApp.open(plan),
    openPicker: type => SharePickerApp.open(type),
    /** Session recorder: start(name?), end(), note(text), current(), list(), export(idOrName?), markExported(id), flush(). */
    session
  };
});

installRecorder();

/* Settings sidebar button (GM only). */
Hooks.on("renderSettings", (app, html) => {
  if (!game.user?.isGM) return;
  const root = html instanceof HTMLElement ? html : html[0];
  if (!root || root.querySelector(".ps-launch")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ps-launch";
  button.innerHTML = `<i class="fa-solid fa-arrows-rotate"></i> ${game.i18n.localize("PSYNC.Title")}`;
  button.addEventListener("click", () => SyncApp.open());
  (root.querySelector("section") ?? root).appendChild(button);
});

/* Directory context menus: share / stop sharing a document, share a folder. */
function element(li) { return li instanceof HTMLElement ? li : li?.[0]; }

function entryOptions(collection) {
  const docOf = li => { const el = element(li); return collection.get(el?.dataset.entryId ?? el?.dataset.documentId); };
  return [
    {
      name: "PSYNC.Context.Share", icon: '<i class="fa-solid fa-share-nodes"></i>',
      condition: li => game.user.isGM && !!docOf(li) && !isShared(docOf(li)),
      callback: async li => { await share(docOf(li)); ui.notifications.info(game.i18n.format("PSYNC.Notify.Shared", { n: 1 })); SyncApp.instance?.rescan(); }
    },
    {
      name: "PSYNC.Context.Unshare", icon: '<i class="fa-solid fa-link-slash"></i>',
      condition: li => game.user.isGM && !!docOf(li) && isShared(docOf(li)) && !!docOf(li).flags?.[MOD],
      callback: async li => {
        const doc = docOf(li);
        const deleteShared = doc.getFlag(MOD, "id") ? await foundry.applications.api.DialogV2.confirm({
          window: { title: game.i18n.localize("PSYNC.Context.Unshare") },
          content: `<p>${game.i18n.format("PSYNC.Context.UnshareConfirm", { name: doc.name })}</p>`
        }) : false;
        await unshare(doc, { deleteShared });
        SyncApp.instance?.rescan();
      }
    }
  ];
}

function folderOptions() {
  const folderOf = li => { const el = element(li); return game.folders.get(el?.closest?.(".folder")?.dataset.folderId ?? el?.dataset.folderId); };
  const docsIn = folder => [...folder.contents, ...folder.getSubfolders(true).flatMap(f => f.contents)];
  return [{
    name: "PSYNC.Context.ShareFolder", icon: '<i class="fa-solid fa-share-nodes"></i>',
    condition: li => game.user.isGM && !!folderOf(li) && TYPES.includes(folderOf(li).type),
    callback: async li => {
      let n = 0;
      for (const doc of docsIn(folderOf(li))) if (await share(doc)) n++;
      ui.notifications.info(game.i18n.format("PSYNC.Notify.Shared", { n }));
      SyncApp.instance?.rescan();
    }
  }];
}

function addOptions(options, extra) {
  if (!Array.isArray(options) || options.some(o => o.name === extra[0].name)) return;
  options.push(...extra);
}

for (const [type, cls] of Object.entries(DIRECTORY_CLASSES)) {
  const collection = () => game.collections.get(type);
  // Foundry v14 naming
  Hooks.on(`get${type}ContextOptions`, (app, options) => addOptions(options, entryOptions(collection())));
  // Foundry v13 naming
  Hooks.on(`get${cls}EntryContext`, (app, options) => addOptions(options, entryOptions(collection())));
  Hooks.on(`get${cls}FolderContext`, (app, options) => addOptions(options, folderOptions()));
}
Hooks.on("getFolderContextOptions", (app, options) => addOptions(options, folderOptions()));

/* Startup scan. */
Hooks.once("ready", () => {
  if (!game.user.isGM || !game.settings.get(MOD, "scanOnReady")) return;
  setTimeout(async () => {
    try {
      let plan = await scan();
      if (plan.problems.length) console.warn(`${MOD} |`, plan.problems);
      if (game.settings.get(MOD, "autoApply")) {
        const auto = autoEntries(plan);
        if (auto.length) {
          const r = await apply(auto);
          ui.notifications.info(game.i18n.format("PSYNC.Notify.Applied", { n: r.done.length, e: r.errors.length }));
          plan = await scan();
        }
      }
      const pending = (plan.counts.push ?? 0) + (plan.counts.pull ?? 0) + (plan.counts.conflict ?? 0) + (plan.counts.link ?? 0);
      if (pending || plan.problems.length) {
        ui.notifications.info(game.i18n.format("PSYNC.Notify.Pending", { n: pending, c: plan.counts.conflict ?? 0 }));
        if (game.settings.get(MOD, "openOnChanges")) SyncApp.open(plan);
      } else console.log(`${MOD} | shared content in sync (${plan.counts.same ?? 0} documents)`);
    } catch (err) { console.error(`${MOD} | startup scan failed`, err); }
  }, 2500);
});
