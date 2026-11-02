---
name: data-context-extractor
description: >
  Generate or improve a company-specific data analysis skill by extracting tribal knowledge from analysts.

  BOOTSTRAP MODE - Triggers: "Create a data context skill", "Set up data analysis for our SQL Server database",
  "Help me create a skill for our database", "Generate a data skill for [company]"
  → Discovers schemas, asks key questions, generates initial skill with reference files

  ITERATION MODE - Triggers: "Add context about [domain]", "The skill needs more info about [topic]",
  "Update the data skill with [metrics/tables/terminology]", "Improve the [domain] reference"
  → Loads existing skill, asks targeted questions, appends/updates reference files

  Use when data analysts want Claude to understand their company's specific SQL Server 2022 databases,
  terminology, metrics definitions, and common query patterns.
---

# Data Context Extractor

A meta-skill that extracts company-specific knowledge about the internal SQL Server 2022 databases from analysts and generates tailored data analysis skills.

## How It Works

This skill has two modes:

1. **Bootstrap Mode**: Create a new data analysis skill from scratch
2. **Iteration Mode**: Improve an existing skill by adding domain-specific reference files

---

## Bootstrap Mode

Use when: User wants to create a new data context skill for their SQL Server database.

### Phase 1: Database Connection & Discovery

**Step 1: Confirm the connection and environment**

The database is always SQL Server 2022, reached through the plugin's `dbhub` MCP server (read-only). If the tools are missing, add the server with `/mssql-data:add-server`; if they fail, use `/mssql-data:mssql-setup`. With several servers configured, ask which server (and database) the skill is for.

Run the environment check from the `tsql-queries` skill and record: server name, database name, product version (16.x), compatibility level, collation, and whether Query Store is on. Ask whether analysts also use other databases on the same server — each one may need its own domain file.

**Step 2: Explore the schema**

Use `search_objects` (follow the `schema-discovery` skill) to:
1. List schemas (`object_type: "schema"`) and tables/views per schema (`detail_level: "names"`)
2. Identify the most important tables (ask user: "Which 3-5 tables or views do analysts query most often?")
3. Pull `full` detail for those key tables

Supporting catalog queries (via `execute_sql`):
```sql
-- Largest tables (where the important data usually lives)
SELECT TOP (30) s.name AS schema_name, t.name AS table_name,
       SUM(CASE WHEN p.index_id IN (0, 1) THEN p.row_count END) AS row_count
FROM sys.tables AS t
JOIN sys.schemas AS s ON s.schema_id = t.schema_id
JOIN sys.dm_db_partition_stats AS p ON p.object_id = t.object_id
GROUP BY s.name, t.name
ORDER BY row_count DESC;

-- Existing documentation in MS_Description extended properties
SELECT OBJECT_SCHEMA_NAME(ep.major_id) AS schema_name, OBJECT_NAME(ep.major_id) AS object_name,
       COL_NAME(ep.major_id, ep.minor_id) AS column_name, CAST(ep.value AS nvarchar(4000)) AS description
FROM sys.extended_properties AS ep
WHERE ep.name = 'MS_Description' AND ep.class = 1;

-- Declared relationships
SELECT OBJECT_NAME(fk.parent_object_id) AS child_table, OBJECT_NAME(fk.referenced_object_id) AS parent_table, fk.name
FROM sys.foreign_keys AS fk;

-- Reporting views and their definitions often encode the "official" business logic
SELECT s.name AS schema_name, v.name AS view_name
FROM sys.views AS v JOIN sys.schemas AS s ON s.schema_id = v.schema_id
ORDER BY s.name, v.name;
```

Read the definitions of key reporting views with `SELECT OBJECT_DEFINITION(OBJECT_ID('schema.view'))` — they reveal standard filters and metric formulas that analysts may forget to mention.

### Phase 2: Core Questions (Ask These)

After schema discovery, ask these questions conversationally (not all at once):

**Entity Disambiguation (Critical)**
> "When people here say 'user' or 'customer', what exactly do they mean? Are there different types?"

Listen for:
- Multiple entity types (user vs account vs organization)
- Relationships between them (1:1, 1:many, many:many)
- Which ID fields link them together

**Primary Identifiers**
> "What's the main identifier for a [customer/user/account]? Are there multiple IDs for the same entity?"

Listen for:
- Primary keys vs business keys
- UUID vs integer IDs
- Legacy ID systems

**Key Metrics**
> "What are the 2-3 metrics people ask about most? How is each one calculated?"

Listen for:
- Exact formulas (ARR = monthly_revenue × 12)
- Which tables/columns feed each metric
- Time period conventions (trailing 7 days, calendar month, etc.)

**Data Hygiene**
> "What should ALWAYS be filtered out of queries? (test data, fraud, internal users, etc.)"

