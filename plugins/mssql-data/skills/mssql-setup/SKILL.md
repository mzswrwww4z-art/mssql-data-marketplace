---
name: mssql-setup
description: Prepare and troubleshoot the connections between the mssql-data plugin and internal SQL Server 2022 instances, on Windows or macOS. Use when creating a read-only login for the plugin, checking that a configured server works, or fixing login, default-database, SSL, named-instance, firewall, password-window, or missing-tool problems.
argument-hint: "[server name or error message]"
---

# /mssql-setup - Connect and Troubleshoot SQL Server 2022

## How Connections Work

- Servers are added **after** installation with `/mssql-data:add-server` and managed with `/mssql-data:manage-servers`. Any number of servers can be active at once.
- A server entry has no database: the connection opens in the **login's default database** (often `master`), and Claude reaches other databases on the server with three-part names (`SalesDB.dbo.Orders`).
- The server list (no passwords) is `%LOCALAPPDATA%\mssql-data\servers.json` on Windows and `~/.config/mssql-data/servers.json` on macOS. Passwords are encrypted with Windows DPAPI for the current Windows user (`secrets.dpapi.json` in the same folder) or kept in the macOS Keychain.
- When a Claude Code session starts (CLI or VS Code), the plugin's `dbhub` MCP server generates a DBHub configuration from that list: one read-only source per server, max 1000 rows per query, 60 s query timeout. The generated configuration contains no passwords; DBHub receives them through environment variables. **Changes take effect in the next session.**
- With one server the tools are `execute_sql`, `search_objects`, `explain_sql`, `health_check`; with several, every tool gets the server name as suffix (`execute_sql_sales`, ...). With no server configured, `dbhub` starts without tools and its instructions point to `/mssql-data:add-server`.
- DBHub runs locally and connects **directly** from this laptop to SQL Server, so the server must be reachable from here (office network or VPN). Nothing goes through a cloud service.

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

-- Optional: the database the plugin's connection (and schema search) starts in
ALTER LOGIN report_ro WITH DEFAULT_DATABASE = SalesDB;
```

For Windows authentication, replace `CREATE LOGIN ... WITH PASSWORD` with `CREATE LOGIN [CORP\svc_report] FROM WINDOWS`, and add the server with `--auth ntlm --domain CORP`.

## 2. Verify a Server

In a session started after the server was added, run this through that server's tool (`execute_sql`, or `execute_sql_<server>` when several servers are configured):

```sql
SELECT @@SERVERNAME AS server_name,
       SERVERPROPERTY('ProductVersion') AS product_version,   -- should start with 16. (SQL Server 2022)
       SERVERPROPERTY('Edition') AS edition,
       DB_NAME() AS default_db,
       SUSER_SNAME() AS login_name;
```

If `product_version` does not start with `16.`, warn the user: this plugin's guidance targets SQL Server 2022 and some functions (`DATETRUNC`, `GENERATE_SERIES`, `GREATEST`, `IS DISTINCT FROM`, `APPROX_PERCENTILE_CONT`) will not exist on older versions. Then list the databases the login can open with the query in the `schema-discovery` skill.

## 3. Troubleshooting

Start with the connection test, which shows the exact error from SQL Server or DBHub (Bash timeout 10 minutes):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mssql-servers.mjs" test --id <server>
```

| Symptom | Likely cause / fix |
|---------|--------------------|
| `DBHub tidak merespons dalam ... detik` | The first DBHub download (about 250 MB) did not finish in time; slow networks and antivirus scanning on Windows make it slower. Run the test again: it continues from the npm cache. |
| No database tools at all | No server configured yet, or the session started before it was added: `/mssql-data:add-server`, then a new session. If servers are listed but the tools are still missing, check that `dbhub` is connected (`claude mcp list` in a terminal) and that Node.js >= 22.5 is installed (`node --version`). On Windows, restart VS Code or the terminal after installing Node.js so `node` is on the PATH. |
| One server's tools are missing | No password stored for it (`list` shows `password=BELUM ADA`): change the password with `/mssql-data:manage-servers`. |
| `Failed to connect ... in 15000ms` / `ETIMEOUT` / `ESOCKET` | Host or port unreachable: VPN off, firewall blocking TCP 1433, wrong port for a named instance. Test with `Test-NetConnection <host> -Port 1433` in PowerShell (`nc -vz <host> 1433` on macOS), then fix the details with `add ... --replace`. |
| `Login failed for user` | Wrong password (change it with `/mssql-data:manage-servers`), SQL authentication disabled on the server (Windows-only mode: use `--auth ntlm`), or the account is disabled or locked. |
| `Cannot open user default database` | The login's default database is offline, dropped, or not accessible. Ask the DBA to fix it: `ALTER LOGIN <login> WITH DEFAULT_DATABASE = <database it can open>`. |
| `The server principal ... is not able to access the database "X"` | The login has no user in database X. Ask the DBA to add one (script in section 1). |
| `self signed certificate` / `certificate verify failed` | Use `--sslmode require` instead of `verify-full` (`add ... --replace` keeps the password), or install the internal CA certificate. |
| `Failed to lookup instance` | SQL Server Browser stopped or UDP 1434 blocked: use the instance's TCP port as `--port` and drop `--instance`. |
| NTLM login fails | Check `--domain` (NetBIOS name, e.g. `CORP`), the login without the domain prefix, and that the account is allowed on the server. |
| The password window does not appear (Windows) | It opens on top of other windows; check the taskbar. If PowerShell is blocked by company policy (AppLocker, Constrained Language Mode), the window and the DPAPI encryption cannot run: ask IT to allow `powershell.exe` for your account. As a stopgap, run the `mssql-servers.mjs` command yourself in a terminal so it asks with a hidden prompt; storing the password still needs PowerShell. |
| The password dialog does not appear (macOS) | It needs a GUI session; run the command in a terminal instead (hidden prompt). |
| `dbhub: command not found` or npx errors | Corrupted npx cache: delete the `@bytebase/dbhub` entries under `%LOCALAPPDATA%\npm-cache\_npx` (Windows) or `~/.npm/_npx` (macOS), then start a new session. |
| Plugin broken after moving/deleting the local folder | Local-folder installs are read directly from the source folder, so moving or deleting it breaks the plugin (GitHub installs are not affected). Re-add it from the new path: `claude plugin marketplace add "<new path>/mssql-data-marketplace"`, then reinstall. |

To check that the plugin's MCP server starts at all, outside Claude Code:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"check","version":"0"}}}' | node "${CLAUDE_PLUGIN_ROOT}/scripts/start-dbhub.mjs"
```

A JSON `initialize` response means it starts. Connections are opened lazily, so a login problem only shows on the first query.
