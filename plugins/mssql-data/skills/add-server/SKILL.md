---
name: add-server
description: Add a SQL Server 2022 database server to the mssql-data plugin so Claude can query it. Use when the user wants to connect a new server or database, add another environment (PROD, staging, a reporting replica), or when no database tools are available yet.
argument-hint: "[server name, host, database, login]"
---

# /add-server - Add a SQL Server Connection

Adds a server to the plugin's server list. Every server becomes its own read-only DBHub source (max 1000 rows per query, 60 s timeout), so any number of servers can be active at the same time. The list is kept in `~/.config/mssql-data/servers.json` (no passwords) and survives plugin updates; passwords go to the macOS Keychain.

## Rules

- **Never ask for, accept, or repeat a password in chat.** The user types it into a macOS password dialog that the command opens.
- If the user pastes a password into the chat anyway, don't use it. Tell them it was not saved, that it should be treated as exposed (change it if this conversation is shared or synced), and continue with the dialog.
- Never pass a password on the command line, and never use `--password-stdin` yourself.

## Workflow

### 1. Collect the connection details

Take what the user already gave (arguments or conversation) and ask only for what is missing, in one short message.

| Field | Option | Default / notes |
|-------|--------|-----------------|
| Server name | `--id` | Short name used in tool names, e.g. `sales`, `hr_prod`: lowercase letters, digits, `_`, starting with a letter |
| Host | `--host` | Hostname or IP address of the SQL Server |
| Port | `--port` | `1433` |
| Database | `--database` | Default database of this connection |
| Login | `--user` | A read-only login is strongly recommended (script in `/mssql-data:mssql-setup`) |
| Authentication | `--auth` | `sql` (SQL login, default) or `ntlm` (Windows/AD account) |
| Domain | `--domain` | Required for `ntlm`, e.g. `CORP`; the login then goes without `CORP\` |
| Named instance | `--instance` | Only for named instances, e.g. `PROD` |
| Encryption | `--sslmode` | `require` (default, works with self-signed certificates on internal servers), `verify-full`, or `disable` |
| Description | `--description` | Optional, one line, e.g. "Production sales (read-only)". Claude sees it when choosing between servers |

If the user only wants another database on a server that is already configured, a new entry may not be needed: the existing login can query `OtherDb.dbo.Table` if it has access there. Mention it, and add a separate entry only if they want a different login or default database.

### 2. Confirm, then run the command

Repeat the details in one line and tell the user: "A macOS password dialog will open. Type the password for <login> there." Then run, with a Bash timeout of at least 5 minutes because the command waits while the dialog is open:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mssql-servers.mjs" add --id <id> --host <host> --port <port> --database <database> --user <login> [--auth ntlm --domain <DOMAIN>] [--instance <NAME>] [--sslmode <mode>] [--description "<text>"]
```

| Exit code | Meaning | Next step |
|-----------|---------|-----------|
| `0` | Saved | Go to step 3 |
| `2` | The user cancelled the dialog or left the password empty; nothing was saved | Ask whether to try again |
| `1` | Invalid input, a server with that name exists, or another error | Show the message and fix the input. To change an existing server's details, run the same command with `--replace` (its password is kept) |

If the command says no password dialog can be opened (not macOS, or no GUI session), ask the user to run the same command themselves in a terminal: it then asks for the password with a hidden prompt.

### 3. Activate

The server becomes active in the **next** Claude Code session (desktop app: open a new session; terminal: restart `claude`). Tell the user that, and what to expect there:

- With one server the tools are `execute_sql`, `search_objects`, `explain_sql`, `health_check`.
- With several servers every tool gets the server name as suffix: `execute_sql_<id>`, `search_objects_<id>`, and so on.

In the new session, check the connection with the verification query in `/mssql-data:mssql-setup`.

## Related

- `/mssql-data:manage-servers`: list servers, remove one, change a password
- `/mssql-data:mssql-setup`: read-only login script for the DBA, connection troubleshooting