Listen for:
- Standard WHERE clauses to always include
- Flag columns that indicate exclusions (is_test, is_internal, is_fraud)
- Specific values to exclude (status = 'deleted')

**Common Gotchas**
> "What mistakes do new analysts typically make with this data?"

Listen for:
- Confusing column names
- Timezone issues (server local time WIB vs UTC columns)
- `datetime` vs `date` columns and `BETWEEN` end-of-day mistakes
- Default/placeholder dates (`1900-01-01`) and soft-delete flags (`IsDeleted`, `StatusAktif`)
- NULL handling quirks
- Historical vs current state tables

### Phase 3: Generate the Skill

Create a skill with this structure:

```
[company]-data-analyst/
├── SKILL.md
└── references/
    ├── entities.md          # Entity definitions and relationships
    ├── metrics.md           # KPI calculations
    ├── tables/              # One file per domain
    │   ├── [domain1].md
    │   └── [domain2].md
    └── dashboards.json      # Optional: existing dashboards catalog
```

**SKILL.md Template**: See `references/skill-template.md`

**SQL Dialect Section**: Copy the block from `references/tsql-dialect.md` and fill in the server, database, compatibility level, collation and time-zone values discovered in Phase 1.

**Reference File Template**: See `references/domain-template.md`

### Phase 4: Install and Deliver

1. Create all files in the skill directory. In Claude Code, the generated skill is picked up automatically from:
   - `.claude/skills/[company]-data-analyst/` in the user's project (shared with the team via git), or
   - `~/.claude/skills/[company]-data-analyst/` for personal use
   Ask which location they want.
2. Optionally package it as a zip for sharing: `python3 "${CLAUDE_PLUGIN_ROOT}/skills/data-context-extractor/scripts/package_data_skill.py" <skill-folder> [output-dir]`
3. Never include credentials, connection strings, or real personal data (names, NIK, phone numbers) in the generated files — use column names and synthetic example values only
4. Present to user with a summary of what was captured

---

## Iteration Mode

Use when: User has an existing skill but needs to add more context.

### Step 1: Load Existing Skill

Ask user to upload their existing skill (zip or folder), or locate it if already in the session.

Read the current SKILL.md and reference files to understand what's already documented.

### Step 2: Identify the Gap

Ask: "What domain or topic needs more context? What queries are failing or producing wrong results?"

Common gaps:
- A new data domain (marketing, finance, product, etc.)
- Missing metric definitions
- Undocumented table relationships
- New terminology

### Step 3: Targeted Discovery

For the identified domain:

1. **Explore relevant tables**: Use `search_objects` (and catalog queries via `execute_sql`) to find tables in that domain
2. **Ask domain-specific questions**:
   - "What tables are used for [domain] analysis?"
   - "What are the key metrics for [domain]?"
   - "Any special filters or gotchas for [domain] data?"

3. **Generate new reference file**: Create `references/[domain].md` using the domain template

### Step 4: Update and Repackage

1. Add the new reference file
2. Update SKILL.md's "Knowledge Base Navigation" section to include the new domain
3. Repackage the skill if it is shared as a zip
4. Present the updated skill to user

---

## Reference File Standards

Each reference file should include:

### For Table Documentation
- **Location**: Full table path
- **Description**: What this table contains, when to use it
- **Primary Key**: How to uniquely identify rows
- **Update Frequency**: How often data refreshes
- **Key Columns**: Table with column name, type, description, notes
- **Relationships**: How this table joins to others
- **Sample Queries**: 2-3 common query patterns

### For Metrics Documentation
- **Metric Name**: Human-readable name
- **Definition**: Plain English explanation
- **Formula**: Exact calculation with column references
- **Source Table(s)**: Where the data comes from
- **Caveats**: Edge cases, exclusions, gotchas

### For Entity Documentation
- **Entity Name**: What it's called
- **Definition**: What it represents in the business
- **Primary Table**: Where to find this entity
- **ID Field(s)**: How to identify it
- **Relationships**: How it relates to other entities
- **Common Filters**: Standard exclusions (internal, test, etc.)

---

## Quality Checklist

Before delivering a generated skill, verify:

- [ ] SKILL.md has complete frontmatter (name, description)
- [ ] Entity disambiguation section is clear
- [ ] Key terminology is defined
- [ ] Standard filters/exclusions are documented
- [ ] At least 2-3 sample queries per domain
- [ ] SQL uses correct T-SQL / SQL Server 2022 syntax (no `LIMIT`, `ILIKE`, `::`, `DATE_TRUNC('month', ...)`)
- [ ] Sample queries are single `SELECT`/`WITH` statements runnable through DBHub read-only mode
- [ ] No credentials or real personal data in any file
- [ ] Reference files are linked from SKILL.md navigation section
