# T-SQL Dialect Section (SQL Server 2022)

Copy the block below into every generated skill under "SQL Dialect". Fill the bracketed values from the environment check (`SERVERPROPERTY`, `sys.databases`) run during discovery, and delete lines that don't apply.

---

```markdown
## SQL Dialect: Microsoft SQL Server 2022 (T-SQL)

- **Server / database**: [SERVER_NAME] / [DATABASE_NAME], compatibility level [160], collation [SQL_Latin1_General_CP1_CI_AS]
- **Object references**: `schema.table` (e.g. `dbo.Orders`); cross-database `Database.schema.table`. Bracket names with spaces/reserved words: `[Order Date]`
- **Case sensitivity**: comparisons follow the collation — [case-insensitive]. Use `COLLATE Latin1_General_CS_AS` for case-sensitive checks
- **Limiting rows**: `SELECT TOP (n) ... ORDER BY ...`, paging with `OFFSET n ROWS FETCH NEXT m ROWS ONLY` (no `LIMIT`)
- **Safe division**: `x * 1.0 / NULLIF(y, 0)` (integer division truncates)
- **Dates**:
  - Truncate: `DATETRUNC(month, col)` (2022), week starting Monday: `DATETRUNC(iso_week, col)`
  - Arithmetic: `DATEADD(day, -7, col)`, `DATEDIFF(day, start, end)`, `EOMONTH(col)`
  - Buckets: `DATE_BUCKET(minute, 15, col)` (2022)
  - Date spine: `GENERATE_SERIES(0, n)` (2022, compatibility level 160)
  - Filters: half-open ranges `col >= '2025-01-01' AND col < '2025-02-01'` (never `BETWEEN` on datetime)
  - Server time zone: [WIB / UTC+7]; stored timestamps are [local / UTC]. Convert with `col AT TIME ZONE 'UTC' AT TIME ZONE 'SE Asia Standard Time'`
- **NULL-safe comparison**: `a IS [NOT] DISTINCT FROM b` (2022)
- **Row-wise max/min**: `GREATEST(a, b, c)`, `LEAST(a, b)` (2022)
- **Strings**: `CONCAT`, `CONCAT_WS`, `STRING_AGG(col, ', ') WITHIN GROUP (ORDER BY col)`, `STRING_SPLIT(col, ',', 1)`, `TRIM`. No regex: use `LIKE` / `PATINDEX`. Use `N'...'` for `nvarchar` columns
- **Percentiles**: `APPROX_PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY col)` (2022 aggregate) or exact `PERCENTILE_CONT ... OVER (PARTITION BY ...)`
- **Distinct counts on big tables**: `APPROX_COUNT_DISTINCT(col)`
- **Window filtering**: no `QUALIFY` — filter `ROW_NUMBER()` in an outer query/CTE
- **Booleans**: `bit` columns compare with `= 1` / `= 0` (no `TRUE`/`FALSE` literals)
- **JSON**: `JSON_VALUE`, `OPENJSON ... WITH (...)`, `JSON_OBJECT`, `ISJSON(col, OBJECT)` (2022)
- **Read-only access via DBHub**: one statement starting with `SELECT`/`WITH`; no `DECLARE`, temp tables, `EXEC`, or `OPENQUERY`; max 1000 rows per result — aggregate on the server
```

---

## Notes for the Generator

- If compatibility level is below 160, replace the `GENERATE_SERIES` line with a recursive-CTE pattern and drop the `WINDOW` clause from any sample query.
- If the database uses a case-sensitive collation (`_CS_`), say so prominently — column and value matching then becomes exact.
- If timestamps are a mix of local and UTC across tables, document it per table in the domain reference files, not only here.
- Full T-SQL guidance (functions, patterns, catalog queries, performance) lives in the plugin's `tsql-queries` skill; the generated skill only needs the company-specific summary above.
