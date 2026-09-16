import { MOD, TYPES, scan, apply, autoEntries, share, ignore, packMap, isShared } from "./sync.mjs";
import { session } from "./session-log.mjs";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;
const ACTION_ORDER = ["conflict", "push", "pull", "link", "available", "ignored"];
const CHECKED = new Set(["conflict", "push", "pull", "link"]);

function t(key, data) { return data ? game.i18n.format(key, data) : game.i18n.localize(key); }

async function copyText(text) {
  try {
    if (game.clipboard?.copyPlainText) return game.clipboard.copyPlainText(text);
    await navigator.clipboard.writeText(text);
  } catch (err) { console.warn(`${MOD} | clipboard unavailable`, err); }
}

/* -------------------------------------------- */
/*  Sync window                                 */
/* -------------------------------------------- */

export class SyncApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static #instance = null;
  #plan = null;
  #busy = false;
  #result = null;

  static DEFAULT_OPTIONS = {
    id: "pallor-sync",
    classes: ["pallor-sync"],
    window: { title: "PSYNC.Title", icon: "fa-solid fa-arrows-rotate", resizable: true },
    position: { width: 820, height: 640 },
    actions: {
      rescan: SyncApp.#onRescan,
      apply: SyncApp.#onApply,
      auto: SyncApp.#onAuto,
      selectAll: SyncApp.#onSelect,
      selectNone: SyncApp.#onSelect,
      share: () => SharePickerApp.open(),
      packs: () => PackConfigApp.open(),
      ignore: SyncApp.#onIgnore,
      unignore: SyncApp.#onIgnore,
      openDoc: SyncApp.#onOpenDoc,
      sessionStart: SyncApp.#onSessionStart,
      sessionEnd: SyncApp.#onSessionEnd,
      sessionNote: SyncApp.#onSessionNote,
      sessionCopy: SyncApp.#onSessionCopy,
      sessionOpen: SyncApp.#onSessionOpen
    }
  };

  static PARTS = { main: { template: `modules/${MOD}/templates/sync.hbs`, scrollable: [".ps-body"] } };

  static open(plan = null) {
    if (!game.user.isGM) return ui.notifications.warn(t("PSYNC.Notify.GMOnly"));
    SyncApp.#instance ??= new SyncApp();
    if (plan) SyncApp.#instance.#plan = plan;
    SyncApp.#instance.render({ force: true });
    if (!plan && !SyncApp.#instance.#plan) SyncApp.#instance.rescan();
    return SyncApp.#instance;
  }

  static get instance() { return SyncApp.#instance; }

  async rescan() {
    if (this.#busy) return;
    this.#busy = true; this.render();
    try { this.#plan = await scan(); }
    catch (err) { ui.notifications.error(`${MOD}: ${err.message}`); console.error(err); }
    this.#busy = false; this.render();
  }

  #selected() {
    const checked = new Set([...this.element.querySelectorAll("input[data-sid]:checked")].map(i => i.dataset.sid));
    const choices = {};
    for (const r of this.element.querySelectorAll("input[type=radio]:checked")) choices[r.name.replace(/^choice-/, "")] = r.value;
    return { entries: (this.#plan?.entries ?? []).filter(e => checked.has(e.sid)), choices };
  }

  async #run(entries, choices = {}) {
    if (!entries.length) return ui.notifications.info(t("PSYNC.Notify.Nothing"));
    this.#busy = true; this.render();
    try {
      this.#result = await apply(entries, choices);
      ui.notifications.info(t("PSYNC.Notify.Applied", { n: this.#result.done.length, e: this.#result.errors.length }));
    } catch (err) { ui.notifications.error(`${MOD}: ${err.message}`); console.error(err); }
    this.#busy = false;
    await this.rescan();
  }

  static #onRescan() { this.rescan(); }
  static #onApply() { const { entries, choices } = this.#selected(); this.#run(entries, choices); }
  static #onAuto() { if (this.#plan) this.#run(autoEntries(this.#plan)); }
  static #onSelect(event, target) {
    const on = target.dataset.action === "selectAll";
    for (const i of this.element.querySelectorAll("input[data-sid]")) i.checked = on;
  }
  static async #onIgnore(event, target) {
    await ignore(target.dataset.sid, target.dataset.action === "ignore");
    this.rescan();
  }
  static async #onOpenDoc(event, target) {
    const doc = await fromUuid(target.dataset.uuid);
    doc?.sheet?.render(true);
  }
  static async #onSessionStart() {
    const name = await DialogV2.prompt({
      window: { title: t("PSYNC.Session.Start") },
      content: `<input type="text" name="name" placeholder="${t("PSYNC.Session.NamePlaceholder")}" autofocus>`,
      ok: { label: t("PSYNC.Session.Start"), callback: (ev, button) => button.form.elements.name.value }
    }).catch(() => null);
    if (name === null) return;
    await session.start(name);
    this.render();
  }
  static async #onSessionEnd() {
    const ok = await DialogV2.confirm({ window: { title: t("PSYNC.Session.End") }, content: `<p>${t("PSYNC.Session.EndConfirm")}</p>` });
    if (!ok) return;
    const data = await session.end();
    if (data) { await copyText(data.markdown); ui.notifications.info(t("PSYNC.Notify.SessionEnded", { n: data.events.length })); }
    this.render();
  }
  static async #onSessionNote() {
    const text = await DialogV2.prompt({
      window: { title: t("PSYNC.Session.Note") },
      content: `<textarea name="text" rows="4" autofocus></textarea>`,
      ok: { label: t("PSYNC.Session.NoteSave"), callback: (ev, button) => button.form.elements.text.value }
    }).catch(() => null);
    if (text) { session.note(text); ui.notifications.info(t("PSYNC.Notify.NoteSaved")); this.render(); }
  }
  static async #onSessionCopy() {
    const data = session.export();
    if (!data) return ui.notifications.warn(t("PSYNC.Session.None"));
    await copyText(data.markdown);
    ui.notifications.info(t("PSYNC.Notify.Copied"));
  }
  static #onSessionOpen() {
    const entry = game.journal.find(j => j.getFlag(MOD, "isLog"));
    entry ? entry.sheet.render(true) : ui.notifications.warn(t("PSYNC.Session.None"));
  }

  async _prepareContext() {
    const plan = this.#plan;
    const groups = [];
    if (plan) {
      for (const action of ACTION_ORDER) {
        const entries = plan.entries.filter(e => e.action === action).map(e => ({
          ...e,
          typeLabel: t(`DOCUMENT.${e.type}`),
          reasonLabel: t(`PSYNC.Reason.${e.reason}`),
          checked: CHECKED.has(action),
          isConflict: action === "conflict",
          isAvailable: action === "available",
          isIgnored: action === "ignored",
          canIgnore: action === "pull" || action === "available",
          openUuid: e.worldUuid ?? e.packUuid,
          warningText: e.warnings?.length ? t("PSYNC.Warn.LocalAssets", { paths: e.warnings.join(", ") }) : ""
        }));
        if (entries.length) groups.push({ action, label: t(`PSYNC.Action.${action}`), hint: t(`PSYNC.ActionHint.${action}`), entries, count: entries.length });
      }
    }
    const packs = packMap();
    const current = session.current();
    return {
      busy: this.#busy,
      hasPlan: !!plan,
      groups,
      pending: groups.filter(g => CHECKED.has(g.action)).reduce((n, g) => n + g.count, 0),
      sameCount: plan?.counts?.same ?? 0,
      problems: plan?.problems ?? [],
      result: this.#result,
      packs: TYPES.map(type => ({ type, label: t(`DOCUMENT.${type}`), pack: packs[type] ? game.packs.get(packs[type])?.metadata.label ?? packs[type] : t("PSYNC.Packs.None") })),
      session: current ? { ...current, startedLabel: new Date(current.started).toLocaleString() } : null,
      sessionCount: session.list().length,
      logEnabled: game.settings.get(MOD, "logEnabled"),
      world: game.world.title
    };
  }
}

