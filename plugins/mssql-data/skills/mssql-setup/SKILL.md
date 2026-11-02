---
name: mssql-setup
description: Prepare and troubleshoot the connections between the mssql-data plugin and internal SQL Server 2022 instances. Use when creating a read-only login for the plugin, checking that a configured server works, or fixing login, SSL, named-instance, firewall, or missing-tool problems.
argument-hint: "[server name or error message]"
---

# /mssql-setup - Connect and Troubleshoot SQL Server 2022

## How Connections Work

- Servers are added **after** installation with `/mssql-data:add-server` and managed with `/mssql-data:manage-servers`. Nothing is configured at install time, and any number of servers can be active at once.
- The server list is `~/.config/mssql-data/servers.json` (no passwords). Passwords are in the macOS Keychain (service `mssql-data`, one item per server).
- When a Claude Code session starts, the plugin's `dbhub` MCP server generates a DBHub configuration from that list: one read-only source per server, max 1000 rows per query, 60 s query timeout. The generated configuration contains no passwords; DBHub receives them through environment variables. **Changes take effect in the next session.**
- With one server the tools are `execute_sql`, `search_objects`, `explain_sql`, `health_check`; with several, every tool gets the server name as suffix (`execute_sql_sales`, ...). With no server configured, `dbhub` starts without tools and its instructions point to `/mssql-data:add-server`.
- DBHub runs locally over stdio and connects **directly** from this machine to SQL Server, so the server must be reachable from here (office network or VPN). Nothing goes through a cloud service.

To see what is configured (never shows passwords):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mssql-servers.mjs" list
```

## 1. Recommend a Read-Only Login

Defense in depth: the plugin enforces read-only, but the login should too. Give the DBA this script to run in SSMS (the plugin cannot run it):

```sql
-- On the server
CREATE LOGIN report_ro WITH PASSWORD = '<strong password>', CHECK_POLICY = ON;

-- In each database Claude may read
USE SalesDB;
CREATE USER report_ro FOR LOGIN report_ro;
ALTER ROLE db_datareader ADD MEMBER report_ro;
GRANT VIEW DEFINITION TO report_ro;                 -- view/procedure definitions for schema discovery
GRANT SHOWPLAN TO report_ro;                        -- needed by explain_sql
GRANT VIEW DATABASE PERFORMANCE STATE TO report_ro; -- Query Store / DMV-based analysis (SQL Server 2022)

-- Optional, server level: health_check metrics and server DMVs
USE master;
GRANT VIEW SERVER PERFORMANCE STATE TO report_ro;   -- SQL Server 2022 granular permission
```

For Windows authentication, replace `CREATE LOGIN ... WITH PASSWORD` with `CREATE LOGIN [CORP\svc_report] FROM WINDOWS`, and add the server with `--auth ntlm --domain CORP`.

## 2. Verify a Server

In a session started after the server was added, run this through that server's tool (`execute_sql`, or `execute_sql_<server>` when several servers are configured):

```sql
SELECT @@SERVERNAME AS server_name,
       SERVERPROPERTY('ProductVersion') AS product_version,   -- should start with 16. (SQL Server 2022)
       SERVERPROPERTY('Edition') AS edition,
       DB_NAME() AS current_db,
       SUSER_SNAME() AS login_name;
```

If `product_version` does not start with `16.`, warn the user: this plugin's guidance targets SQL Server 2022 and some functions (`DATETRUNC`, `GENERATE_SERIES`, `GREATEST`, `IS DISTINCT FROM`, `APPROX_PERCENTILE_CONT`) will not exist on older versions. Also check `compatibility_level` in `sys.databases`: 160 enables the full SQL Server 2022 feature set.

## 3. Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| No database tools at all | No server configured yet, or the session started before it was added: `/mssql-data:add-server`, then a new session. If servers are listed but the tools are still missing, check that `dbhub` is connected (`claude mcp list` in a terminal) and that Node.js >= 22.5 is installed (`node --version`). |
| One server's tools are missing | No password stored for it (`list` shows `password=BELUM ADA`): change the password with `/mssql-data:manage-servers`. |
| `Failed to connect ... in 15000ms` / `ETIMEOUT` / `ESOCKET` | Host or port unreachable: VPN off, firewall blocking TCP 1433, wrong port for a named instance. Test with `nc -vz <host> 1433`, then fix the details with `add ... --replace`. |
| `Login failed for user` | Wrong password (change it with `/mssql-data:manage-servers`), SQL authentication disabled on the server (Windows-only mode: use `--auth ntlm`), or the login has no user in that database. |
| `Cannot open database "X" requested by the login` | The login exists but has no user mapped in that database, or the database name is wrong. |
| `self signed certificate` / `certificate verify failed` | Use `--sslmode require` instead of `verify-full` (`add ... --replace` keeps the password), or install the internal CA certificate. |
| `Failed to lookup instance` | SQL Server Browser stopped or UDP 1434 blocked: use the instance's TCP port as `--port` and drop `--instance`. |
| NTLM login fails | Check `--domain` (NetBIOS name, e.g. `CORP`), the login without the domain prefix, and that the account is allowed on the server. |
| The password dialog does not open | It needs a macOS GUI session. Ask the user to run the same `mssql-servers.mjs` command in a terminal instead: it asks with a hidden prompt. |
| `sh: dbhub: command not found` | Corrupted npx cache: remove the `@bytebase/dbhub` entry under `~/.npm/_npx/*/`, then start a new session. |
| Plugin broken after moving/deleting the local folder | Local-folder installs are read directly from the source folder, so moving or deleting it breaks the plugin (GitHub installs are not affected). Re-add it from the new path: `claude plugin marketplace add "<new path>/mssql-data-marketplace"`, then reinstall. |

To check that the plugin's MCP server starts at all, outside Claude Code:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"check","version":"0"}}}' | node "${CLAUDE_PLUGIN_ROOT}/scripts/start-dbhub.mjs"
```

A JSON `initialize` response means it starts. Connections are opened lazily, so a login problem only shows on the first query.
