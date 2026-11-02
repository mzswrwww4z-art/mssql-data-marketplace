// Shared helpers for the mssql-data plugin: the server list, password storage,
// and the DBHub configuration generated from them.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DBHUB_PACKAGE = "@bytebase/dbhub@1.5.0";

const ID_PATTERN = /^[a-z][a-z0-9_]{0,30}$/;
const INSTANCE_PATTERN = /^[A-Za-z0-9_$-]{1,16}$/;
const KEYCHAIN_SERVICE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const AUTH_MODES = ["sql", "ntlm"];
const SSL_MODES = ["require", "verify-full", "disable"];
const DEFAULT_PORT = 1433;
const MAX_DESCRIPTION_LENGTH = 200;
const MAX_ROWS = 1000;
const CONNECTION_TIMEOUT_SECONDS = 30;
const QUERY_TIMEOUT_SECONDS = 60;
const KEYCHAIN_ITEM_NOT_FOUND = 44;
const HEX_PATTERN = /^(?:[0-9a-f]{2})+$/;

/** An error caused by user input or local setup; its message is shown as is. */
export class UserError extends Error {}

export function configDir(env = process.env) {
  return env.MSSQL_DATA_HOME || path.join(os.homedir(), ".config", "mssql-data");
}

export function registryPath(env = process.env) {
  return path.join(configDir(env), "servers.json");
}

export function passwordEnvVar(id) {
  return `MSSQL_DATA_PW_${id.toUpperCase()}`;
}

export function describeServer(server) {
  const host = server.instance ? `${server.host}\\${server.instance}` : server.host;
  const login = server.auth === "ntlm" ? `${server.domain}\\${server.user}` : server.user;
  return `${login}@${host}:${server.port}/${server.database}`;
}

const isText = (value) => typeof value === "string" && value.trim() !== "" && !CONTROL_CHARS.test(value);

/** Validates a server definition and returns a normalized copy with defaults applied. */
export function validateServer(input) {
  const auth = input.auth ?? "sql";
  const sslmode = input.sslmode ?? "require";
  const port = input.port === undefined ? DEFAULT_PORT : Number(input.port);
  const errors = [
    !ID_PATTERN.test(input.id ?? "") && "id: 1-31 karakter (huruf kecil, angka, _), diawali huruf",
    (!isText(input.host) || /\s/.test(input.host)) && "host: wajib, tanpa spasi",
    (!Number.isInteger(port) || port < 1 || port > 65535) && "port: angka 1-65535",
    !isText(input.database) && "database: wajib",
    !isText(input.user) && "user: wajib",
    isText(input.user) && input.user.includes("\\") && "user: tanpa awalan domain; isi domain dengan --domain",
    !AUTH_MODES.includes(auth) && `auth: ${AUTH_MODES.join(" atau ")}`,
    auth === "ntlm" && !isText(input.domain) && "domain: wajib untuk auth ntlm",
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
    database: input.database,
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

/** Password storage: the macOS Keychain by default, a mode-600 JSON file elsewhere or when asked. */
export function secretStore(env = process.env) {
  const kind = env.MSSQL_DATA_SECRET_BACKEND || (process.platform === "darwin" ? "keychain" : "file");
  if (kind === "keychain") return keychainStore(env.MSSQL_DATA_KEYCHAIN_SERVICE || "mssql-data");
  if (kind === "file") return fileStore(path.join(configDir(env), "secrets.json"), env);
  throw new UserError(`MSSQL_DATA_SECRET_BACKEND tidak dikenal: "${kind}" (pilih keychain atau file)`);
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
  const read = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {});
  return {
    name: `file ${file} (teks biasa, izin 600)`,
    get: (id) => read()[id] ?? null,
    has: (id) => Object.hasOwn(read(), id),
    set: (id, secret) => writePrivateJson(file, { ...read(), [id]: secret }, env),
    delete: (id) => {
      const current = read();
      if (!Object.hasOwn(current, id)) return;
      const { [id]: _removed, ...rest } = current;
      writePrivateJson(file, rest, env);
    },
  };
}

// JSON string escapes are valid TOML basic-string escapes, and inputs are validated above.
const toml = (value) => JSON.stringify(String(value));

/** DBHub TOML for the given servers. Passwords stay out of the file: each source reads its own env var. */
export function buildDbhubToml(servers) {
  const sources = servers.flatMap((server) => [
    "[[sources]]",
    `id = ${toml(server.id)}`,
    ...(server.description ? [`description = ${toml(server.description)}`] : []),
    'type = "sqlserver"',
    `host = ${toml(server.host)}`,
    `port = ${server.port}`,
    `database = ${toml(server.database)}`,
    `user = ${toml(server.user)}`,
    `password = ${toml(`\${${passwordEnvVar(server.id)}}`)}`,
    `sslmode = ${toml(server.sslmode)}`,
    ...(server.instance ? [`instanceName = ${toml(server.instance)}`] : []),
    ...(server.auth === "ntlm" ? ['authentication = "ntlm"', `domain = ${toml(server.domain)}`] : []),
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
