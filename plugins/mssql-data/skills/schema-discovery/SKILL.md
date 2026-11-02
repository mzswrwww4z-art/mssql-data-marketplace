---
name: schema-discovery
description: Explore a SQL Server 2022 schema token-efficiently through the DBHub tools. Use before writing T-SQL against tables you haven't inspected yet, when looking for which table holds a concept (email, invoice, branch), when choosing which database to use, or when mapping relationships between tables.
user-invocable: false
---

# SQL Server Schema Discovery (DBHub)

Connections have no fixed database: each opens in its login's default database (`DB_NAME()`, often `master`). `search_objects` only searches that database; other databases are explored with catalog queries through `execute_sql` and three-part names. With several servers configured, every server has its own tools (`search_objects_<server>`, `execute_sql_<server>`): explore the server the user means. Always go coarse to fine, never start with a pattern-less `full` call.

## 1. Pick the Database

```sql
SELECT DB_NAME() AS current_db;

SELECT name
FROM sys.databases
WHERE database_id > 4 AND state_desc = 'ONLINE' AND HAS_DBACCESS(name) = 1
ORDER BY name;
```

If the question doesn't make the database obvious, ask the user which one to use.

## 2a. The Current Database: `search_objects`

1. **Orient: schemas first.** `object_type: "schema"`. Data is often split across schemas (`dbo`, `sales`, `hr`, `staging`, `rpt`), and the same table name can exist in several.
2. **List tables cheaply.** `object_type: "table"`, `detail_level: "names"`, optionally `schema: "dbo"`. Also check `object_type: "view"`: reporting views (`vw_*`, `rpt.*`) are often the intended source for analysts.
3. **Narrow.** `detail_level: "summary"` with a pattern such as `%Order%` for row counts, column counts and comments.
4. **Drill in.** `detail_level: "full"` only for the tables you will actually query (columns, types, nullability, keys, indexes).
5. **Find a concept fast.** `object_type: "column"` with a pattern like `%Email%`, `%NIK%`, `%Cabang%`, `%Tanggal%`. Column names in internal databases are often Indonesian or abbreviated, so try both languages (`%Customer%` and `%Pelanggan%`).
6. **Indexes and keys.** `object_type: "index"` with `schema` + `table` before writing heavy filters or joins.

`pattern` uses SQL `LIKE` syntax (`%`, `_`) and follows the database collation (usually case-insensitive). `limit` defaults to 100 (max 1000).

## 2b. Any Other Database: Catalog Queries With Three-Part Names

Same coarse-to-fine order, through `execute_sql` (replace `SalesDB`):

```sql
-- Tables and views (names only)
SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
FROM SalesDB.INFORMATION_SCHEMA.TABLES
ORDER BY TABLE_SCHEMA, TABLE_NAME;

-- Find a concept by column name
SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE
FROM SalesDB.INFORMATION_SCHEMA.COLUMNS
WHERE COLUMN_NAME LIKE '%Email%';

-- Full column detail for one table
SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE, COLUMN_DEFAULT
FROM SalesDB.INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'Orders'
ORDER BY ORDINAL_POSITION;

-- Approximate row counts (no scan)
SELECT s.name AS schema_name, t.name AS table_name, SUM(p.rows) AS row_count
FROM SalesDB.sys.tables AS t
JOIN SalesDB.sys.schemas AS s ON s.schema_id = t.schema_id
JOIN SalesDB.sys.partitions AS p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
GROUP BY s.name, t.name
ORDER BY row_count DESC;

-- Indexes of one table
SELECT i.name AS index_name, i.type_desc, i.is_unique, ic.key_ordinal, ic.is_included_column, c.name AS column_name
FROM SalesDB.sys.indexes AS i
JOIN SalesDB.sys.index_columns AS ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
JOIN SalesDB.sys.columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE i.object_id = OBJECT_ID('SalesDB.dbo.Orders')
ORDER BY i.name, ic.is_included_column, ic.key_ordinal;
```

## Relationships

Foreign keys live in `sys.foreign_keys` and `sys.foreign_key_columns` of each database; for another database prefix them (`SalesDB.sys.foreign_keys`) and pass the database id to metadata functions (`OBJECT_NAME(fk.parent_object_id, DB_ID('SalesDB'))`). More catalog queries are in the `tsql-queries` skill, "Catalog Queries".

If the database has no declared foreign keys (common in legacy internal systems), infer joins from matching column names and types, then verify with a quick orphan check before relying on them:

```sql
SELECT COUNT_BIG(*) AS orphan_rows
FROM SalesDB.dbo.Orders AS o
WHERE NOT EXISTS (SELECT 1 FROM SalesDB.dbo.Customers AS c WHERE c.CustomerId = o.CustomerId);
```

## Sampling Data

- Always `TOP (n)` with `ORDER BY` when sampling: start with `TOP (10)`. Never `LIMIT`.
- Prefer aggregates (`COUNT_BIG`, `GROUP BY`, `MIN`/`MAX`) to characterize data instead of pulling rows.
- Check a table's columns before writing JOINs so you use real column names; don't guess and retry.
- The plugin is read-only; if a statement is rejected, tell the user rather than working around it.
