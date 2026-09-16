# pallor-sync — Changelog

All notable changes to this module. Newest version first.
Older packaged zips are kept in `backups/` and are never deleted.

## 1.0.3 — 2026-09-16
- Session recorder ignores documents written to compendiums, so pushing shared items or scenes no longer logs them as 'Item created' / 'Scene created' table events.
- Content hashes are canonicalised before comparing: self-closing HTML tags equal plain tags, and empty strings, empty lists and 'none' fields are ignored, so a first link between two worlds no longer reports formatting-only conflicts.

## 1.0.2 — 2026-09-16
- Fix: a linked pair whose stored hashes differ only because the compendium copy is re-formatted on write (for example <br /> to <br>, empty activity fields to 'none') is now reported as in sync instead of a conflict; three-way check order corrected.
- Scan links a shared document arriving from the other world to a same-name local copy that was never shared (link if identical, conflict otherwise) instead of pulling it in as a duplicate.

## 1.0.1 — 2026-09-16
- api.migratePack(fromPack, toPack, {deleteSource}) copies a whole compendium pack into another of the same type, keeping ids and folder paths, and re-points world documents linked to the old pack; used to replace a Forge shared compendium (their pack list cannot be edited after creation).
- Automatic pack detection now prefers the active Forge shared compendium that has the most packs, so an old single-pack shared module never wins over the new full one.

## 1.0.0 — 2026-09-16
- Initial release: compendium sync between two worlds through a shared compendium (Forge shared compendiums or any unlocked pack) with three-way change detection (push, pull, conflict, link, available), Share/Stop sharing context menus, Shared folders setting, GM window, startup scan and optional auto-apply.
- Session recorder: chat, rolls, HP/XP/level/coins, loot, conditions, combat, scene and time changes into the Pallor Session Log journal; !note chat command; End session copies Markdown for the vault.
- Script API game.modules.get('pallor-sync').api: scan, apply, sync, share, unshare, ignore, session.start/end/note/export.
