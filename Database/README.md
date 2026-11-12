# Database

- `schema.sql` – the full schema: tables, keys, constraints, integrity triggers and the `v_error_reports` reporting view. The server applies it on every start (safe to re-run).
- `data/` – created on first start. Contains `production.db` (SQLite) and `photos/`. This is the authoritative data; back it up with `npm run backup` (creates `backups/<timestamp>/`).

Open the database with any SQLite tool (for example DB Browser for SQLite) for ad-hoc queries, preferably on a backup copy. Example:

```sql
SELECT stage, COUNT(*) FROM v_error_reports WHERE status <> 'Resolved' GROUP BY stage;
```

Table descriptions, relationships and integrity rules: `../Documentation/ARCHITECTURE.md`.
