# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

慧礼记 — a native WeChat Mini Program + WeChat Cloud Development (云开发) app: a gift-money ledger (礼金簿) for events, with guest scan-to-pay registration, cash/desk entry, owner/clerk/family collaboration, 人情往来 tracking, PDF/Excel export, and BLE ESC/POS thermal receipt printing. The app only *records* gifts; actual money moves via the owner's personal WeChat pay code (no merchant payments).

`docs/技术开发文档.md` is the authoritative design doc and changelog: §3–§5 describe the original architecture/data model/API protocol, and every release appends a numbered section at the end (read the last few to learn current state). User-facing text, comments and docs are in Chinese; commit messages are in English. `README.md` only describes the early version (7 functions, basic features) — trust the doc's latest sections over it.

## Layout

- `miniprogram/` — front end (`miniprogramRoot`). Custom tab bar in `custom-tab-bar/`. `config.js` holds `VERSION` and subscription template IDs.
- `cloudfunctions/` — one directory per cloud function (`cloudfunctionRoot`), each with its own `package.json` (`wx-server-sdk`).
- `tools/cloud-shared/` — **source of truth** for modules shared across cloud functions (e.g. `ctx.js` permissions, `common.js` `ok`/`err`/`bjDay`, `status.js` record states — also copied to `miniprogram/utils/`, `secure.js` content-security checks that fail open, `collections.js` collection list). See "Shared modules" below.
- `tools/*.py` — generators: `gen_gbk.py` → `miniprogram/utils/gbk-table.js`; `gen_border_tiles.py` → `miniprogram/utils/bordertiles-data.js` (receipt border bitmaps, needs Pillow); `gen_icons.py` → `miniprogram/assets/icons/{name}-{variant}.svg` (one file per color, since `<image>` can't recolor SVG). Don't hand-edit generated outputs.
- **PDF fonts live in cloud storage, not in the code package.** `export/fonts.js` downloads them from `export-fonts/` to `/tmp` on first use, using the fileID/sha256 registered in `settings.export_fonts`. To (re)upload: `python tools/gen_font_js.py` → `cloudfunctions/fontsetup/font-*.js` (gitignored) → deploy `fontsetup` → admin page 「上线前检查」→「上传导出字体」. Source .ttf subsets are in `tools/fonts/`.

## Commands

There is no npm build, linter, or test suite. Development goes through the WeChat DevTools CLI (`cli.bat`, at `"/c/Program Files (x86)/Tencent/微信web开发者工具/cli.bat"`). Cloud env: `lingyuan-env-7gf6tlqf2a9ece4a`. Use this repo's path as `--project`.

```bash
# After editing anything in tools/cloud-shared/ (copies into every function that uses it)
python tools/sync_shared.py
# Verify copies match the source (exit 1 on mismatch) — run before commit/upload
python tools/sync_shared.py --check

# Deploy only the cloud functions you changed (space-separated names)
cli.bat cloud functions deploy --e lingyuan-env-7gf6tlqf2a9ece4a --n records payment --r --project '<repo path>'

# Compile check — must print "✔ preview" to count as passing
cli.bat preview --project '<repo path>' --qr-format base64 --qr-output "$TEMP/cc/qr.txt"

# Upload a release — ONLY when the user explicitly says 「上传」. Description must contain no spaces (cli.bat breaks on 'C:\Program').
cli.bat upload --project '<repo path>' -v X.Y.Z -d "描述"
```

## Architecture

**All data access goes through cloud functions.** Every DB collection's permission is "所有用户不可读写"; the front end never queries the database directly. Cloud functions are deliberately written so that server-written docs have no `_openid` field — any doc with `_openid` is treated as client-forged and ignored (`srv = { _openid: db.command.exists(false) }` filter in `ctx.js`).

**Request protocol.** Each function is `exports.main = async event => switch (event.action) …` returning `{ code: 0, msg, data }`; `code≠0` is a business error. Front end calls exclusively through `miniprogram/utils/request.js`, which resolves `data`, toasts `msg` on error (unless `{silent:true}`), and also invalidates front-end caches (`utils/cache.js` keys like `books`/`dashboard`/`mine`) after mutations — when adding a mutating API, add matching cache invalidation there.

**Warm-up.** Every function's `main` first short-circuits `event.action === '__warm'` / `event.Type === 'Timer'`; the `warmer` function pings them on a timer (configurable via system settings in `plans.js`) and also runs scheduled jobs (`remind.js` subscription pushes, `trash.js` purge). Keep that early return when editing a `main`.

**Identity / permission model (`tools/cloud-shared/ctx.js`).** Data always belongs to the owner (`ownerOpenid`, 主家). `resolveCtx(db, OPENID)` returns `role: 'owner' | 'clerk' | 'none'`, the owner's account, and membership info. Clerks (记账人) join via `members` with `bookIds`/`allBooks` and granular `perms` (see `PERMS`); family viewers (`role='viewer'`) are read-only on shared books. Every action must gate with `canBook(ctx, bookId)`, `can(ctx, perm)`, `readonly(ctx)`, and `workBook` (the book a clerk is currently recording; differs between normal and 机构/org mode). Some operations (transfer, org mode, purge, approving joins, confirming pay code) are owner-only and not grantable. Always operate on `ctx.ownerOpenid`, never the caller's openid, for ledger data — except 人情往来 and data purge, which are per-person.

**Shared modules are copied, not required.** Cloud functions can't require each other, so `sync_shared.py` copies `tools/cloud-shared/*.js` into each target function (mapping in the script). Never edit the copies under `cloudfunctions/<fn>/`; edit the source, run the sync, then deploy every function that received the file. Which module goes to which function is the `TARGETS` map in `sync_shared.py` — update it when adding a shared module or a new consumer (e.g. `renqing` gets no `ctx.js`, since 人情往来 is per-person). `ctx.js` requires `status.js`, so any function with `ctx.js` must also get `status.js`; the target `MINI:utils` copies into `miniprogram/utils/`.

**Collections self-heal.** Functions call an idempotent `ensureCol(name)` before use; the `init` function creates all collections at once. New collections need both, plus console-side permission setup (note it in the doc as a 控制台待办).

**Printing.** `utils/ble.js` (BLE connection) → `utils/escpos.js` (ESC/POS commands) → `utils/printer.js` (high-level receipt printing using templates from `printtpl`); Chinese is GBK-encoded via `utils/gbk.js` + generated `gbk-table.js` (covers only the GB2312 common range, 7478 chars).

**Test AppID limits.** A test/tourist AppID can't call `wxacode.getUnlimited`; the pay-code page falls back to "personal pay code + share" mode, so that path only works under the real AppID.

**UI pitfalls.** Margins on `<button class="btn">` need `button.xxx:not([size=mini])` specificity to beat `app.wxss`; non-tab pages need `env(safe-area-inset-bottom)` padding.

## Release conventions

For each change: bump `VERSION` in `miniprogram/config.js` (minor for features, patch for fixes; shown on the 「我的」 page and must match the uploaded version), append a new numbered section to the end of `docs/技术开发文档.md` (design, API/fields, console to-dos), and commit locally with an English message prefixed `vX.Y.Z: …`. Don't push or upload unless asked. The cloud CLI cannot query the database.
