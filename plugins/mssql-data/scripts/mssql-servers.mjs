#!/usr/bin/env node
// Manage the SQL Server connections of the mssql-data plugin.
//
//   add           --id ID --host HOST --database DB --user USER [--port 1433]
//                 [--auth sql|ntlm] [--domain DOMAIN] [--instance NAME]
//                 [--sslmode require|verify-full|disable] [--description TEXT]
//                 [--replace] [--password-stdin]
//   list          [--json]
//   remove        --id ID
//   set-password  --id ID [--password-stdin]
//   info
//
// Passwords come from a macOS password dialog, a hidden terminal prompt, or stdin
// (--password-stdin), and are stored in the macOS Keychain, never in servers.json.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { parseArgs } from "node:util";
import { UserError, configDir, describeServer, loadServers, registryPath, saveServers, secretStore, validateServer } from "./lib.mjs";

const EXIT_ERROR = 1;
const EXIT_CANCELLED = 2;
const DEFAULT_DIALOG_TIMEOUT_SECONDS = 300;
const APPLESCRIPT_USER_CANCELLED = "-128";

class CancelledError extends Error {}

const OPTIONS = {
  id: { type: "string" },
  host: { type: "string" },
  port: { type: "string" },
  database: { type: "string" },
  user: { type: "string" },
  auth: { type: "string" },
  domain: { type: "string" },
  instance: { type: "string" },
  sslmode: { type: "string" },
  description: { type: "string" },
  replace: { type: "boolean" },
  "password-stdin": { type: "boolean" },
  json: { type: "boolean" },
};

const COMMANDS = { add, list, remove, "set-password": setPassword, info };

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
    database: values.database,
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
  console.log(`Password server "${server.id}" diperbarui di ${store.name}. Buka sesi Claude Code baru supaya perubahan ini aktif.`);
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
  if (process.platform === "darwin") return promptDialog(label);
  throw new UserError("Password tidak bisa diminta di sini. Jalankan perintah ini di terminal, atau kirim password lewat --password-stdin.");
}

const appleScriptString = (text) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

async function promptDialog(label) {
  const timeout = Number(process.env.MSSQL_DATA_DIALOG_TIMEOUT) || DEFAULT_DIALOG_TIMEOUT_SECONDS;
  const script =
    `text returned of (display dialog ${appleScriptString(`Masukkan password SQL Server untuk ${label}.`)} ` +
    `default answer "" with hidden answer with title "mssql-data" buttons {"Batal", "Simpan"} ` +
    `default button "Simpan" cancel button "Batal" giving up after ${timeout})`;
  try {
    return execFileSync("/usr/bin/osascript", ["-e", script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).replace(/\n$/, "");
  } catch (error) {
    if (String(error.stderr).includes(APPLESCRIPT_USER_CANCELLED)) {
      throw new CancelledError("Pengisian password dibatalkan; tidak ada yang disimpan.");
    }
    throw new UserError(`Dialog password tidak bisa dibuka: ${String(error.stderr || error.message).trim()}`);
  }
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

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof UserError || error instanceof CancelledError ? error.message : `Error: ${error.message}`);
  process.exit(error instanceof CancelledError ? EXIT_CANCELLED : EXIT_ERROR);
});
