---
name: mssql-setup
description: Connect the plugin to an internal SQL Server 2022 instance or fix a failing connection. Use when setting up the DSN, troubleshooting login/SSL/instance/firewall errors, creating a read-only login, or moving to multiple databases or write access with a custom DBHub config.
argument-hint: "[error message or what you want to set up]"
---

# /mssql-setup - Connect to SQL Server 2022

The connection string (DSN) is entered in the plugin's configuration dialog and stored in Claude Code's secure storage. The plugin runs DBHub locally over stdio: this machine connects **directly** to the SQL Server, so the server must be reachable from here (office network or VPN). Nothing goes through a cloud service.

The plugin is read-only, caps results at 1000 rows and times out queries after 60 seconds.

## 1. Build the DSN

```
sqlserver://<user>:<password>@<host>:<port>/<database>?sslmode=<mode>
```

| Situation | DSN |
|-----------|-----|
| SQL login, default instance | `sqlserver://report_ro:secret@10.10.1.20:1433/SalesDB?sslmode=require` |
| Named instance | `sqlserver://report_ro:secret@sqlsrv01:1433/SalesDB?sslmode=require&instanceName=PROD` |
| Windows / Active Directory login (NTLM) | `sqlserver://jdoe:secret@sqlsrv01.corp.local:1433/SalesDB?sslmode=require&authentication=ntlm&domain=CORP` |

**`sslmode` for SQL Server:**
- `require` — encrypt, trust the server certificate. Use this for typical internal servers with a self-signed certificate.
- `verify-full` — encrypt and validate the certificate. Use when the server has a certificate from your internal CA that this machine trusts.
- `disable` — no encryption. Only for isolated dev/test instances.

**Password special characters must be URL-encoded:** `@` → `%40`, `:` → `%3A`, `/` → `%2F`, `#` → `%23`, `?` → `%3F`, `%` → `%25`, `&` → `%26`, space → `%20`.

**Named instances:** the SQL Server Browser service (UDP 1434) must be reachable, or use the instance's fixed TCP port directly in the DSN and drop `instanceName`.

Never ask the user to paste the password into the chat. Point them at the configuration dialog: run `/plugin`, open **mssql-data** → configuration, set the DSN, then reconnect with `/mcp` (reconnect `dbhub`) or restart Claude Code.

## 2. Recommend a Read-Only Login

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

For Windows authentication, replace `CREATE LOGIN ... WITH PASSWORD` with `CREATE LOGIN [CORP\svc_report] FROM WINDOWS`.

## 3. Verify the Connection

Once reconnected, run through the MCP tools (not the shell):

```sql
SELECT @@SERVERNAME AS server_name,
       SERVERPROPERTY('ProductVersion') AS product_version,   -- should start with 16. (SQL Server 2022)
       SERVERPROPERTY('Edition') AS edition,
       DB_NAME() AS current_db,
       SUSER_SNAME() AS login_name;
```

If `product_version` does not start with `16.`, warn the user: this plugin's guidance targets SQL Server 2022 and some functions (`DATETRUNC`, `GENERATE_SERIES`, `GREATEST`, `IS DISTINCT FROM`, `APPROX_PERCENTILE_CONT`) will not exist on older versions.

Also check `compatibility_level` in `sys.databases` — 160 enables the full SQL Server 2022 feature set.

## 4. Troubleshooting

Test the DSN outside Claude Code (redact the password in anything shown in chat):

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"setup-check","version":"0"}}}' \
  | MSSQL_DSN='<dsn>' npx -y @bytebase/dbhub@1.5.0 --transport stdio --config "<plugin-root>/dbhub.toml"
```

A JSON `initialize` response means DBHub started. The connection itself is lazy, so also run the verification query above.

| Symptom | Likely cause / fix |
|---------|--------------------|
| `Failed to connect ... in 15000ms` / `ETIMEOUT` / `ESOCKET` | Host/port unreachable: VPN off, firewall blocking TCP 1433, wrong port for a named instance. Test with `nc -vz <host> 1433`. |
| `Login failed for user` | Wrong user/password, password not URL-encoded, SQL authentication disabled on the server (Windows-only mode), or the login has no user in that database. |
| `Cannot open database "X" requested by the login` | The login exists but has no user mapped in that database, or the database name is wrong. |
| `self signed certificate` / `certificate verify failed` | Use `sslmode=require` instead of `verify-full`, or install the internal CA certificate. |
| `Failed to lookup instance` | SQL Server Browser stopped or UDP 1434 blocked — use the instance's TCP port and drop `instanceName`. |
| NTLM login fails | Check `domain=` (NetBIOS name, e.g. `CORP`), username without the domain prefix, and that the account is allowed on the server. |
| `sh: dbhub: command not found` | Corrupted npx cache: remove the `@bytebase/dbhub` entry under `~/.npm/_npx/*/`, then reconnect. |
| Server never starts | Requires Node.js >= 22.5.0 (`node --version`). |

## 5. When the Plugin Is Not Enough

The plugin covers one database, read-only. For several databases/servers (e.g. `SalesDB` + `HRDB`, or PROD + a reporting replica), SSH tunnels, write access, or saved custom queries, register DBHub directly with your own TOML. A template ships with this plugin at `templates/dbhub.multi-source.toml` — offer to fill it in, then:

```bash
claude mcp add dbhub-mssql -- npx -y @bytebase/dbhub@1.5.0 --transport stdio --config /path/to/dbhub.toml
```

Keep passwords out of the TOML with `${ENV_VAR}` interpolation, and disable this plugin's built-in `dbhub` server afterwards (`/plugin` → **mssql-data**) to avoid two overlapping instances.
