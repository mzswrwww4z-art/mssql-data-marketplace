---
name: tsql-queries
description: Write correct, performant T-SQL for Microsoft SQL Server 2022 (compatibility level 160). Use when writing or optimizing queries, reading execution plans, using SQL Server 2022 functions (DATETRUNC, DATE_BUCKET, GENERATE_SERIES, GREATEST/LEAST, IS DISTINCT FROM, WINDOW clause, APPROX_PERCENTILE_CONT), building analytical queries with CTEs and window functions, or debugging T-SQL errors.
user-invocable: false
---

# T-SQL Queries Skill (SQL Server 2022)

Write correct, performant, readable T-SQL for **SQL Server 2022 (16.x)** only. Do not use syntax from other dialects (`LIMIT`, `ILIKE`, `::` casts, `DATE_TRUNC('month', x)`, `||` concatenation, `INTERVAL`, `QUALIFY`, `SELECT * EXCEPT`).

## Working Through DBHub (Read-Only)

The plugin's `dbhub` MCP server exposes one set of tools per server the user added with `/mssql-data:add-server`. With a single server the names are plain; with several, every tool carries the server name as suffix:

| Tool (one server) | Tool (several servers) | Use for |
|-------------------|------------------------|---------|
| `search_objects` | `search_objects_<server>` | Find schemas, tables, views, columns, procedures, functions, indexes (progressive: `names` → `summary` → `full`) |
| `execute_sql` | `execute_sql_<server>` | Run read-only queries. Results are capped at 1000 rows, 60 s timeout |
| `explain_sql` | `explain_sql_<server>` | Estimated execution plan (SHOWPLAN_XML). Never executes the statement |
| `health_check` | `health_check_<server>` | Connection pool and buffer cache metrics (needs `VIEW SERVER STATE`) |

