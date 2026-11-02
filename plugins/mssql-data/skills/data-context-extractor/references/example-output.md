# Example: Generated Skill

This is an example of what a generated skill looks like after the bootstrap process. This example is for a fictional e-commerce company called "ShopCo" using SQL Server 2022 (database `ShopDW`).

---

## Example SKILL.md

```markdown
---
name: shopco-data-analyst
description: "ShopCo data analysis skill for the ShopDW SQL Server 2022 database. Provides context for querying e-commerce data including customer, order, and product analytics. Use when analyzing ShopCo data for: (1) Revenue and order metrics, (2) Customer behavior and retention, (3) Product performance, or any data questions requiring ShopCo-specific context."
---

# ShopCo Data Analysis

## SQL Dialect: Microsoft SQL Server 2022 (T-SQL)

- **Server / database**: SQLPROD01 / ShopDW, compatibility level 160, collation SQL_Latin1_General_CP1_CI_AS (case-insensitive)
- **Object references**: `core.FctOrders`; cross-database `ShopDW.core.FctOrders`
- **Limiting rows**: `TOP (n)` with `ORDER BY`; no `LIMIT`
- **Safe division**: `x * 1.0 / NULLIF(y, 0)`
- **Date functions**:
  - `DATETRUNC(month, date_col)`
  - `DATEADD(day, -1, date_col)`
  - `DATEDIFF(day, start_date, end_date)`
- **Time zone**: `OrderTimestamp` is stored in UTC; server time is WIB (UTC+7). Convert with `AT TIME ZONE 'UTC' AT TIME ZONE 'SE Asia Standard Time'`
- **Read-only via DBHub**: single `SELECT`/`WITH` statements, max 1000 rows per result

---

## Entity Disambiguation

**"Customer" can mean:**
- **User**: A login account that can browse and save items (core.DimUsers: UserId)
- **Customer**: A user who has made at least one purchase (core.DimCustomers: CustomerId)
- **Account**: A billing entity, can have multiple users in B2B (core.DimAccounts: AccountId)

**Relationships:**
- User → Customer: 1:1 (CustomerId = UserId for purchasers)
- Account → User: 1:many (join on AccountId)

---

## Business Terminology

| Term | Definition | Notes |
|------|------------|-------|
| GMV | Gross Merchandise Value - total order value before returns/discounts | Use for top-line reporting |
| NMV | Net Merchandise Value - GMV minus returns and discounts | Use for actual revenue |
| AOV | Average Order Value - NMV / order count | Exclude $0 orders |
| LTV | Lifetime Value - total NMV per customer since first order | Rolling calc, updates daily |
| CAC | Customer Acquisition Cost - marketing spend / new customers | By cohort month |

---

## Standard Filters

Always apply these filters unless explicitly told otherwise:

```sql
-- Exclude test and internal orders
WHERE OrderStatus <> 'TEST'
  AND CustomerType <> 'INTERNAL'
  AND IsEmployeeOrder = 0

-- Exclude cancelled orders for revenue metrics
  AND OrderStatus NOT IN ('CANCELLED', 'FRAUDULENT')
```

---

## Key Metrics

### Gross Merchandise Value (GMV)
- **Definition**: Total value of all orders placed
- **Formula**: `SUM(OrderTotalGross)`
- **Source**: `core.FctOrders.OrderTotalGross`
- **Time grain**: Daily, aggregated to weekly/monthly
- **Caveats**: Includes orders that may later be cancelled or returned

### Net Revenue
- **Definition**: Actual revenue after returns and discounts
- **Formula**: `SUM(OrderTotalGross - ISNULL(ReturnAmount, 0) - ISNULL(DiscountAmount, 0))`
- **Source**: `core.FctOrders`
- **Caveats**: Returns can occur up to 90 days post-order; use SettledRevenue for finalized numbers

---

## Knowledge Base Navigation

| Domain | Reference File | Use For |
|--------|----------------|---------|
| Orders | `references/orders.md` | Order tables, GMV/NMV calculations |
| Customers | `references/customers.md` | User/customer entities, LTV, cohorts |
| Products | `references/products.md` | Catalog, inventory, categories |

---

## Common Query Patterns

### Daily GMV by Channel
```sql
SELECT
    CAST(OrderTimestamp AS date) AS order_date,
    Channel,
    SUM(OrderTotalGross)         AS gmv,
    COUNT(DISTINCT OrderId)      AS order_count
