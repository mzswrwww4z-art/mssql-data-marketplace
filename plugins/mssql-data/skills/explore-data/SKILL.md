---
name: explore-data
description: Profile and explore a SQL Server 2022 table or view (or an uploaded file) to understand its shape, quality, and patterns. Use when encountering a new table, checking null rates and column distributions, spotting data quality issues like duplicates or suspicious values, or deciding which dimensions and metrics to analyze.
argument-hint: "<schema.table or file>"
---

# /explore-data - Profile and Explore a Dataset (SQL Server 2022)

Generate a comprehensive data profile for a SQL Server table/view or an uploaded file. Understand its shape, quality, and patterns before diving into analysis.

## Usage

```
/explore-data <schema.table_name or file>
```

## Workflow

### 1. Access the Data

**If the `dbhub` MCP server is connected:**

1. Resolve the table name with `search_objects` — handle schema prefixes (`dbo.`, `sales.`) and suggest matches if ambiguous
2. Get metadata with `search_objects` (`detail_level: "full"`): columns, data types, nullability, keys, indexes, `MS_Description` comments
3. Get size without scanning (row count and reserved MB from `sys.dm_db_partition_stats` — see "Table-level metadata" below)
4. Run the profiling queries below against the live data through `execute_sql`

**If a file is provided (CSV, Excel, Parquet, JSON):**

1. Read the file and load it into a working dataset (pandas)
2. Infer column types from the data

**If neither:**

1. Suggest `/mssql-setup` to connect, or ask the user to upload an export
2. If they describe a table schema, provide the T-SQL profiling queries for them to run in SSMS

### 2. Understand Structure

Before analyzing any data, understand its structure:

**Table-level questions:**
- How many rows and columns?
- What is the grain (one row per what)?
- What is the primary key? Is it unique? (Check `sys.indexes.is_primary_key`; legacy tables often have none)
- When was the data last updated? (max of `UpdatedAt`/`CreatedAt`-style columns)
- How far back does the data go?

**Column classification** — categorize each column as one of:
- **Identifier**: Unique keys, foreign keys, entity IDs (`int`/`bigint` identity, `uniqueidentifier`, business codes)
- **Dimension**: Categorical attributes for grouping/filtering (status, type, region, branch)
- **Metric**: Quantitative values (`decimal`, `money`, `int`, `float` — amounts, quantities, durations)
- **Temporal**: `date`, `datetime`, `datetime2`, `datetimeoffset`, `time`
- **Text**: Free-form text (`nvarchar(max)`, `varchar(max)`, notes, descriptions)
- **Boolean**: `bit` flags (or `char(1)` 'Y'/'N' in legacy schemas)
- **Structural**: JSON stored in `nvarchar`, XML, `varbinary`, `geography`/`geometry`, `hierarchyid`

### 3. Generate Data Profile

Run profiling checks with T-SQL. Keep every statement a single `SELECT`/`WITH` (DBHub read-only mode). Profile several columns per query to limit round trips, and on very large tables (tens of millions of rows) use `TABLESAMPLE` or a recent date range — say so in the report.

**Table-level metadata (no scan):**

```sql
SELECT s.name AS schema_name, t.name AS table_name,
       SUM(CASE WHEN p.index_id IN (0, 1) THEN p.row_count END) AS row_count,
       CAST(SUM(p.reserved_page_count) * 8.0 / 1024 AS decimal(18, 1)) AS reserved_mb,
       t.create_date, t.modify_date, t.temporal_type_desc
FROM sys.tables AS t
JOIN sys.schemas AS s ON s.schema_id = t.schema_id
JOIN sys.dm_db_partition_stats AS p ON p.object_id = t.object_id
WHERE t.object_id = OBJECT_ID('dbo.Orders')
GROUP BY s.name, t.name, t.create_date, t.modify_date, t.temporal_type_desc;
```

**All columns — nulls and cardinality (one pass):**

