# pallor-sync — Changelog

All notable changes to this module. Newest version first.
Older packaged zips are kept in `backups/` and are never deleted.

## 1.0.1 — 2026-09-16
- api.migratePack(fromPack, toPack, {deleteSource}) copies a whole compendium pack into another of the same type, keeping ids and folder paths, and re-points world documents linked to the old pack; used to replace a Forge shared compendium (their pack list cannot be edited after creation).
- Automatic pack detection now prefers the active Forge shared compendium that has the most packs, so an old single-pack shared module never wins over the new full one.

## 1.0.0 — 2026-09-16
- Initial release: compendium sync between two worlds through a shared compendium (Forge shared compendiums or any unlocked pack) with three-way change detection (push, pull, conflict, link, available), Share/Stop sharing context menus, Shared folders setting, GM window, startup scan and optional auto-apply.
- Session recorder: chat, rolls, HP/XP/level/coins, loot, conditions, combat, scene and time changes into the Pallor Session Log journal; !note chat command; End session copies Markdown for the vault.
- Script API game.modules.get('pallor-sync').api: scan, apply, sync, share, unshare, ignore, session.start/end/note/export.
