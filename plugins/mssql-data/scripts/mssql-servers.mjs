#!/usr/bin/env node
// Manage the SQL Server connections of the mssql-data plugin (Windows and macOS).
//
//   add           --id ID --host HOST --user USER [--port 1433]
//                 [--auth sql|ntlm] [--domain DOMAIN] [--instance NAME]
//                 [--sslmode require|verify-full|disable] [--description TEXT]
//                 [--replace] [--password-stdin] [--no-test]
//   list          [--json]
//   remove        --id ID
//   set-password  --id ID [--password-stdin] [--no-test]
//   test          --id ID
//   info
//
// Passwords come from a password dialog, a hidden terminal prompt, or stdin
// (--password-stdin). They are stored with Windows DPAPI or in the macOS Keychain,
// never in servers.json. add and set-password finish with a connection test, which also
// downloads DBHub the first time so the next Claude Code session starts quickly.
import fs from "node:fs";
import { parseArgs } from "node:util";
import { queryServer } from "./dbhub.mjs";
import {
  DIALOG_CANCELLED,
  DIALOG_OK,
  UserError,
  configDir,
  describeServer,
  loadServers,
  macPasswordDialog,
  registryPath,
  saveServers,
  secretStore,
  validateServer,
  windowsPasswordDialog,
} from "./lib.mjs";

const EXIT_ERROR = 1;
const EXIT_CANCELLED = 2;
const EXIT_TEST_FAILED = 4;
const DEFAULT_DIALOG_TIMEOUT_SECONDS = 240;
const DEFAULT_TEST_TIMEOUT_MS = 300_000;
const CONNECTION_CHECK_SQL =
  "SELECT @@SERVERNAME AS server_name, CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(32)) AS product_version, " +
  "DB_NAME() AS default_db, SUSER_SNAME() AS login_name";

class CancelledError extends Error {}
class TestFailedError extends Error {}

const OPTIONS = {
  id: { type: "string" },
  host: { type: "string" },
  port: { type: "string" },
  user: { type: "string" },
  auth: { type: "string" },
  domain: { type: "string" },
  instance: { type: "string" },
  sslmode: { type: "string" },
  description: { type: "string" },
  replace: { type: "boolean" },
  "password-stdin": { type: "boolean" },
  "no-test": { type: "boolean" },
  json: { type: "boolean" },
};

const COMMANDS = { add, list, remove, "set-password": setPassword, test, info };

