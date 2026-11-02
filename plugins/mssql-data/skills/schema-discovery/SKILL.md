---
name: schema-discovery
description: Explore a SQL Server 2022 schema token-efficiently through the DBHub search_objects tool. Use before writing T-SQL against tables you haven't inspected yet, when looking for which table holds a concept (email, invoice, branch), or when mapping relationships between tables.
user-invocable: false
---

# SQL Server Schema Discovery (DBHub)

Use `search_objects` with progressive disclosure — always coarse to fine. Never start with a pattern-less `full` call on an unfamiliar database.

With several servers configured, every server has its own tool (`search_objects_<server>`) and its own schema: explore the server the user means.

## Workflow

1. **Orient — schemas first.** `object_type: "schema"`. Internal SQL Server databases often split data across schemas (`dbo`, `sales`, `hr`, `staging`, `rpt`), and the same table name can exist in several.
2. **List tables cheaply.** `object_type: "table"`, `detail_level: "names"`, optionally `schema: "dbo"`. Also check `object_type: "view"` — reporting views (`vw_*`, `rpt.*`) are often the intended source for analysts.
3. **Narrow.** `detail_level: "summary"` with a pattern such as `%Order%` to get row counts, column counts and comments for candidate tables.
4. **Drill in.** `detail_level: "full"` only for the tables you will actually query (columns, types, nullability, keys, indexes).
5. **Find a concept fast.** `object_type: "column"` with a pattern like `%Email%`, `%NIK%`, `%Cabang%`, `%Tanggal%` shows which tables hold it. Column names in internal databases are frequently Indonesian or abbreviated — try both languages (`%Customer%` and `%Pelanggan%`).
6. **Indexes and keys.** `object_type: "index"` with `schema` + `table` before writing heavy filters/joins, so predicates line up with existing indexes.

`pattern` uses SQL `LIKE` syntax (`%`, `_`). Matching follows the database collation (usually case-insensitive). `limit` defaults to 100 (max 1000).

## Beyond search_objects

For relationships, descriptions and sizes, run catalog queries through `execute_sql` (see the `tsql-queries` skill, "Catalog Queries"): foreign keys from `sys.foreign_keys`, column descriptions from `sys.extended_properties` (`MS_Description`), row counts from `sys.dm_db_partition_stats`, view definitions with `OBJECT_DEFINITION`.

If the database has no declared foreign keys (common in legacy internal systems), infer joins from matching column names and types, then verify with a quick orphan check before relying on them:

```sql
SELECT COUNT_BIG(*) AS orphan_rows
FROM dbo.Orders AS o
WHERE NOT EXISTS (SELECT 1 FROM dbo.Customers AS c WHERE c.CustomerId = o.CustomerId);
```

## Sampling Data

- Always `TOP (n)` with `ORDER BY` when sampling — start with `TOP (10)`. Never `LIMIT`.
- Prefer aggregates (`COUNT_BIG`, `GROUP BY`, `MIN`/`MAX`) to characterize data instead of pulling rows.
- Check a table's `full` detail before writing JOINs so you use real column names — don't guess and retry.
- The plugin is read-only; if a statement is rejected, tell the user rather than working around it.
