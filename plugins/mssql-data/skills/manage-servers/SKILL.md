---
name: manage-servers
description: List, remove, or change the password or details of the SQL Server connections configured in the mssql-data plugin. Use when the user asks which servers are connected, wants to remove a server, rotated a password, or a server's tools are missing because its password is not stored.
argument-hint: "[list | remove <server> | set-password <server>]"
---

# /manage-servers - Manage SQL Server Connections

| Data | Windows | macOS |
|------|---------|-------|
| Server list (no passwords) | `%LOCALAPPDATA%\mssql-data\servers.json` | `~/.config/mssql-data/servers.json` |
| Passwords | `%LOCALAPPDATA%\mssql-data\secrets.dpapi.json`, encrypted with Windows DPAPI for the current Windows user | macOS Keychain, service `mssql-data` |

The database tools are built from this list when a session starts, so **every change takes effect in the next session**. Never ask for or repeat a password in chat; the same rules as `/mssql-data:add-server` apply.

## List

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mssql-servers.mjs" list
```

Shows each server's name, `login@host:port`, authentication, encryption, and whether a password is stored (never the password itself). Use `list --json` when you need to parse it. A server with `password=BELUM ADA` is skipped at session start; fix it with "Change a password".

## Remove

Confirm the server name and host with the user first, then:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mssql-servers.mjs" remove --id <server>
```

This deletes the entry and its stored password. It does not touch anything on the database server.

## Change a password

Tell the user a password window titled mssql-data will open, then run it with a Bash timeout of at least 5 minutes:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mssql-servers.mjs" set-password --id <server>
```

Exit code `2` means the user cancelled; nothing changed.

## Change host, login, or other details

Run the `add` command from `/mssql-data:add-server` with the same `--id`, all the new details, and `--replace`. The stored password is kept; change it separately if the login changed.

## Where things are on this machine

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mssql-servers.mjs" info
```
