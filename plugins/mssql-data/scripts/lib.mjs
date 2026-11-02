// Shared helpers for the mssql-data plugin: the server list, password storage, password
// dialogs, and the DBHub configuration generated from them. Works on Windows and macOS.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DBHUB_PACKAGE = "@bytebase/dbhub@1.5.0";
export const DIALOG_OK = 0;
export const DIALOG_CANCELLED = 2;
export const DIALOG_UNAVAILABLE = 3;

const ID_PATTERN = /^[a-z][a-z0-9_]{0,30}$/;
const HOST_PATTERN = /^[A-Za-z0-9._-]{1,253}$/;
const INSTANCE_PATTERN = /^[A-Za-z0-9_$-]{1,16}$/;
const DOMAIN_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const KEYCHAIN_SERVICE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const HEX_PATTERN = /^(?:[0-9a-f]{2})+$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const AUTH_MODES = ["sql", "ntlm"];
const SSL_MODES = ["require", "verify-full", "disable"];
const DEFAULT_PORT = 1433;
const MAX_DESCRIPTION_LENGTH = 200;
const MAX_ROWS = 1000;
const CONNECTION_TIMEOUT_SECONDS = 30;
const QUERY_TIMEOUT_SECONDS = 60;
const KEYCHAIN_ITEM_NOT_FOUND = 44;
const APPLESCRIPT_USER_CANCELLED = "-128";
const POWERSHELL = "powershell.exe";

/** An error caused by user input or local setup; its message is shown as is. */
export class UserError extends Error {}

export function configDir(env = process.env) {
  if (env.MSSQL_DATA_HOME) return env.MSSQL_DATA_HOME;
  if (process.platform === "win32") {
    return path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "mssql-data");
  }
  return path.join(os.homedir(), ".config", "mssql-data");
}

export function registryPath(env = process.env) {
  return path.join(configDir(env), "servers.json");
}

/** Environment variable that carries a server's URL-encoded password to DBHub. */
export function passwordEnvVar(id) {
  return `MSSQL_DATA_PW_${id.toUpperCase()}`;
}

export function describeServer(server) {
  const host = server.instance ? `${server.host}\\${server.instance}` : server.host;
  const login = server.auth === "ntlm" ? `${server.domain}\\${server.user}` : server.user;
  return `${login}@${host}:${server.port}`;
}

const isText = (value) => typeof value === "string" && value.trim() !== "" && !CONTROL_CHARS.test(value);

/** Validates a server definition and returns a normalized copy with defaults applied. */
export function validateServer(input) {
  const auth = input.auth ?? "sql";
  const sslmode = input.sslmode ?? "require";
  const port = input.port === undefined ? DEFAULT_PORT : Number(input.port);
  const errors = [
    !ID_PATTERN.test(input.id ?? "") && "id: 1-31 karakter (huruf kecil, angka, _), diawali huruf",
    !HOST_PATTERN.test(input.host ?? "") && "host: nama host atau alamat IPv4 (huruf, angka, titik, -, _)",
    (!Number.isInteger(port) || port < 1 || port > 65535) && "port: angka 1-65535",
    !isText(input.user) && "user: wajib",
    isText(input.user) && input.user.includes("\\") && "user: tanpa awalan domain; isi domain dengan --domain",
    !AUTH_MODES.includes(auth) && `auth: ${AUTH_MODES.join(" atau ")}`,
    auth === "ntlm" && !DOMAIN_PATTERN.test(input.domain ?? "") && "domain: wajib untuk auth ntlm (huruf, angka, titik, -, _)",
    !SSL_MODES.includes(sslmode) && `sslmode: ${SSL_MODES.join(", ")}`,
    input.instance != null && !INSTANCE_PATTERN.test(input.instance) && "instance: huruf, angka, _ $ - (maks 16 karakter)",
    input.description != null &&
      (!isText(input.description) || input.description.length > MAX_DESCRIPTION_LENGTH) &&
      `description: satu baris, maks ${MAX_DESCRIPTION_LENGTH} karakter`,
  ].filter(Boolean);
  if (errors.length > 0) throw new UserError(`Data server tidak valid:\n- ${errors.join("\n- ")}`);

  return {
    id: input.id,
    host: input.host,
    port,
    user: input.user,
    auth,
    ...(auth === "ntlm" ? { domain: input.domain } : {}),
    sslmode,
    ...(input.instance ? { instance: input.instance } : {}),
    ...(input.description ? { description: input.description } : {}),
  };
}