```sql
SELECT
    COUNT_BIG(*)                                         AS total_rows,
    SUM(CASE WHEN CustomerId IS NULL THEN 1 ELSE 0 END)  AS customer_id_nulls,
    COUNT(DISTINCT CustomerId)                           AS customer_id_distinct,
    SUM(CASE WHEN Status IS NULL THEN 1 ELSE 0 END)      AS status_nulls,
    COUNT(DISTINCT Status)                               AS status_distinct,
    APPROX_COUNT_DISTINCT(Email)                         AS email_distinct_approx   -- fast on large tables
FROM dbo.Orders;
```

**Top / bottom values for a dimension:**

```sql
SELECT TOP (10) Status, COUNT_BIG(*) AS n,
       CAST(100.0 * COUNT_BIG(*) / SUM(COUNT_BIG(*)) OVER () AS decimal(5, 2)) AS pct
FROM dbo.Orders
GROUP BY Status
ORDER BY n DESC;          -- use ORDER BY n ASC for the rarest values (anomaly spotting)
```

**Numeric columns (metrics):**

```sql
SELECT
    MIN(TotalAmount) AS min_val,
    MAX(TotalAmount) AS max_val,
    AVG(CAST(TotalAmount AS decimal(19, 4))) AS mean_val,
    STDEV(TotalAmount) AS stdev_val,
    APPROX_PERCENTILE_CONT(0.01) WITHIN GROUP (ORDER BY TotalAmount) AS p1,
    APPROX_PERCENTILE_CONT(0.05) WITHIN GROUP (ORDER BY TotalAmount) AS p5,
    APPROX_PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY TotalAmount) AS p25,
    APPROX_PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY TotalAmount) AS p50,
    APPROX_PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY TotalAmount) AS p75,
    APPROX_PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY TotalAmount) AS p95,
    APPROX_PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY TotalAmount) AS p99,
    SUM(CASE WHEN TotalAmount = 0 THEN 1 ELSE 0 END) AS zero_count,
    SUM(CASE WHEN TotalAmount < 0 THEN 1 ELSE 0 END) AS negative_count
FROM dbo.Orders;
```

Use `PERCENTILE_CONT ... OVER ()` (exact) only when the user needs exact values and the table is small; `APPROX_PERCENTILE_CONT` is a SQL Server 2022 aggregate and far cheaper.

**String columns (dimensions, text):**

```sql
SELECT
    MIN(LEN(CustomerName)) AS min_len,
    MAX(LEN(CustomerName)) AS max_len,
    AVG(CAST(LEN(CustomerName) AS decimal(10, 2))) AS avg_len,
    SUM(CASE WHEN CustomerName = '' THEN 1 ELSE 0 END) AS empty_count,
    SUM(CASE WHEN DATALENGTH(CustomerName) <> DATALENGTH(TRIM(CustomerName)) THEN 1 ELSE 0 END) AS untrimmed_count,
    SUM(CASE WHEN CustomerName COLLATE Latin1_General_CS_AS = UPPER(CustomerName) THEN 1 ELSE 0 END) AS all_upper,
    SUM(CASE WHEN CustomerName COLLATE Latin1_General_CS_AS = LOWER(CustomerName) THEN 1 ELSE 0 END) AS all_lower
FROM dbo.Customers;
```

Note: `LEN` and `=` both ignore trailing spaces (ANSI padding) — use `DATALENGTH` to detect leading/trailing whitespace. Case checks need a case-sensitive `COLLATE` because the default collation is usually case-insensitive. For format checks, use `LIKE` patterns (`Phone LIKE '%[^0-9+ -]%'` finds invalid characters) or `TRY_CAST` — there are no regex functions in SQL Server 2022.

**Date/timestamp columns:**