FROM core.FctOrders
WHERE OrderStatus NOT IN ('TEST', 'CANCELLED', 'FRAUDULENT')
  AND OrderTimestamp >= DATEADD(day, -30, CAST(SYSUTCDATETIME() AS date))
GROUP BY CAST(OrderTimestamp AS date), Channel
ORDER BY order_date DESC, gmv DESC;
```

### Customer Cohort Retention
```sql
WITH cohorts AS (
    SELECT
        CustomerId,
        DATETRUNC(month, FirstOrderDate) AS cohort_month
    FROM core.DimCustomers
),
activity AS (
    SELECT
        c.cohort_month,
        c.CustomerId,
        DATEDIFF(month, c.cohort_month, DATETRUNC(month, o.OrderTimestamp)) AS months_since_first
    FROM cohorts AS c
    JOIN core.FctOrders AS o ON o.CustomerId = c.CustomerId
    WHERE o.OrderStatus NOT IN ('TEST', 'CANCELLED')
)
SELECT cohort_month, months_since_first, COUNT(DISTINCT CustomerId) AS active_customers
FROM activity
GROUP BY cohort_month, months_since_first
ORDER BY cohort_month, months_since_first;
```
```

---

## Example references/orders.md

```markdown
# Orders Tables

Order and transaction data for ShopCo.

---

## Key Tables

### core.FctOrders
**Location**: `ShopDW.core.FctOrders`
**Description**: Fact table of all orders. One row per order.
**Primary Key**: `OrderId`
**Update Frequency**: Hourly SSIS load (15 min lag)
**Clustered Index**: `OrderDate, OrderId`

| Column | Type | Description | Notes |
|--------|------|-------------|-------|
| **OrderId** | bigint | Unique order identifier | |
| **CustomerId** | int | FK to core.DimCustomers | NULL for guest checkout |
| **OrderTimestamp** | datetime2(0) | When order was placed | UTC |
| **OrderDate** | date | Date portion of OrderTimestamp (WIB) | Leading clustered index column |
| **OrderStatus** | varchar(20) | Current status | PENDING, SHIPPED, DELIVERED, CANCELLED, RETURNED |
| **Channel** | varchar(20) | Acquisition channel | WEB, APP, MARKETPLACE |
| **OrderTotalGross** | decimal(18,2) | Pre-discount total (IDR) | |
| **DiscountAmount** | decimal(18,2) | Total discounts applied | |
| **ReturnAmount** | decimal(18,2) | Value of returned items | Updates async, NULL if none |

**Relationships**:
- Joins to `core.DimCustomers` on `CustomerId`
- Parent of `core.FctOrderItems` via `OrderId`

---

## Sample Queries

### Orders with Returns Rate
```sql
SELECT
    DATETRUNC(iso_week, OrderDate) AS week_start,
    COUNT_BIG(*) AS total_orders,
    SUM(CASE WHEN ReturnAmount > 0 THEN 1 ELSE 0 END) AS orders_with_returns,
    SUM(CASE WHEN ReturnAmount > 0 THEN 1 ELSE 0 END) * 1.0 / NULLIF(COUNT_BIG(*), 0) AS return_rate
FROM core.FctOrders
WHERE OrderStatus NOT IN ('TEST', 'CANCELLED')
  AND OrderDate >= DATEADD(month, -3, CAST(GETDATE() AS date))
GROUP BY DATETRUNC(iso_week, OrderDate)
ORDER BY week_start;
```
```

---

This example demonstrates:
- Complete frontmatter with triggering description
- SQL Server 2022 / T-SQL dialect notes
- Clear entity disambiguation
- Terminology glossary
- Standard filters as copy-paste SQL
- Metric definitions with formulas
- Navigation to reference files
- Real, runnable query examples