/* -------------------------------------------- */
/*  Pack mapping settings menu                  */
/* -------------------------------------------- */

export class PackConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "pallor-sync-packs",
    classes: ["pallor-sync"],
    tag: "form",
    window: { title: "PSYNC.Packs.Title", icon: "fa-solid fa-book-atlas" },
    position: { width: 560 },
    form: { handler: PackConfigApp.#onSubmit, closeOnSubmit: true }
  };

  static PARTS = { main: { template: `modules/${MOD}/templates/packs.hbs` } };

  static open() { new PackConfigApp().render({ force: true }); }

  async _prepareContext() {
    const saved = game.settings.get(MOD, "packs") ?? {};
    const current = packMap();
    return {
      rows: TYPES.map(type => ({
        type, label: t(`DOCUMENT.${type}`),
        auto: saved[type] === undefined,
        options: game.packs.filter(p => p.metadata.type === type && !p.locked && p.metadata.packageType !== "system").map(p => ({
          id: p.collection, label: `${p.metadata.label} (${p.metadata.packageName})`, selected: saved[type] === p.collection
        })),
        autoLabel: saved[type] === undefined && current[type] ? game.packs.get(current[type])?.metadata.label : null,
        none: saved[type] === ""
      }))
    };
  }

  static async #onSubmit(event, form, formData) {
    const data = formData.object;
    const out = {};
    for (const type of TYPES) {
      const v = data[type];
      if (v === "auto") continue;
      out[type] = v === "none" ? "" : v;
    }
    await game.settings.set(MOD, "packs", out);
    ui.notifications.info(t("PSYNC.Packs.Saved"));
    SyncApp.instance?.rescan();
  }
}