```sql
SELECT
    MIN(OrderDate) AS min_date,
    MAX(OrderDate) AS max_date,
    SUM(CASE WHEN OrderDate IS NULL THEN 1 ELSE 0 END) AS null_dates,
    SUM(CASE WHEN OrderDate > SYSDATETIME() THEN 1 ELSE 0 END) AS future_dates,
    SUM(CASE WHEN OrderDate < '2000-01-01' THEN 1 ELSE 0 END) AS suspicious_old   -- 1900-01-01 is a common default
FROM dbo.Orders;

-- Distribution by month
SELECT DATETRUNC(month, OrderDate) AS month_start, COUNT_BIG(*) AS n
FROM dbo.Orders
GROUP BY DATETRUNC(month, OrderDate)
ORDER BY month_start;

-- Gaps in a daily series (GENERATE_SERIES needs compatibility level 160)
WITH bounds AS (SELECT CAST(MIN(OrderDate) AS date) AS d0, CAST(MAX(OrderDate) AS date) AS d1 FROM dbo.Orders),
calendar AS (
    SELECT DATEADD(day, s.value, b.d0) AS d
    FROM bounds AS b
    CROSS APPLY GENERATE_SERIES(0, DATEDIFF(day, b.d0, b.d1)) AS s
)
SELECT TOP (100) c.d AS missing_date
FROM calendar AS c
WHERE NOT EXISTS (SELECT 1 FROM dbo.Orders AS o
                  WHERE o.OrderDate >= c.d AND o.OrderDate < DATEADD(day, 1, c.d))
ORDER BY c.d;
```

**Boolean (`bit`) columns:**

```sql
SELECT
    SUM(CASE WHEN IsActive = 1 THEN 1 ELSE 0 END) AS true_count,
    SUM(CASE WHEN IsActive = 0 THEN 1 ELSE 0 END) AS false_count,
    SUM(CASE WHEN IsActive IS NULL THEN 1 ELSE 0 END) AS null_count,
    AVG(CAST(IsActive AS decimal(5, 4))) AS true_rate
FROM dbo.Customers;
```

**Present the profile as a clean summary table**, grouped by column type (dimensions, metrics, dates, IDs).

### 4. Identify Data Quality Issues

Apply the quality assessment framework below. Flag potential problems:

- **High null rates**: Columns with >5% nulls (warn), >20% nulls (alert)
- **Low cardinality surprises**: Columns that should be high-cardinality but aren't (e.g., a `CustomerId` with only 50 distinct values)
- **High cardinality surprises**: Columns that should be categorical but have too many distinct values
- **Suspicious values**: Negative amounts where only positive expected, future dates in historical data, SQL Server default dates (`1900-01-01`, `1753-01-01`, `9999-12-31`), placeholder values ("N/A", "-", "TBD", "test", "999999")
- **Duplicate detection**: Check whether the natural key is unique:
  ```sql
  SELECT TOP (20) InvoiceNo, COUNT_BIG(*) AS n
  FROM dbo.Invoices GROUP BY InvoiceNo HAVING COUNT_BIG(*) > 1 ORDER BY n DESC;
  ```
- **Distribution skew**: Extremely skewed numeric distributions that could affect averages
- **Encoding issues**: Mixed case in categorical fields, trailing whitespace, `varchar` columns holding `?` where non-Latin characters were lost, inconsistent formats
- **Type issues**: Numbers or dates stored as `varchar` (find bad rows with `TRY_CAST(col AS ...) IS NULL AND col IS NOT NULL`)

### 5. Discover Relationships and Patterns

After profiling individual columns:

- **Declared foreign keys**: query `sys.foreign_keys` (see `tsql-queries`, "Catalog Queries")
- **Foreign key candidates**: ID/code columns that match names and types in other tables — verify with an orphan check (`NOT EXISTS`)
- **Hierarchies**: Columns that form natural drill-down paths (region > branch > outlet, province > city)
- **Correlations**: Numeric columns that move together
- **Derived columns**: Computed columns (`sys.computed_columns`) or columns that appear computed from others
- **Redundant columns**: Columns with identical or near-identical information

### 6. Suggest Interesting Dimensions and Metrics

Based on the column profile, recommend:

