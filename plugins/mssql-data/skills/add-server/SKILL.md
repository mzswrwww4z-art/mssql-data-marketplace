---
name: add-server
description: Add a SQL Server 2022 database server to the mssql-data plugin so Claude can query it. Use when the user wants to connect a new server, add another environment (PROD, staging, a reporting replica), or when no database tools are available yet.
argument-hint: "[server name, host, login]"
---

# /add-server - Add a SQL Server Connection

Adds a server to the plugin's server list. Every server becomes its own read-only DBHub source (max 1000 rows per query, 60 s timeout), so any number of servers can be active at the same time. The list survives plugin updates; passwords are kept apart from it, encrypted with Windows DPAPI on Windows or in the macOS Keychain on macOS.

A server entry has **no database**: the connection opens in the login's default database, and Claude reaches other databases on that server with three-part names (`SalesDB.dbo.Orders`).

## Rules

- **Never ask for, accept, or repeat a password in chat.** The user types it into a password window that the command opens.
- If the user pastes a password into the chat anyway, don't use it. Tell them it was not saved, that it should be treated as exposed (change it if this conversation is shared or synced), and continue with the password window.
- Never pass a password on the command line, and never use `--password-stdin` yourself.

## Workflow

### 1. Collect the connection details

Take what the user already gave (arguments or conversation) and ask only for what is missing, in one short message.

| Field | Option | Default / notes |
|-------|--------|-----------------|
| Server name | `--id` | Short name used in tool names, e.g. `sales`, `hr_prod`: lowercase letters, digits, `_`, starting with a letter |
| Host | `--host` | Hostname or IPv4 address of the SQL Server |
| Port | `--port` | `1433` |
| Login | `--user` | A read-only login is strongly recommended (script in `/mssql-data:mssql-setup`) |
| Authentication | `--auth` | `sql` (SQL login, default) or `ntlm` (Windows/AD account) |
| Domain | `--domain` | Required for `ntlm`, e.g. `CORP`; the login then goes without `CORP\` |
| Named instance | `--instance` | Only for named instances, e.g. `PROD` |
| Encryption | `--sslmode` | `require` (default, works with self-signed certificates on internal servers), `verify-full`, or `disable` |
| Description | `--description` | Optional, one line, e.g. "Production sales (read-only)". Claude sees it when choosing between servers |

If schema search should land in a specific database, the DBA can set it as the login's default database (see `/mssql-data:mssql-setup`).

### 2. Confirm, then run the command

Repeat the details in one line and tell the user: "A password window titled mssql-data will open. Type the password for <login> there." Then run it with a Bash timeout of 10 minutes (600000 ms): the command waits while the window is open, then tests the connection by starting DBHub once, and the very first time that downloads DBHub (about 250 MB), which can take a few minutes, especially on Windows.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mssql-servers.mjs" add --id <id> --host <host> --port <port> --user <login> [--auth ntlm --domain <DOMAIN>] [--instance <NAME>] [--sslmode <mode>] [--description "<text>"]
```

| Exit code | Meaning | Next step |
|-----------|---------|-----------|
| `0` | Saved, and the connection test passed (the output shows the server name, SQL Server version, default database, and login) | Go to step 3 |
| `4` | Saved, but the connection test failed; the output shows SQL Server's or DBHub's error | Explain the error with the troubleshooting table in `/mssql-data:mssql-setup`. Fix details with `--replace` or the password with `/mssql-data:manage-servers`, then rerun the test there |
| `2` | The user cancelled the window or left the password empty; nothing was saved | Ask whether to try again |
| `1` | Invalid input, a server with that name exists, or another error | Show the message and fix the input. To change an existing server's details, run the same command with `--replace` (its password is kept) |

If the command says no password window can be opened (for example PowerShell is blocked by company policy, or there is no desktop session), ask the user to run the same command themselves in a terminal (PowerShell, Command Prompt, or the VS Code terminal): it then asks for the password with a hidden prompt.

### 3. Activate

The server becomes active in the **next** Claude Code session (VS Code: start a new Claude conversation or reload the window; terminal: restart `claude`). Tell the user that, and what to expect there:

- With one server the tools are `execute_sql`, `search_objects`, `explain_sql`, `health_check`.
- With several servers every tool gets the server name as suffix: `execute_sql_<id>`, `search_objects_<id>`, and so on.

The connection test already ran, so the server should work right away in that session.

## Related

- `/mssql-data:manage-servers`: list servers, remove one, change a password or details
- `/mssql-data:mssql-setup`: read-only login script for the DBA, connection troubleshooting