/* -------------------------------------------- */
/*  Share picker                                */
/* -------------------------------------------- */

export class SharePickerApp extends HandlebarsApplicationMixin(ApplicationV2) {
  #type = "Item";
  #filter = "";

  static DEFAULT_OPTIONS = {
    id: "pallor-sync-picker",
    classes: ["pallor-sync"],
    window: { title: "PSYNC.Picker.Title", icon: "fa-solid fa-share-nodes", resizable: true },
    position: { width: 520, height: 560 },
    actions: { shareSelected: SharePickerApp.#onShare, all: SharePickerApp.#onAll, none: SharePickerApp.#onAll }
  };

  static PARTS = { main: { template: `modules/${MOD}/templates/picker.hbs`, scrollable: [".ps-list"] } };

  static open(type) { const app = new SharePickerApp(); if (type) app.#type = type; app.render({ force: true }); }

  async _prepareContext() {
    const q = this.#filter.toLowerCase();
    const docs = game.collections.get(this.#type).filter(d => !isShared(d) && (!q || d.name.toLowerCase().includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(d => ({ uuid: d.uuid, name: d.name, sub: d.type && d.type !== "base" ? d.type : "", folder: (() => { const n = []; for (let f = d.folder; f; f = f.folder) n.unshift(f.name); return n.join(" / "); })() }));
    return { types: TYPES.map(type => ({ type, label: t(`DOCUMENT.${type}`), selected: type === this.#type })), docs, filter: this.#filter };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    this.element.querySelector("select[data-type]")?.addEventListener("change", ev => { this.#type = ev.currentTarget.value; this.render(); });
    this.element.querySelector("input[data-filter]")?.addEventListener("input", ev => {
      this.#filter = ev.currentTarget.value;
      const q = this.#filter.toLowerCase();
      for (const row of this.element.querySelectorAll(".ps-row")) row.hidden = !!q && !row.dataset.name.includes(q);
    });
  }

  static #onAll(event, target) {
    const on = target.dataset.action === "all";
    for (const i of this.element.querySelectorAll(".ps-row:not([hidden]) input[type=checkbox]")) i.checked = on;
  }

  static async #onShare() {
    const uuids = [...this.element.querySelectorAll("input[data-uuid]:checked")].map(i => i.dataset.uuid);
    let n = 0;
    for (const uuid of uuids) { const doc = await fromUuid(uuid); if (doc && await share(doc)) n++; }
    ui.notifications.info(t("PSYNC.Notify.Shared", { n }));
    this.render();
    SyncApp.instance?.rescan();
  }
}