- **Best dimension columns** for slicing data (categorical columns with reasonable cardinality, 3-50 values)
- **Key metric columns** for measurement (numeric columns with meaningful distributions)
- **Time columns** suitable for trend analysis
- **Natural groupings** or hierarchies apparent in the data
- **Potential join keys** linking to other tables

### 7. Recommend Follow-Up Analyses

Suggest 3-5 specific analyses the user could run next:

- "Trend analysis on [metric] by [time_column] grouped by [dimension]"
- "Distribution deep-dive on [skewed_column] to understand outliers"
- "Data quality investigation on [problematic_column]"
- "Correlation analysis between [metric_a] and [metric_b]"
- "Cohort analysis using [date_column] and [status_column]"

## Output Format

```
## Data Profile: [schema.table_name]

### Overview
- Rows: 2,340,891 (reserved 812 MB)
- Columns: 23 (8 dimensions, 6 metrics, 4 dates, 5 IDs)
- Date range: 2021-03-15 to 2025-10-31
- Primary key: OrderId (unique) | Sampled: no

### Column Details
[summary table]

### Data Quality Issues
[flagged issues with severity]

### Recommended Explorations
[numbered list of suggested follow-up analyses]
```

---

## Quality Assessment Framework

### Completeness Score

Rate each column:
- **Complete** (>99% non-null): Green
- **Mostly complete** (95-99%): Yellow -- investigate the nulls
- **Incomplete** (80-95%): Orange -- understand why and whether it matters
- **Sparse** (<80%): Red -- may not be usable without imputation

### Consistency Checks

Look for:
- **Value format inconsistency**: Same concept represented differently ("Jakarta", "JKT", "DKI Jakarta", "jakarta")
- **Type inconsistency**: Numbers stored as strings, dates in various formats in `varchar` columns
- **Referential integrity**: Foreign keys that don't match any parent record (common where no FK constraint is declared)
- **Business rule violations**: Negative quantities, end dates before start dates, percentages > 100
- **Cross-column consistency**: Status = 'COMPLETED' but CompletedAt is null

### Accuracy Indicators

Red flags that suggest accuracy issues:
- **Placeholder values**: 0, -1, 999999, "N/A", "-", "TBD", "test", "xxx"
- **Default values**: Suspiciously high frequency of a single value (often a column `DEFAULT` constraint — check `sys.default_constraints`)
- **Stale data**: Max of update timestamps shows no recent changes in an active system
- **Impossible values**: Ages > 150, dates in the far future, negative durations
- **Round number bias**: All values ending in 0 or 5 (suggests estimation, not measurement)

### Timeliness Assessment

- When was the table last updated?
- What is the expected update frequency (real-time OLTP, nightly ETL/SSIS job, monthly closing)?
- Is there a lag between event time and load time?
- Are there gaps in the time series?

## Pattern Discovery Techniques

### Distribution Analysis

For numeric columns, characterize the distribution:
- **Normal**: Mean and median are close, bell-shaped
- **Skewed right**: Long tail of high values (common for revenue, transaction size)
- **Skewed left**: Long tail of low values (less common)
- **Bimodal**: Two peaks (suggests two distinct populations)
- **Power law**: Few very large values, many small ones (common for customer activity)
- **Uniform**: Roughly equal frequency across range (often synthetic or random)

Histogram buckets in T-SQL:

```sql
SELECT FLOOR(TotalAmount / 100000) * 100000 AS bucket_start, COUNT_BIG(*) AS n
FROM dbo.Orders
GROUP BY FLOOR(TotalAmount / 100000) * 100000
ORDER BY bucket_start;
```

### Temporal Patterns

For time series data, look for:
- **Trend**: Sustained upward or downward movement
- **Seasonality**: Repeating patterns (weekly, monthly, quarterly, annual)
- **Day-of-week effects**: Weekday vs. weekend (`DATENAME(weekday, d)`; `DATEPART(weekday, d)` depends on `DATEFIRST`)
- **Holiday effects**: Drops or spikes around known holidays (Lebaran, year-end, payday dates)
- **Change points**: Sudden shifts in level or trend
- **Anomalies**: Individual data points that break the pattern

