# Writing migrations safely

Migrations in this folder are plain `{ up, down }` JS files run by
[`../_runner.js`](../_runner.js). They apply either via `npm run migrate` or
automatically on app boot when `RUN_MIGRATIONS_ON_BOOT=true` (see
[`../runPendingMigrations.js`](../runPendingMigrations.js)). Applied files are
recorded in `SequelizeMeta`, so re-running is a no-op — booting twice is safe.

## The one rule: don't break the code that's still running

When we run more than one app instance, deploys are **rolling** — old and new
code run at the same time against **one** database for a minute or two. So every
migration must keep the **currently running** code working. The pattern is
**expand first, contract later**: add new things now, remove old things only in
a *later* deploy once nothing uses them. **Never rename or retype a column in
place.**

## Quick reference

| Operation | Safe in one step? | How to do it |
|---|---|---|
| Add nullable column / column with a default | ✅ | Single migration. This is the common case. |
| Add a new table or index | ✅ | Single migration. |
| Add a `NOT NULL` column | ❌ | (1) add nullable → (2) backfill → (3) deploy code that writes it → (4) later migration sets `NOT NULL`. |
| Rename a column | ❌ | (1) add new col → (2) deploy code writing **both** → (3) backfill old rows → (4) deploy code reading new → (5) later migration drops old. |
| Drop a column | ❌ | Deploy code that stops using it **first**, drop it in a **later** migration. |
| Change a column's type | ❌ | Add a new column, migrate data, switch code over, drop the old one. |

"Safe in one step" means safe to apply while old code is still live. The ❌ rows
must be split across **multiple deploys** in the order shown.

## Always write a real `down`

Each migration needs a `down` that reverses `up` (see the existing files for the
QueryInterface style). `npm run migrate:undo:all` and the test reset rely on it.

## Large tables

Plain `ALTER TABLE` can lock a big table for the duration of the change. We're
small enough today that this doesn't bite, but once a table grows large, use
MySQL online DDL (`ALGORITHM=INPLACE, LOCK=NONE`) or a tool like `gh-ost` /
`pt-online-schema-change` for alters on hot tables.