async function main(argv) {
  const { positionals, values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const command = COMMANDS[positionals[0]];
  if (!command) {
    throw new UserError(`Perintah tidak dikenal: "${positionals[0] ?? ""}". Pilihan: ${Object.keys(COMMANDS).join(", ")}`);
  }
  await command(values);
}

function findServer(servers, id) {
  if (!id) throw new UserError("--id wajib diisi");
  const server = servers.find((candidate) => candidate.id === id);
  if (!server) throw new UserError(`Server "${id}" tidak ditemukan. Lihat daftarnya dengan perintah "list".`);
  return server;
}

async function add(values) {
  const servers = loadServers();
  const server = validateServer({
    id: values.id,
    host: values.host,
    port: values.port,
    user: values.user,
    auth: values.auth,
    domain: values.domain,
    instance: values.instance || undefined,
    sslmode: values.sslmode,
    description: values.description || undefined,
  });
  const existing = servers.find((candidate) => candidate.id === server.id);
  if (existing && !values.replace) {
    throw new UserError(
      `Server "${server.id}" sudah ada. Pakai --replace untuk mengganti detailnya (password lama dipertahankan), atau set-password untuk mengganti password.`,
    );
  }
  const store = secretStore();
  const keepPassword = Boolean(existing) && store.has(server.id);
  if (!keepPassword) {
    const secret = await readPassword(values, server);
    try {
      store.set(server.id, secret);
    } catch (error) {
      if (!existing) store.delete(server.id); // drop a half-written item
      throw error;
    }
  }
  try {
    saveServers(existing ? servers.map((candidate) => (candidate.id === server.id ? server : candidate)) : [...servers, server]);
  } catch (error) {
    if (!existing) store.delete(server.id);
    throw error;
  }
  const passwordNote = keepPassword ? "Password lama dipertahankan." : `Password disimpan di ${store.name}.`;
  console.log(`Server "${server.id}" ${existing ? "diperbarui" : "ditambahkan"}: ${describeServer(server)}. ${passwordNote}`);
  if (!values["no-test"]) await testAfterChange(server);
  console.log("Buka sesi Claude Code baru supaya perubahan ini aktif.");
}

function list(values) {
  const store = secretStore();
  const rows = loadServers().map((server) => ({ ...server, passwordStored: store.has(server.id) }));
  if (values.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log(`Belum ada server. Tambahkan dengan /mssql-data:add-server. (Daftar: ${registryPath()})`);
    return;
  }
  for (const row of rows) {
    const columns = [
      row.id,
      describeServer(row),
      `auth=${row.auth}`,
      `ssl=${row.sslmode}`,
      `password=${row.passwordStored ? "tersimpan" : "BELUM ADA"}`,
      ...(row.description ? [row.description] : []),
    ];
    console.log(columns.join("  |  "));
  }
}

function remove(values) {
  const servers = loadServers();
  const server = findServer(servers, values.id);
  saveServers(servers.filter((candidate) => candidate.id !== server.id));
  secretStore().delete(server.id);
  console.log(`Server "${server.id}" dihapus beserta password-nya. Buka sesi Claude Code baru supaya perubahan ini aktif.`);
}

async function setPassword(values) {
  const server = findServer(loadServers(), values.id);
  const store = secretStore();
  store.set(server.id, await readPassword(values, server));
  console.log(`Password server "${server.id}" diperbarui di ${store.name}.`);
  if (!values["no-test"]) await testAfterChange(server);
  console.log("Buka sesi Claude Code baru supaya perubahan ini aktif.");
}

async function test(values) {
  await testConnection(findServer(loadServers(), values.id));
}

async function testAfterChange(server) {
  try {
    await testConnection(server);
  } catch (error) {
    if (!(error instanceof TestFailedError)) throw error;
    throw new TestFailedError(
      `${error.message}\nServer "${server.id}" tetap tersimpan. Perbaiki detailnya dengan add --replace atau password-nya dengan set-password, lalu uji lagi dengan test --id ${server.id}.`,
    );
  }
}

async function testConnection(server) {
  const secret = secretStore().get(server.id);
  if (secret === null) throw new UserError(`Password server "${server.id}" belum tersimpan. Isi dengan set-password --id ${server.id}.`);
  console.log(`Menguji koneksi ke ${describeServer(server)}. Pertama kali bisa beberapa menit karena DBHub (sekitar 250 MB) diunduh dulu...`);
  let result;
  try {
    const timeoutMs = Number(process.env.MSSQL_DATA_TEST_TIMEOUT_MS) || DEFAULT_TEST_TIMEOUT_MS;
    result = await queryServer(server, secret, CONNECTION_CHECK_SQL, { timeoutMs });
  } catch (error) {
    throw new TestFailedError(`Uji koneksi gagal: ${error.message}`);
  }
  if (!result.ok) throw new TestFailedError(`Uji koneksi gagal: ${result.error}`);
  const row = result.rows[0] ?? {};
  console.log(`Koneksi berhasil: ${row.server_name} (SQL Server ${row.product_version}), database default "${row.default_db}", login ${row.login_name}.`);
  if (!String(row.product_version ?? "").startsWith("16.")) {
    console.log("Catatan: server ini bukan SQL Server 2022 (16.x); sebagian fungsi T-SQL di skill plugin mungkin tidak tersedia.");
  }
}

function info() {
  console.log(`Folder konfigurasi   : ${configDir()}`);
  console.log(`Daftar server        : ${registryPath()}`);
  console.log(`Penyimpanan password : ${secretStore().name}`);
}

async function readPassword(values, server) {
  const label = `server "${server.id}" (${describeServer(server)})`;
  const secret = values["password-stdin"] ? fs.readFileSync(0, "utf8").replace(/\r?\n$/, "") : await promptPassword(label);
  if (secret === "") throw new CancelledError("Password kosong; tidak ada yang disimpan.");
  return secret;
}

function promptPassword(label) {
  if (process.stdin.isTTY) return promptHidden(`Password untuk ${label}: `);
  const dialog = { win32: windowsPasswordDialog, darwin: macPasswordDialog }[process.platform];
  if (!dialog) {
    throw new UserError("Password tidak bisa diminta di sini. Jalankan perintah ini di terminal, atau kirim password lewat --password-stdin.");
  }
  const timeout = Number(process.env.MSSQL_DATA_DIALOG_TIMEOUT) || DEFAULT_DIALOG_TIMEOUT_SECONDS;
  const result = dialog(`Masukkan password SQL Server untuk ${label}.`, timeout);
  if (result.status === DIALOG_OK) return result.password;
  if (result.status === DIALOG_CANCELLED) throw new CancelledError("Pengisian password dibatalkan; tidak ada yang disimpan.");
  throw new UserError(
    `Dialog password tidak bisa dibuka (${result.stderr.trim() || "alasan tidak diketahui"}). Jalankan perintah ini sendiri di terminal: password akan diminta dengan prompt tersembunyi.`,
  );
}

function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stderr } = process;
    let value = "";
    const finish = (settle) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stderr.write("\n");
      settle();
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return finish(() => resolve(value));
        if (char === "\u0003") return finish(() => reject(new CancelledError("Dibatalkan; tidak ada yang disimpan.")));
        value = char === "\u007f" || char === "\b" ? value.slice(0, -1) : value + char;
      }
    };
    stderr.write(question);
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.resume();
  });
}

const exitCodeFor = (error) => {
  if (error instanceof CancelledError) return EXIT_CANCELLED;
  if (error instanceof TestFailedError) return EXIT_TEST_FAILED;
  return EXIT_ERROR;
};

main(process.argv.slice(2)).catch((error) => {
  const known = error instanceof UserError || error instanceof CancelledError || error instanceof TestFailedError;
  console.error(known ? error.message : `Error: ${error.message}`);
  process.exit(exitCodeFor(error));
});