### Segmentation Discovery

Identify natural segments by:
- Finding categorical columns with 3-20 distinct values
- Comparing metric distributions across segment values
- Looking for segments with significantly different behavior
- Testing whether segments are homogeneous or contain sub-segments

### Correlation Exploration

Between numeric columns:
- Compute correlations in Python on an aggregated or sampled extract (T-SQL has no `CORR` function)
- Flag strong correlations (|r| > 0.7) for investigation
- Note: Correlation does not imply causation -- flag this explicitly
- Check for non-linear relationships (e.g., quadratic, logarithmic)

## Schema Understanding and Documentation

### Schema Documentation Template

When documenting a table for team use:

```markdown
## Table: [database.schema.table_name]

**Description**: [What this table represents]
**Grain**: [One row per...]
**Primary Key**: [column(s)]
**Row Count**: [approximate, with date]
**Update Frequency**: [real-time / hourly / nightly ETL / monthly]
**Owner**: [team or person responsible]

### Key Columns

| Column | Type | Description | Example Values | Notes |
|--------|------|-------------|----------------|-------|
| CustomerId | int | Unique customer identifier | 10234 | FK to dbo.Customers |
| Status | varchar(20) | Order status | 'NEW', 'PAID', 'CANCELLED' | 6 distinct values |
| TotalAmount | decimal(18,2) | Order total in IDR | 150000.00 | Excludes tax |
| OrderDate | datetime2(0) | When the order was placed | 2025-01-15 14:23:01 | Server local time (WIB) |

### Relationships
- Joins to `dbo.Customers` on `CustomerId`
- Parent of `dbo.OrderLines` (1:many on `OrderId`)

### Known Issues
- [List any known data quality issues]
- [Note any gotchas for analysts]

### Common Query Patterns
- [Typical use cases for this table]
```

### Schema Exploration Queries

Prefer `search_objects`; for anything it doesn't return, use the catalog views:

```sql
-- Tables and views in a schema
SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = 'dbo'
ORDER BY TABLE_NAME;

-- Column details
SELECT c.name AS column_name, ty.name AS data_type, c.max_length, c.precision, c.scale,
       c.is_nullable, c.is_identity, c.is_computed, dc.definition AS default_value
FROM sys.columns AS c
JOIN sys.types AS ty ON ty.user_type_id = c.user_type_id
LEFT JOIN sys.default_constraints AS dc ON dc.object_id = c.default_object_id
WHERE c.object_id = OBJECT_ID('dbo.Orders')
ORDER BY c.column_id;
```

For row counts, sizes, foreign keys and descriptions, see "Catalog Queries" in the `tsql-queries` skill.

### Lineage and Dependencies

When exploring an unfamiliar database:

1. Start with the "output" objects (reporting views, tables used by SSRS/Power BI reports)
2. Trace upstream with `sys.sql_expression_dependencies`:
   ```sql
   SELECT OBJECT_SCHEMA_NAME(referencing_id) + '.' + OBJECT_NAME(referencing_id) AS referencing_object,
          referenced_schema_name + '.' + referenced_entity_name AS referenced_object
   FROM sys.sql_expression_dependencies
   WHERE referencing_id = OBJECT_ID('rpt.vw_MonthlySales');
   ```
3. Identify raw/staging/mart layers (often separate schemas or databases)
4. Map the transformation chain (views, stored procedures, SSIS/Agent jobs feeding tables)
5. Note where data is enriched, filtered, or aggregated

## Tips

- For very large tables, profile a recent date range or use `TABLESAMPLE` and state that it is sampled -- mention if you need exact counts
- Profiling heavy tables on a production OLTP server can affect users; prefer off-peak hours or a reporting replica
- If exploring a new table for the first time, this command gives you the lay of the land before writing specific queries
- The quality flags are heuristic -- not every flag is a real problem, but each is worth a quick look
