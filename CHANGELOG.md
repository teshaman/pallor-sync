# pallor-sync — Changelog

All notable changes to this module. Newest version first.
Older packaged zips are kept in `backups/` and are never deleted.

## 1.0.0 — 2026-09-16
- Initial release: compendium sync between two worlds through a shared compendium (Forge shared compendiums or any unlocked pack) with three-way change detection (push, pull, conflict, link, available), Share/Stop sharing context menus, Shared folders setting, GM window, startup scan and optional auto-apply.
- Session recorder: chat, rolls, HP/XP/level/coins, loot, conditions, combat, scene and time changes into the Pallor Session Log journal; !note chat command; End session copies Markdown for the vault.
- Script API game.modules.get('pallor-sync').api: scan, apply, sync, share, unshare, ignore, session.start/end/note/export.
