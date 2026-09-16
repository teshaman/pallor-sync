# Pallor Sync

Keeps two Foundry worlds (Party Opnion and Party Missi in the Pillars of Palor campaign) in step through one shared compendium, and records what happens at the table so the session can be filed afterwards.

## Part 1 — compendium sync

**Storage** is any unlocked compendium both worlds can see. On The Forge that is a *Shared Compendiums* module (Forge site → Game Configuration → Shared Compendiums): create one pack per document type you want to share (Item, Actor, JournalEntry, Scene, RollTable, Macro, Playlist). A Forge shared compendium cannot be edited after creation, so create it with every pack type you want from the start. The module picks the packs of the active Forge shared compendium that has the most packs; *Configure Settings → Pallor Sync → Choose packs* overrides that per type.

**What is shared**

- By default **everything** (setting *Share everything*, on): every item, actor, journal, scene, roll table, macro and playlist, except player characters (setting *Also share player characters*), journals a player has ownership of (personal notes, PC journals, skill trees), the module's own session log, documents inside a folder named in *Private folders* (default `Private, Party, Personal`), and documents you chose *Stop sharing* on.
- With *Share everything* off: any document you mark with the sidebar context menu *Share with the other world* (or *Share folder contents* on a folder), or through the *Share…* button in the Pallor Sync window.
- Everything inside a folder named in the *Shared folders* setting (default `Shared`), including subfolders. Drop a quest journal, a world map scene or an item into `Shared` and it travels.

**How the sync works**

Every shared document carries a `pallor-sync` flag with the sync id (the compendium document's id), the content hash of the world copy and the content hash of the shared copy at the moment they were last in step. A scan compares both hashes with the current content:

| this world | shared copy | result |
|---|---|---|
| unchanged | unchanged | in sync |
| changed | unchanged | **push** to shared |
| unchanged | changed | **pull** from shared |
| changed | changed | **conflict** — you pick which one wins |
| not linked yet, same name in shared | | **link** (identical) or conflict (different) |
| missing here, present in shared | | **pull** (shared through the module) or *available* (never linked; opt in or ignore) |

Folder paths are recorded and rebuilt on the other side. Ownership and sort order stay local. Image and sound paths must live in the Forge assets library (`https://assets.forge-vtt.com/...`); a document that points into `worlds/<id>/...` is flagged with a warning because the other world cannot see that file.

**Window** (Settings sidebar button *Pallor Sync* or the settings menu): grouped list of conflicts, pushes, pulls, links and available documents with checkboxes; *Sync safe changes* applies everything except conflicts; *Apply selected* honours your ticks and conflict choices; the eye icon ignores a shared document in this world.

**Startup**: a few seconds after the GM logs in the module scans and, if anything is waiting, shows a notification and opens the window (settings *Scan when the world starts*, *Open the window when something changed*, *Apply safe changes automatically at startup*).

## Part 2 — session recorder

The active GM client records into the journal **Pallor Session Log**, one text page per session (readable in Foundry, structured data in the page flags):

chat messages and rolls (speaker, flavour, formula, total) · HP, temp HP, XP, level, exhaustion and coin changes on actors · items gained, lost, quantity changes, equip and attunement · conditions and effects added or removed · combat start, rounds, defeats, combat end · scene switches · world-time advances · journal edits and new journals, scenes, actors · GM notes (`!note text` in chat, the *Add note* button, or `api.session.note()`).

A session starts automatically when the GM logs in and none is running (setting *Start a session automatically*) or from the window. *End session* closes it, copies a Markdown summary to the clipboard and keeps the page for the assistant to file in the vault.

## Script API (`game.modules.get("pallor-sync").api`)

```js
const api = game.modules.get("pallor-sync").api;
await api.scan();                       // {entries, counts, problems}
await api.sync();                       // apply every one-sided change; returns {done, errors, conflicts, available}
await api.apply(entries, {sid: "shared"}); // apply chosen entries; choices per conflict
await api.share("Item.abc123");         // or a document, or {type: "JournalEntry", name: "Quest: The Tablet"}
await api.unshare(doc, {deleteShared: true});
await api.ignore(sid);
await api.migratePack("forge-vtt-shared-compendiums-old.items", "forge-vtt-shared-compendiums-new.items", {deleteSource: false}); // move a pack, ids + folders kept
api.session.current();                  // running session or null
await api.session.start("Session 12");
api.session.note("Party accepted the baron's offer");
await api.session.end();                // {name, started, ended, users, events[], markdown, summary}
api.session.export();                   // last (or running) session, same shape
api.session.list();
await api.session.markExported(pageId);
```

Claude Code and Codex reach this through the Claude Bridge module's `run_script`.

## Install

Paste this manifest URL into Foundry's **Install Module** dialog or the Forge setup page:

`https://github.com/teshaman/pallor-sync/releases/latest/download/module.json`

Enable the module in **both** worlds; the settings are per world.

## Not covered

Player user accounts, world settings, module settings and chat history are not synced. Active Effects on actors travel with the actor. Documents that link to other world documents by UUID keep working in the other world only if the target is shared as well (ids are kept identical on both sides where possible).