export function loadServers(env = process.env) {
  const file = registryPath(env);
  if (!fs.existsSync(file)) return [];
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new UserError(`${file} bukan JSON yang valid: ${error.message}`);
  }
  if (!Array.isArray(data?.servers)) throw new UserError(`${file}: "servers" harus berupa array`);
  const servers = data.servers.map(validateServer);
  const duplicate = servers.find((server, index) => servers.findIndex((other) => other.id === server.id) !== index);
  if (duplicate) throw new UserError(`${file}: nama server "${duplicate.id}" dipakai lebih dari sekali`);
  return servers;
}

export function saveServers(servers, env = process.env) {
  writePrivateJson(registryPath(env), { servers }, env);
}

function writePrivateJson(file, data, env) {
  fs.mkdirSync(configDir(env), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function powershellArgs(script, { interactive }) {
  return [
    "-NoProfile",
    interactive ? "-STA" : "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    // Base64-encoded UTF-16LE sidesteps Windows command-line quoting entirely.
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
}

function runPowerShell(script, input) {
  try {
    const args = powershellArgs(script, { interactive: false });
    return execFileSync(POWERSHELL, args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], windowsHide: true }).trim();
  } catch (error) {
    throw new Error(`PowerShell: ${String(error.stderr || error.message).trim()}`);
  }
}

/**
 * Password storage: Windows DPAPI on Windows, the macOS Keychain on macOS, and a
 * mode-600 plaintext JSON file elsewhere or when MSSQL_DATA_SECRET_BACKEND=file.
 */
export function secretStore(env = process.env) {
  const defaultKind = { win32: "dpapi", darwin: "keychain" }[process.platform] ?? "file";
  const kind = env.MSSQL_DATA_SECRET_BACKEND || defaultKind;
  if (kind === "dpapi") return dpapiStore(path.join(configDir(env), "secrets.dpapi.json"), env);
  if (kind === "keychain") return keychainStore(env.MSSQL_DATA_KEYCHAIN_SERVICE || "mssql-data");
  if (kind === "file") return fileStore(path.join(configDir(env), "secrets.json"), env);
  throw new UserError(`MSSQL_DATA_SECRET_BACKEND tidak dikenal: "${kind}" (pilih dpapi, keychain, atau file)`);
}

function jsonFileMap(file, env) {
  const read = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {});
  return {
    read,
    has: (id) => Object.hasOwn(read(), id),
    put: (id, value) => writePrivateJson(file, { ...read(), [id]: value }, env),
    remove: (id) => {
      const current = read();
      if (!Object.hasOwn(current, id)) return;
      const { [id]: _removed, ...rest } = current;
      writePrivateJson(file, rest, env);
    },
  };
}

// ConvertFrom-SecureString without a key encrypts with DPAPI for the current Windows user.
// Passwords travel through stdin as base64 so code pages and quoting never touch them.
const DPAPI_PROTECT_SCRIPT = `
$ErrorActionPreference = 'Stop'
$plain = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()))
$secure = ConvertTo-SecureString -String $plain -AsPlainText -Force
[Console]::Out.Write((ConvertFrom-SecureString -SecureString $secure))
`;
const DPAPI_UNPROTECT_SCRIPT = `
$ErrorActionPreference = 'Stop'
$secure = ConvertTo-SecureString -String ([Console]::In.ReadToEnd().Trim())
$plain = (New-Object System.Management.Automation.PSCredential 'mssql-data', $secure).GetNetworkCredential().Password
[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($plain)))
`;

function dpapiStore(file, env) {
  const blobs = jsonFileMap(file, env);
  const protect = (secret) => runPowerShell(DPAPI_PROTECT_SCRIPT, Buffer.from(secret, "utf8").toString("base64"));
  const unprotect = (blob) => Buffer.from(runPowerShell(DPAPI_UNPROTECT_SCRIPT, blob), "base64").toString("utf8");
  return {
    name: `Windows DPAPI (${file})`,
    get: (id) => {
      const blob = blobs.read()[id];
      return blob === undefined ? null : unprotect(blob);
    },
    has: blobs.has,
    set: (id, secret) => {
      const blob = protect(secret);
      if (unprotect(blob) !== secret) throw new Error("Password gagal dienkripsi dengan Windows DPAPI");
      blobs.put(id, blob);
    },
    delete: blobs.remove,
  };
}

