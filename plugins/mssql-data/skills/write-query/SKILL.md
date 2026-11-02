---
name: write-query
description: Write optimized T-SQL for SQL Server 2022 with best practices. Use when translating a natural-language data need into T-SQL, building a multi-CTE query with joins and aggregations, optimizing a slow query against a large table, or checking a query's execution plan.
argument-hint: "<description of what data you need>"
---

# /write-query - Write Optimized T-SQL (SQL Server 2022)

Write a T-SQL query from a natural language description, optimized for SQL Server 2022 and following best practices. The dialect is always T-SQL — never ask which database the user has.

## Usage

```
/write-query <description of what data you need>
```

## Workflow

### 1. Understand the Request

Parse the user's description to identify:

- **Output columns**: What fields should the result include?
- **Filters**: What conditions limit the data (date ranges, branches, statuses)?
- **Aggregations**: Are there GROUP BY operations, counts, sums, averages?
- **Joins**: Does this require combining multiple tables?
- **Ordering**: How should results be sorted?
- **Limits**: Is there a top-N or sample requirement? (`TOP (n)`, `OFFSET ... FETCH`)
- **Purpose**: Ad-hoc analysis run through Claude (must be read-only) or a script the user will deploy themselves (view, stored procedure, report query)

### 2. Check the Environment (Once per Session)

If not already known, run the environment query from the `tsql-queries` skill to learn the compatibility level and collation. At compatibility level < 160, avoid `GENERATE_SERIES` and the `WINDOW` clause.

### 3. Discover Schema

With the `dbhub` MCP server connected:

1. Search for relevant tables and views with `search_objects` (follow `schema-discovery`: names → summary → full)
2. Inspect column names, data types (`varchar` vs `nvarchar`, `datetime` vs `datetime2` vs `date`) and nullability
3. Check indexes on large tables (`object_type: "index"`) so filters and joins can use them
4. Look for existing reporting views (`vw_*`, `rpt.*`) that already encode business logic

Without a connection, ask the user for table/column names or write the query against clearly marked placeholder names.

### 4. Write the Query

Follow these best practices (details in the `tsql-queries` skill):

**Structure:**
- Use CTEs (`WITH`) for readability when queries have multiple logical steps
- One CTE per logical transformation or data source; name CTEs descriptively (`daily_sales`, `active_customers`)
- Always schema-qualify objects (`dbo.Orders`, `sales.Invoice`)
- For queries Claude will run: one statement starting with `SELECT` or `WITH` — no `DECLARE`, temp tables, or `EXEC`. Put parameters in a `params` CTE
- For scripts the user will deploy: `DECLARE` variables, temp tables and `CREATE VIEW` are fine, but say clearly that the user must run them

**Performance:**
- Never `SELECT *` in production queries -- specify only needed columns
- Sargable filters: half-open date ranges (`>= '2025-01-01' AND < '2025-02-01'`), no functions on indexed columns
- Match literal types to column types (`N'...'` for `nvarchar`) to avoid `CONVERT_IMPLICIT`
- Prefer `EXISTS` over `IN` for subqueries; never `NOT IN` against a nullable column
- Use appropriate JOIN types (don't use LEFT JOIN when INNER JOIN is correct)
- Use window functions or `CROSS APPLY` instead of correlated subqueries
- Be mindful of exploding joins (many-to-many)
- Use `APPROX_COUNT_DISTINCT` / `APPROX_PERCENTILE_CONT` on very large tables when exact values aren't required

**SQL Server 2022 features to prefer when they simplify the query:**
- `DATETRUNC`, `DATE_BUCKET` for period grouping
- `GENERATE_SERIES` for date spines and gap filling
- `GREATEST` / `LEAST` for row-wise max/min
- `IS [NOT] DISTINCT FROM` for NULL-safe comparisons
- `WINDOW` clause when several window functions share a frame
- `STRING_SPLIT(..., 1)` with ordinal, `LTRIM`/`RTRIM` with characters, `JSON_OBJECT` / `JSON_ARRAY`

**Readability:**
- Add comments explaining the "why" for non-obvious logic
- Consistent indentation; each major clause on its own line
- Alias tables with meaningful short names (`o` for Orders, `c` for Customers)
- Use `AS` for column and table aliases

### 5. Check the Plan (For Performance-Critical Queries)

For queries over large tables, run `explain_sql` (no `EXPLAIN` prefix — the tool adds it) and review the estimated plan: scans on large tables, key lookups, implicit conversions, missing-index hints. Adjust the query before running it.

### 6. Present the Query

Provide:

1. **The complete query** in a `sql` code block
2. **Brief explanation** of what each CTE or section does
3. **Performance notes** if relevant (indexes used, expected scans, plan findings)
4. **Modification suggestions** -- how to adjust for common variations (different date range, granularity, additional filters)

### 7. Offer to Execute

If `dbhub` is connected and the query is read-only, offer to run it with `execute_sql` and analyze the results. Otherwise it's ready to paste into SSMS or Azure Data Studio.

## Examples

**Simple aggregation:**
```
/write-query Jumlah order per status untuk 30 hari terakhir
```

**Complex analysis:**
```
/write-query Cohort retention -- group customers by first-order month, show the % that ordered again 1, 3, 6, and 12 months later
```

**Performance-critical:**
```
/write-query dbo.SalesDetail has 300M rows with a clustered index on (TransDate, BranchId). Find the top 100 products by revenue in the last 7 days per branch.
```

## Tips

- If you know the table names (with schema), include them -- otherwise Claude will find them
- Say whether the query must be idempotent or will become a view/stored procedure
- For recurring reports, mention if it should be parameterized by date range