With several servers, use the one the user means (each source's description says what it holds; ask when it is ambiguous) and name the server when presenting results. Every query runs on exactly one server: to combine data from two servers, query each one and combine the results afterwards. If there are no database tools at all, no server is configured yet; suggest `/mssql-data:add-server`.

**Read-only rules enforced by DBHub on SQL Server** — every statement must start with `SELECT` or `WITH`. Therefore:

- No `DECLARE` / `SET @var` — inline literals instead, or use a CTE that holds parameters:
  ```sql
  WITH params AS (SELECT CAST('2025-01-01' AS date) AS start_date, CAST('2025-07-01' AS date) AS end_date)
  SELECT ... FROM dbo.Orders o CROSS JOIN params p WHERE o.OrderDate >= p.start_date AND o.OrderDate < p.end_date;
  ```
- No temp tables (`#tmp`, `SELECT ... INTO`), table variables, or `CREATE` of any kind — use CTEs or derived tables.
- No `EXEC` / `sp_executesql` / system procedures (`sp_help`, `sp_spaceused`, `sp_helpindex`) — query the catalog views (`sys.*`) and DMVs instead (see "Catalog Queries" below).
- No `OPENQUERY` / `OPENROWSET` / `OPENDATASOURCE` / linked-server pass-through.
- Avoid identifiers that are exactly a mutating keyword (`Update`, `Delete`, `Create`, `Merge`...) — DBHub rejects them as whole words. If a column is literally named like that, tell the user and suggest querying via a view.
- If more than 1000 rows are needed, aggregate in SQL instead of pulling raw rows, or page with `OFFSET ... FETCH`.
- If a write is required, write the script for the user to run themselves in SSMS/Azure Data Studio; never try to work around the read-only guard.

## Before Writing Queries: Check the Environment

Connections have no fixed database: they open in the login's default database (often `master`). Run these once per server per session and remember the answers:

```sql
-- Server version and the database the connection opened in
SELECT SERVERPROPERTY('ProductVersion')     AS product_version,   -- 16.x = SQL Server 2022
       SERVERPROPERTY('ProductUpdateLevel') AS cu_level,
       SERVERPROPERTY('Edition')            AS edition,
       DB_NAME()                            AS current_db;

-- User databases this login can open, with their settings
SELECT name,
       compatibility_level,              -- 160 = full 2022 feature set
       collation_name,                   -- _CI_ = case-insensitive comparisons
       is_read_committed_snapshot_on,
       is_query_store_on
FROM sys.databases
WHERE database_id > 4 AND state_desc = 'ONLINE' AND HAS_DBACCESS(name) = 1
ORDER BY name;
```

- **Which database**: ask the user when the question doesn't make it clear, then reference objects with three-part names (`SalesDB.dbo.Orders`) unless they live in `DB_NAME()`. `USE` is not available in read-only mode.
- **Compatibility level** applies per database, and gated syntax follows the database the query runs in (`DB_NAME()`), not the one you reference.
- **Compatibility level < 160**: avoid `GENERATE_SERIES` and the `WINDOW` clause (they require 160) and do not rely on 2022 Intelligent Query Processing features. Other 2022 functions (`DATETRUNC`, `DATE_BUCKET`, `GREATEST`/`LEAST`, `IS DISTINCT FROM`, `APPROX_PERCENTILE_CONT`) work at any level, but if one fails, fall back to the "Pre-2022 equivalent" shown below.
- **Collation**: most installs are `SQL_Latin1_General_CP1_CI_AS` → `=` and `LIKE` are case-insensitive. For case-sensitive comparisons add `COLLATE Latin1_General_CS_AS`.

## Date and Time

```sql
-- Current date/time
GETDATE()              -- datetime, server local time
SYSDATETIME()          -- datetime2(7), server local time
SYSUTCDATETIME()       -- datetime2(7), UTC
SYSDATETIMEOFFSET()    -- with offset
CAST(GETDATE() AS date)

-- Arithmetic
DATEADD(day, 7, OrderDate)
DATEADD(month, -1, OrderDate)
DATEDIFF(day, StartDate, EndDate)          -- counts boundaries crossed, not full periods
DATEDIFF_BIG(second, StartTs, EndTs)       -- when the int result can overflow
EOMONTH(OrderDate)                          -- last day of month
EOMONTH(OrderDate, -1)                      -- last day of previous month

-- Truncate to period (SQL Server 2022)
DATETRUNC(month, OrderDate)                 -- also: year, quarter, week, iso_week, day, hour, minute
DATETRUNC(iso_week, OrderDate)              -- Monday-based week, independent of DATEFIRST
-- Pre-2022 equivalent: DATEFROMPARTS(YEAR(OrderDate), MONTH(OrderDate), 1)

-- Fixed-width buckets (SQL Server 2022)
DATE_BUCKET(week, 1, OrderDate)                                  -- weeks starting from 1900-01-01 (a Monday)
DATE_BUCKET(minute, 15, EventTime)                               -- 15-minute buckets
DATE_BUCKET(day, 7, OrderDate, CAST('2025-01-06' AS date))       -- custom origin

-- Parts
YEAR(d), MONTH(d), DAY(d)
DATEPART(quarter, d), DATEPART(iso_week, d)
DATEPART(weekday, d)                        -- depends on SET DATEFIRST (US default 7 = Sunday is day 1)
DATENAME(month, d), DATENAME(weekday, d)    -- language-dependent names

-- Build / format
DATEFROMPARTS(2025, 1, 31)
DATETIME2FROMPARTS(2025, 1, 31, 23, 59, 59, 0, 0)
CONVERT(char(10), d, 23)                    -- 'yyyy-mm-dd' (fast, deterministic)
CONVERT(char(7), d, 126)                    -- 'yyyy-mm'
FORMAT(d, 'yyyy-MM')                        -- flexible but slow (CLR): avoid on large row sets

-- Time zones
OrderTimeUtc AT TIME ZONE 'UTC' AT TIME ZONE 'SE Asia Standard Time'   -- UTC → WIB (UTC+7)
-- Names come from sys.time_zone_info
```

**Sargable date filters** — never wrap the column in a function in `WHERE`:

```sql
-- Bad: prevents index seeks
WHERE YEAR(OrderDate) = 2025 AND MONTH(OrderDate) = 3

-- Good: half-open range
WHERE OrderDate >= '2025-03-01' AND OrderDate < '2025-04-01'
```

Use unambiguous literals: `'20250315'` or `'2025-03-15'` (for `date`/`datetime2`). Avoid `'03/15/2025'` — it depends on `SET DATEFORMAT`/language.

## Generating Series (SQL Server 2022)

```sql
-- Number series (requires compatibility level 160)
SELECT value FROM GENERATE_SERIES(1, 12);

-- Date spine: every day of 2025, to fill gaps in time series
SELECT DATEADD(day, s.value, CAST('2025-01-01' AS date)) AS calendar_date
FROM GENERATE_SERIES(0, DATEDIFF(day, '2025-01-01', '2025-12-31')) AS s;

-- Pre-2022 equivalent: recursive CTE (add OPTION (MAXRECURSION 0) beyond 100 rows)
WITH n AS (SELECT 0 AS i UNION ALL SELECT i + 1 FROM n WHERE i < 364)
SELECT DATEADD(day, i, CAST('2025-01-01' AS date)) FROM n OPTION (MAXRECURSION 0);
```

## Strings

```sql
-- Concatenation
CONCAT(FirstName, ' ', LastName)            -- NULL-safe (treats NULL as '')
CONCAT_WS(', ', City, Province, Country)    -- skips NULLs
FirstName + ' ' + LastName                  -- NULL if any part is NULL

-- Pattern matching (case sensitivity follows collation)
Name LIKE '%budi%'
Name LIKE '[A-C]%'                          -- character ranges
Code LIKE '%[_]%'                           -- escape wildcard with brackets
-- No regex functions in SQL Server 2022 - use LIKE, PATINDEX, or CHARINDEX
PATINDEX('%[0-9]%', Code)
CHARINDEX('-', Code)

-- Manipulation
LEFT(s, n), RIGHT(s, n), SUBSTRING(s, start, len)
LEN(s)            -- excludes trailing spaces
DATALENGTH(s)     -- bytes
TRIM(s)                         -- spaces
TRIM('.,! ' FROM s)             -- custom characters
LTRIM(s, '0'), RTRIM(s, '0')    -- custom characters (2022)
REPLACE(s, 'a', 'b'), TRANSLATE(s, '[]', '()'), STUFF(s, 1, 3, 'X')
UPPER(s), LOWER(s), REVERSE(s), REPLICATE('0', 5)
RIGHT(REPLICATE('0', 8) + CAST(Id AS varchar(8)), 8)   -- left-pad

-- Split / aggregate
SELECT value, ordinal FROM STRING_SPLIT('a,b,c', ',', 1);      -- enable_ordinal (2022) preserves order
STRING_AGG(ProductName, ', ') WITHIN GROUP (ORDER BY ProductName)
STRING_AGG(CAST(Notes AS nvarchar(max)), '; ')                 -- avoid 8000-byte truncation error
```

Always use `N'...'` literals when comparing against `nvarchar` columns, and match literal types to column types to avoid implicit conversions (which cause scans; visible as `CONVERT_IMPLICIT` in plans).

## NULL Handling and Comparisons

```sql
ISNULL(col, 0)                    -- 2 args, return type of first arg
COALESCE(a, b, c)                 -- ANSI, return type by precedence
NULLIF(denominator, 0)            -- safe division: x / NULLIF(y, 0)

-- SQL Server 2022: NULL-safe equality
WHERE a.Status IS DISTINCT FROM b.Status       -- true when one is NULL and the other isn't
WHERE a.Region IS NOT DISTINCT FROM b.Region   -- treats NULL = NULL as true
-- Pre-2022 equivalent: (a = b OR (a IS NULL AND b IS NULL))

-- SQL Server 2022: row-wise max/min (ignore NULLs)
GREATEST(UpdatedAt, ShippedAt, DeliveredAt)
LEAST(Price, DiscountPrice)

IIF(Amount > 0, 'credit', 'debit')
CASE WHEN ... THEN ... ELSE ... END
```

## Numbers and Types

```sql
-- Integer division truncates: 5 / 2 = 2
1.0 * Completed / NULLIF(Total, 0)              -- force decimal
CAST(Completed AS decimal(18, 4)) / NULLIF(Total, 0)
ROUND(x, 2), CEILING(x), FLOOR(x), ABS(x), POWER(x, 2), SQRT(x), LOG(x), EXP(x)

-- Safe conversions (return NULL instead of error)
TRY_CAST(Code AS int)
TRY_CONVERT(date, RawDate, 112)                  -- 'yyyymmdd'
TRY_PARSE(Amount AS money USING 'id-ID')         -- culture-aware, slow

-- Use COUNT_BIG(*) when counts can exceed 2^31
```

## Aggregation and Statistics

```sql
COUNT(*), COUNT(col), COUNT(DISTINCT col), COUNT_BIG(*)
APPROX_COUNT_DISTINCT(UserId)                    -- fast HyperLogLog estimate (~2% error)
SUM, AVG, MIN, MAX
STDEV(x), STDEVP(x), VAR(x), VARP(x)
```

`AVG` on an `int` column returns an `int` — use `AVG(CAST(col AS decimal(18, 4)))` or `AVG(col * 1.0)`.

```sql
-- Median / percentiles
-- Exact (window function: one value per row, so use DISTINCT or a per-group pattern)
SELECT DISTINCT
    Category,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY Amount) OVER (PARTITION BY Category) AS median_amount
FROM dbo.Sales;

-- Approximate, true aggregate (SQL Server 2022) - works with GROUP BY, much faster on large tables
SELECT
    Category,
    APPROX_PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY Amount) AS p50,
    APPROX_PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY Amount) AS p95,
    APPROX_PERCENTILE_DISC(0.99) WITHIN GROUP (ORDER BY Amount) AS p99
FROM dbo.Sales
GROUP BY Category;

-- Subtotals and grand totals
GROUP BY ROLLUP (Region, Product)
GROUP BY CUBE (Region, Product)
GROUP BY GROUPING SETS ((Region), (Product), ())
GROUPING(Region)                                  -- 1 on subtotal rows
```

## Window Functions

```sql
-- Ranking
ROW_NUMBER() OVER (PARTITION BY CustomerId ORDER BY OrderDate DESC)
RANK()       OVER (PARTITION BY Category ORDER BY Revenue DESC)
DENSE_RANK() OVER (ORDER BY Score DESC)
NTILE(4)     OVER (ORDER BY Revenue)

-- Running totals / moving averages (always specify ROWS - the default RANGE frame is slower and groups ties)
SUM(Revenue) OVER (ORDER BY OrderDate ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_total
AVG(Revenue) OVER (ORDER BY OrderDate ROWS BETWEEN 6 PRECEDING AND CURRENT ROW)        AS moving_avg_7d

-- Lag / lead
LAG(Value, 1)  OVER (PARTITION BY EntityId ORDER BY PeriodDate) AS prev_value
LEAD(Value, 1) OVER (PARTITION BY EntityId ORDER BY PeriodDate) AS next_value

-- First / last value; IGNORE NULLS is new in SQL Server 2022 (carry last known value forward)
LAST_VALUE(Price) IGNORE NULLS OVER (PARTITION BY ProductId ORDER BY PriceDate
                                     ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS last_known_price

-- Percent of total
Revenue * 1.0 / SUM(Revenue) OVER ()                       AS pct_of_total
Revenue * 1.0 / SUM(Revenue) OVER (PARTITION BY Category)  AS pct_of_category

-- Named windows (SQL Server 2022, compatibility level 160)
SELECT
    OrderDate, Revenue,
    SUM(Revenue) OVER w AS running_total,
    AVG(Revenue) OVER w AS running_avg
FROM dbo.DailyRevenue
WINDOW w AS (ORDER BY OrderDate ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW);
```

There is no `QUALIFY` in T-SQL — filter window results in an outer query or CTE.

## JSON (SQL Server 2022)

```sql
JSON_VALUE(Payload, '$.customer.name')                       -- scalar
JSON_QUERY(Payload, '$.items')                                -- object/array
ISJSON(Payload, OBJECT)                                       -- 2022: type check (VALUE, ARRAY, OBJECT, SCALAR)
JSON_PATH_EXISTS(Payload, '$.discount')                       -- 2022
JSON_OBJECT('id': CustomerId, 'name': Name)                   -- 2022: build JSON
JSON_ARRAY(1, 'a', NULL ABSENT ON NULL)                       -- 2022

-- Shred arrays
SELECT o.OrderId, i.Sku, i.Qty
FROM dbo.Orders AS o
CROSS APPLY OPENJSON(o.Payload, '$.items')
     WITH (Sku nvarchar(50) '$.sku', Qty int '$.qty') AS i;

-- Results as JSON
SELECT TOP (10) CustomerId, Name FROM dbo.Customers FOR JSON PATH;
```

## Limiting and Paging

```sql
SELECT TOP (100) ... ORDER BY Revenue DESC;                    -- always ORDER BY with TOP
SELECT TOP (100) WITH TIES ... ORDER BY Revenue DESC;

-- Paging
SELECT ... ORDER BY OrderId
OFFSET 1000 ROWS FETCH NEXT 1000 ROWS ONLY;

-- Random sample (small tables)
SELECT TOP (100) ... ORDER BY NEWID();
-- Random sample (large tables, approximate, page-based)
SELECT ... FROM dbo.BigTable TABLESAMPLE (1 PERCENT) REPEATABLE (42);
```

## Common Analytical Patterns

### CTEs for Readability

```sql
WITH
-- Step 1: base population
base_customers AS (
    SELECT CustomerId, CreatedAt, Segment
    FROM dbo.Customers
    WHERE CreatedAt >= '2025-01-01'
      AND IsActive = 1
),
-- Step 2: per-customer metrics
customer_metrics AS (
    SELECT
        c.CustomerId,
        c.Segment,
        COUNT(DISTINCT o.OrderId) AS order_count,
        SUM(o.TotalAmount)        AS total_revenue
    FROM base_customers AS c
    LEFT JOIN dbo.Orders AS o ON o.CustomerId = c.CustomerId
    GROUP BY c.CustomerId, c.Segment
)
-- Step 3: summary
SELECT
    Segment,
    COUNT(*)                                  AS customer_count,
    AVG(CAST(order_count AS decimal(18, 2)))  AS avg_orders,
    SUM(total_revenue)                        AS total_revenue
FROM customer_metrics
GROUP BY Segment
ORDER BY total_revenue DESC;
```

CTEs in SQL Server are not materialized — a CTE referenced twice is evaluated twice. If that is expensive, restructure (single pass with window functions or conditional aggregation).

### Cohort Retention

```sql
WITH cohorts AS (
    SELECT CustomerId, DATETRUNC(month, MIN(OrderDate)) AS cohort_month
    FROM dbo.Orders
    GROUP BY CustomerId
),
activity AS (
    SELECT DISTINCT CustomerId, DATETRUNC(month, OrderDate) AS activity_month
    FROM dbo.Orders
),
joined AS (
    SELECT c.cohort_month, a.CustomerId,
           DATEDIFF(month, c.cohort_month, a.activity_month) AS month_number
    FROM cohorts AS c
    JOIN activity AS a ON a.CustomerId = c.CustomerId
)
SELECT
    cohort_month,
    COUNT(DISTINCT CASE WHEN month_number = 0 THEN CustomerId END) AS cohort_size,
    COUNT(DISTINCT CASE WHEN month_number = 1 THEN CustomerId END) AS month_1,
    COUNT(DISTINCT CASE WHEN month_number = 3 THEN CustomerId END) AS month_3,
    COUNT(DISTINCT CASE WHEN month_number = 6 THEN CustomerId END) AS month_6
FROM joined
GROUP BY cohort_month
ORDER BY cohort_month;
```

### Funnel Analysis

```sql
WITH funnel AS (
    SELECT
        UserId,
        MAX(CASE WHEN EventName = 'page_view'       THEN 1 ELSE 0 END) AS step_1_view,
        MAX(CASE WHEN EventName = 'signup_start'    THEN 1 ELSE 0 END) AS step_2_start,
        MAX(CASE WHEN EventName = 'signup_complete' THEN 1 ELSE 0 END) AS step_3_complete,
        MAX(CASE WHEN EventName = 'first_purchase'  THEN 1 ELSE 0 END) AS step_4_purchase
    FROM dbo.Events
    WHERE EventTime >= DATEADD(day, -30, CAST(GETDATE() AS date))
    GROUP BY UserId
)
SELECT
    COUNT(*)              AS total_users,
    SUM(step_1_view)      AS viewed,
    SUM(step_2_start)     AS started_signup,
    SUM(step_3_complete)  AS completed_signup,
    SUM(step_4_purchase)  AS purchased,
    ROUND(100.0 * SUM(step_2_start)    / NULLIF(SUM(step_1_view), 0), 1)     AS view_to_start_pct,
    ROUND(100.0 * SUM(step_3_complete) / NULLIF(SUM(step_2_start), 0), 1)    AS start_to_complete_pct,
    ROUND(100.0 * SUM(step_4_purchase) / NULLIF(SUM(step_3_complete), 0), 1) AS complete_to_purchase_pct
FROM funnel;
```

### Deduplication

```sql
WITH ranked AS (
    SELECT EntityId, Name, UpdatedAt,
           ROW_NUMBER() OVER (PARTITION BY EntityId ORDER BY UpdatedAt DESC) AS rn
    FROM dbo.SourceTable
)
SELECT EntityId, Name, UpdatedAt FROM ranked WHERE rn = 1;
```

### Gap-Filled Time Series

```sql
WITH calendar AS (
    SELECT DATEADD(day, s.value, CAST('2025-01-01' AS date)) AS d
    FROM GENERATE_SERIES(0, 89) AS s
),
daily AS (
    SELECT CAST(OrderDate AS date) AS d, SUM(TotalAmount) AS revenue
    FROM dbo.Orders
    WHERE OrderDate >= '2025-01-01' AND OrderDate < '2025-04-01'
    GROUP BY CAST(OrderDate AS date)
)
SELECT c.d, ISNULL(daily.revenue, 0) AS revenue
FROM calendar AS c
LEFT JOIN daily ON daily.d = c.d
ORDER BY c.d;
```

### Pivot

```sql
-- Conditional aggregation (preferred: readable and flexible)
SELECT Region,
       SUM(CASE WHEN OrderDate >= '2024-01-01' AND OrderDate < '2025-01-01' THEN TotalAmount END) AS revenue_2024,
       SUM(CASE WHEN OrderDate >= '2025-01-01' AND OrderDate < '2026-01-01' THEN TotalAmount END) AS revenue_2025
FROM dbo.Orders
WHERE OrderDate >= '2024-01-01' AND OrderDate < '2026-01-01'
GROUP BY Region;

-- PIVOT operator
SELECT Region, [2024], [2025]
FROM (SELECT Region, YEAR(OrderDate) AS yr, TotalAmount FROM dbo.Orders) AS src
PIVOT (SUM(TotalAmount) FOR yr IN ([2024], [2025])) AS p;
```

Dynamic PIVOT requires dynamic SQL, which is blocked in read-only mode — list the columns explicitly.

### Top-N per Group

```sql
SELECT c.CategoryName, p.ProductName, p.Revenue
FROM dbo.Categories AS c
CROSS APPLY (
    SELECT TOP (3) ol.ProductName, SUM(ol.LineTotal) AS Revenue
    FROM dbo.OrderLines AS ol
    WHERE ol.CategoryId = c.CategoryId
    GROUP BY ol.ProductName
    ORDER BY Revenue DESC
) AS p;
```

## Catalog Queries (Instead of sp_help*)

`search_objects` covers schema discovery in the current database (`DB_NAME()`). For anything else, query the catalog directly. The examples below use the current database; for another one, prefix the catalog views (`SalesDB.sys.tables`, `SalesDB.INFORMATION_SCHEMA.COLUMNS`) and pass the database id to metadata functions: `OBJECT_ID('SalesDB.dbo.Orders')`, `OBJECT_NAME(object_id, DB_ID('SalesDB'))`, `OBJECT_SCHEMA_NAME(object_id, DB_ID('SalesDB'))`.

```sql
-- Row counts and size per table (no full scan)
SELECT s.name AS schema_name, t.name AS table_name,
       SUM(CASE WHEN p.index_id IN (0, 1) THEN p.row_count END) AS row_count,
       CAST(SUM(p.reserved_page_count) * 8.0 / 1024 AS decimal(18, 1)) AS reserved_mb
FROM sys.tables AS t
JOIN sys.schemas AS s ON s.schema_id = t.schema_id
JOIN sys.dm_db_partition_stats AS p ON p.object_id = t.object_id
GROUP BY s.name, t.name
ORDER BY row_count DESC;

-- Foreign keys (relationships)
SELECT fk.name AS fk_name,
       OBJECT_SCHEMA_NAME(fk.parent_object_id) + '.' + OBJECT_NAME(fk.parent_object_id) AS child_table,
       COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS child_column,
       OBJECT_SCHEMA_NAME(fk.referenced_object_id) + '.' + OBJECT_NAME(fk.referenced_object_id) AS parent_table,
       COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) AS parent_column
FROM sys.foreign_keys AS fk
JOIN sys.foreign_key_columns AS fkc ON fkc.constraint_object_id = fk.object_id
ORDER BY child_table;

-- Column descriptions (MS_Description extended properties)
SELECT OBJECT_SCHEMA_NAME(ep.major_id) AS schema_name, OBJECT_NAME(ep.major_id) AS table_name,
       c.name AS column_name, CAST(ep.value AS nvarchar(4000)) AS description
FROM sys.extended_properties AS ep
LEFT JOIN sys.columns AS c ON c.object_id = ep.major_id AND c.column_id = ep.minor_id
WHERE ep.name = 'MS_Description' AND ep.class = 1;

-- View / procedure definition
SELECT OBJECT_DEFINITION(OBJECT_ID('dbo.vw_SalesSummary')) AS definition;

-- Index columns for a table
SELECT i.name AS index_name, i.type_desc, i.is_unique, ic.key_ordinal, ic.is_included_column,
       COL_NAME(ic.object_id, ic.column_id) AS column_name
FROM sys.indexes AS i
JOIN sys.index_columns AS ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
WHERE i.object_id = OBJECT_ID('dbo.Orders')
ORDER BY i.name, ic.is_included_column, ic.key_ordinal;

-- Statistics freshness
SELECT s.name, STATS_DATE(s.object_id, s.stats_id) AS last_updated, sp.rows, sp.modification_counter
FROM sys.stats AS s
CROSS APPLY sys.dm_db_stats_properties(s.object_id, s.stats_id) AS sp
WHERE s.object_id = OBJECT_ID('dbo.Orders');
```

DMVs need `VIEW SERVER PERFORMANCE STATE` / `VIEW DATABASE PERFORMANCE STATE` (SQL Server 2022 granular permissions) or the older `VIEW SERVER STATE`. If a DMV query fails with a permission error, say so and continue without it.

## Performance

**Query design:**
- Never `SELECT *` in final queries — list columns (also avoids pulling LOB columns).
- Keep predicates sargable: no functions on indexed columns, no leading `%` in `LIKE` when a seek is needed, matching data types (`N'...'` for `nvarchar`, plain `'...'` for `varchar`).
- Prefer `EXISTS` / `NOT EXISTS` over `IN` / `NOT IN` with subqueries (`NOT IN` returns nothing if the subquery yields a NULL).
- Avoid scalar UDFs in `SELECT` lists over large row sets where possible.
- Avoid `OR` across different columns in `WHERE` on large tables; consider `UNION ALL`.
- Use `CROSS APPLY` for top-N-per-group and per-row table-valued logic.
- Use `COUNT_BIG` and `APPROX_COUNT_DISTINCT` on very large tables.
- Watch for exploding joins: compare row counts before and after a join.

**Reading plans with `explain_sql`:**
- Pass the statement without any `EXPLAIN` prefix; it returns the estimated plan (SHOWPLAN_XML) without executing.
- Look for: `Table Scan` / `Clustered Index Scan` on large tables, `Key Lookup` with high estimated rows, `CONVERT_IMPLICIT` warnings, `Sort`/`Hash Match` with large memory grants, missing-index hints (`<MissingIndexes>`), and parallelism on small queries.
- Missing-index suggestions are hints for the DBA, not commands — never treat them as mandatory, and remember index creation is outside this read-only plugin.

**SQL Server 2022 engine features to keep in mind (compatibility level 160):**
- Parameter Sensitive Plan optimization (multiple cached plans for skewed parameters).
- DOP feedback, memory grant percentile feedback, cardinality estimation feedback.
- Query Store is on by default for new databases and may hold historical performance data:
  ```sql
  SELECT TOP (20) qt.query_sql_text, rs.count_executions,
         rs.avg_duration / 1000.0 AS avg_duration_ms, rs.avg_logical_io_reads
  FROM sys.query_store_query_text AS qt
  JOIN sys.query_store_query AS q ON q.query_text_id = qt.query_text_id
  JOIN sys.query_store_plan AS p ON p.query_id = q.query_id
  JOIN sys.query_store_runtime_stats AS rs ON rs.plan_id = p.plan_id
  ORDER BY rs.avg_duration DESC;
  ```

**Etiquette on a shared internal production server:**
- Keep exploratory queries small (`TOP`, tight date ranges) and aggregate on the server.
- If `is_read_committed_snapshot_on = 0`, long reads can block writers. Do not add `WITH (NOLOCK)` by default — it can return duplicated or missing rows. Offer it only as an explicit trade-off the user accepts.
- Prefer off-peak hours or a reporting replica for heavy profiling, and say so when a query will scan a very large table.

## Error Handling and Debugging

When a query fails:

1. **Invalid object name**: the object is probably in another database than `DB_NAME()`: use its three-part name (`SalesDB.dbo.Orders`). Also check the schema prefix (`dbo.` vs another schema) and find the right name with the `schema-discovery` skill.
2. **Invalid column name**: verify with `search_objects` (`detail_level: "full"`); bracket identifiers with spaces or reserved words: `[Order Date]`, `[User]`.
3. **Conversion failed**: use `TRY_CAST` / `TRY_CONVERT` to find bad rows: `WHERE TRY_CAST(col AS int) IS NULL AND col IS NOT NULL`.
4. **Divide by zero**: `x / NULLIF(y, 0)`.
5. **Column is invalid in the select list because it is not contained in either an aggregate function or the GROUP BY clause**: T-SQL cannot `GROUP BY` a `SELECT` alias — repeat the expression or compute it in a CTE.
6. **The ORDER BY clause is invalid in views, inline functions, derived tables, subqueries, and common table expressions**: move `ORDER BY` to the outermost query.
7. **Ambiguous column name**: qualify every column with its table alias in joins.
8. **Arithmetic overflow**: switch to `COUNT_BIG`, `bigint`, `DATEDIFF_BIG`, or a larger `decimal`.
9. **Query timeout (60 s)**: narrow the date range, aggregate earlier, check the plan with `explain_sql`.
10. **Rejected by DBHub (read-only)**: the statement started with something other than `SELECT`/`WITH`, or contained `EXEC`, a mutating keyword, or `OPENQUERY`. Rewrite it as a single `SELECT`/`WITH` query.