function keychainStore(service) {
  if (!KEYCHAIN_SERVICE_PATTERN.test(service)) throw new UserError(`Nama layanan Keychain tidak valid: "${service}"`);
  const security = (args, options) => execFileSync("/usr/bin/security", args, { encoding: "utf8", ...options });
  const lookup = (id, extraArgs) => {
    try {
      return security(["find-generic-password", "-s", service, "-a", id, ...extraArgs], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      if (error.status === KEYCHAIN_ITEM_NOT_FOUND) return null;
      throw new Error(`macOS Keychain: ${String(error.stderr || error.message).trim()}`);
    }
  };
  // Items hold the password as hex-encoded UTF-8: `security -w` prints passwords with
  // non-ASCII characters as hex but ASCII ones as is, so plain storage would be ambiguous.
  const get = (id) => {
    const output = lookup(id, ["-w"]);
    if (output === null) return null;
    const data = output.trim();
    if (!HEX_PATTERN.test(data)) throw new Error(`format item Keychain "${id}" tidak dikenal; isi ulang password-nya`);
    return Buffer.from(data, "hex").toString("utf8");
  };
  return {
    name: "macOS Keychain",
    get,
    has: (id) => lookup(id, []) !== null,
    set: (id, secret) => {
      const data = Buffer.from(secret, "utf8").toString("hex");
      // The command goes through stdin so the password never shows up in the process list.
      security(["-i"], {
        input: `add-generic-password -U -s ${service} -a ${id} -l mssql-data:${id} -w ${data}\n`,
        stdio: ["pipe", "ignore", "pipe"],
      });
      if (get(id) !== secret) throw new Error("Password gagal disimpan ke macOS Keychain");
    },
    delete: (id) => {
      if (lookup(id, []) !== null) security(["delete-generic-password", "-s", service, "-a", id], { stdio: "ignore" });
    },
  };
}

function fileStore(file, env) {
  const values = jsonFileMap(file, env);
  return {
    name: `file ${file} (teks biasa, izin 600)`,
    get: (id) => values.read()[id] ?? null,
    has: values.has,
    set: values.put,
    delete: values.remove,
  };
}

// Exit codes 0 = saved, 2 = cancelled or timed out, 3 = no dialog possible. A process that
// Node starts hidden ignores its first ShowWindow call, so a throwaway form spends it first.
const WINDOWS_DIALOG_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
} catch {
  [Console]::Error.Write("dialog-unavailable: $($_.Exception.Message)")
  exit 3
}
if (-not [Environment]::UserInteractive) {
  [Console]::Error.Write('dialog-unavailable: no interactive desktop')
  exit 3
}
[System.Windows.Forms.Application]::EnableVisualStyles()
$primer = New-Object System.Windows.Forms.Form
$primer.ShowInTaskbar = $false
$primer.Opacity = 0
$primer.Show()
$primer.Hide()
$primer.Dispose()

$form = New-Object System.Windows.Forms.Form
$form.Text = 'mssql-data'
$form.ClientSize = New-Object System.Drawing.Size(440, 140)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
$label = New-Object System.Windows.Forms.Label
$label.Text = $env:MSSQL_DATA_DIALOG_MESSAGE
$label.Location = New-Object System.Drawing.Point(12, 12)
$label.Size = New-Object System.Drawing.Size(416, 44)
$box = New-Object System.Windows.Forms.TextBox
$box.UseSystemPasswordChar = $true
$box.Location = New-Object System.Drawing.Point(12, 62)
$box.Size = New-Object System.Drawing.Size(416, 24)
$ok = New-Object System.Windows.Forms.Button
$ok.Text = 'Simpan'
$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
$ok.Location = New-Object System.Drawing.Point(266, 100)
$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = 'Batal'
$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$cancel.Location = New-Object System.Drawing.Point(352, 100)
$form.AcceptButton = $ok
$form.CancelButton = $cancel
$form.Controls.AddRange(@($label, $box, $ok, $cancel))
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [Math]::Max(1, [int]$env:MSSQL_DATA_DIALOG_TIMEOUT) * 1000
$timer.Add_Tick({ $timer.Stop(); $form.DialogResult = [System.Windows.Forms.DialogResult]::Cancel; $form.Close() })
$form.Add_Shown({
  $form.Activate()
  [void]$box.Focus()
  if ($env:MSSQL_DATA_DIALOG_PROBE -eq '1') {
    Add-Type -Namespace MssqlData -Name Win32 -MemberDefinition '[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);'
    [Console]::Error.Write("probe-visible=$([MssqlData.Win32]::IsWindowVisible($form.Handle))")
  }
  $timer.Start()
})
$result = $form.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $box.Text.Length -gt 0) {
  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($box.Text)))
  exit 0
}
exit 2
`;

/** Shows a password dialog on Windows. Returns { status, password, stderr }. */
export function windowsPasswordDialog(message, timeoutSeconds, { probe = false } = {}) {
  const result = spawnSync(POWERSHELL, powershellArgs(WINDOWS_DIALOG_SCRIPT, { interactive: true }), {
    env: {
      ...process.env,
      MSSQL_DATA_DIALOG_MESSAGE: message,
      MSSQL_DATA_DIALOG_TIMEOUT: String(timeoutSeconds),
      ...(probe ? { MSSQL_DATA_DIALOG_PROBE: "1" } : {}),
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stderr = String(result.stderr || result.error?.message || "");
  const password = result.status === DIALOG_OK ? Buffer.from(result.stdout.trim(), "base64").toString("utf8") : "";
  if (result.status === DIALOG_OK && password !== "") return { status: DIALOG_OK, password, stderr };
  return { status: result.status === DIALOG_OK || result.status === DIALOG_CANCELLED ? DIALOG_CANCELLED : DIALOG_UNAVAILABLE, password: null, stderr };
}

const appleScriptString = (text) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Shows a password dialog on macOS. Returns { status, password, stderr }. */
export function macPasswordDialog(message, timeoutSeconds) {
  const script =
    `text returned of (display dialog ${appleScriptString(message)} default answer "" with hidden answer ` +
    `with title "mssql-data" buttons {"Batal", "Simpan"} default button "Simpan" cancel button "Batal" ` +
    `giving up after ${timeoutSeconds})`;
  const result = spawnSync("/usr/bin/osascript", ["-e", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const stderr = String(result.stderr || result.error?.message || "");
  const password = result.status === 0 ? result.stdout.replace(/\n$/, "") : "";
  if (password !== "") return { status: DIALOG_OK, password, stderr };
  const cancelled = result.status === 0 || stderr.includes(APPLESCRIPT_USER_CANCELLED);
  return { status: cancelled ? DIALOG_CANCELLED : DIALOG_UNAVAILABLE, password: null, stderr };
}

// JSON string escapes are valid TOML basic-string escapes, and inputs are validated above.
const toml = (value) => JSON.stringify(String(value));

/**
 * SQL Server DSN with no database in the path, so the connection opens the login's
 * default database. The password is a placeholder that DBHub fills from the environment.
 */
function buildDsn(server) {
  const params = new URLSearchParams([
    ["sslmode", server.sslmode],
    ...(server.instance ? [["instanceName", server.instance]] : []),
    ...(server.auth === "ntlm" ? [["authentication", "ntlm"], ["domain", server.domain]] : []),
  ]);
  return `sqlserver://${encodeURIComponent(server.user)}:\${${passwordEnvVar(server.id)}}@${server.host}:${server.port}/?${params}`;
}

/** DBHub TOML for the given servers: one read-only source with four tools per server. */
export function buildDbhubToml(servers) {
  const sources = servers.flatMap((server) => [
    "[[sources]]",
    `id = ${toml(server.id)}`,
    ...(server.description ? [`description = ${toml(server.description)}`] : []),
    `dsn = ${toml(buildDsn(server))}`,
    `connection_timeout = ${CONNECTION_TIMEOUT_SECONDS}`,
    `query_timeout = ${QUERY_TIMEOUT_SECONDS}`,
    "lazy = true",
    "",
  ]);
  const tools = servers.flatMap((server) => [
    "[[tools]]",
    'name = "execute_sql"',
    `source = ${toml(server.id)}`,
    "readonly = true",
    `max_rows = ${MAX_ROWS}`,
    "",
    ...["search_objects", "explain_sql", "health_check"].flatMap((name) => [
      "[[tools]]",
      `name = "${name}"`,
      `source = ${toml(server.id)}`,
      "",
    ]),
  ]);
  return ["# Generated by the mssql-data plugin from servers.json. Do not edit.", "", ...sources, ...tools].join("\n");
}
