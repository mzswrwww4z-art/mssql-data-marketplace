// Tests for the mssql-data server list, CLI, and MCP launcher.
// Run from the repository root: node --test
// They use a temporary config folder and the file password store. Opt-in tests touch the
// real OS facilities: MSSQL_DATA_TEST_DPAPI=1 (Windows DPAPI), MSSQL_DATA_TEST_KEYCHAIN=1
// (macOS Keychain, service "mssql-data-selftest"), MSSQL_DATA_TEST_DIALOG=1 (password dialog).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DIALOG_CANCELLED,
  DIALOG_UNAVAILABLE,
  buildDbhubToml,
  macPasswordDialog,
  secretStore,
  validateServer,
  windowsPasswordDialog,
} from "../plugins/mssql-data/scripts/lib.mjs";

const SCRIPTS = fileURLToPath(new URL("../plugins/mssql-data/scripts/", import.meta.url));
const CLI = path.join(SCRIPTS, "mssql-servers.mjs");
const LAUNCHER = path.join(SCRIPTS, "start-dbhub.mjs");
const DBHUB_TIMEOUT_MS = 120_000;
const DBHUB_TOOLS = ["execute_sql", "search_objects", "explain_sql", "health_check"];
const TRICKY_PASSWORD = 'p@ss:w0rd/#%? "q" \\b$ ü€';

const SALES = ["--id", "sales", "--host", "10.0.0.5", "--user", "report_ro"];
const HR = ["--id", "hr", "--host", "sql02.corp.local", "--user", "svc", "--auth", "ntlm", "--domain", "CORP", "--instance", "HR"];

const tempHomes = [];
after(() => tempHomes.forEach((home) => fs.rmSync(home, { recursive: true, force: true })));

function isolatedEnv(backend = "file") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mssql-data-test-"));
  tempHomes.push(home);
  return { ...process.env, MSSQL_DATA_HOME: home, MSSQL_DATA_SECRET_BACKEND: backend };
}

const cli = (env, args, input = "") => spawnSync(process.execPath, [CLI, ...args], { env, input, encoding: "utf8" });
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const fileMode = (file) => fs.statSync(file).mode & 0o777;

function probeMcp(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [LAUNCHER], { env, stdio: ["pipe", "pipe", "pipe"] });
    const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP probe timed out. stderr: ${stderr}`));
    }, DBHUB_TIMEOUT_MS);
    let buffer = "";
    let initialize;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const lines = (buffer + chunk).split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1) {
          initialize = message.result;
          send({ method: "notifications/initialized" });
          send({ id: 2, method: "tools/list" });
        } else if (message.id === 2) {
          clearTimeout(timer);
          child.kill();
          resolve({ initialize, tools: message.result.tools.map((tool) => tool.name) });
        }
      }
    });
    child.on("error", reject);
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
  });
}

describe("validateServer", () => {
  test("applies defaults for port, auth and sslmode", () => {
    assert.deepEqual(validateServer({ id: "sales", host: "10.0.0.5", user: "report_ro" }), {
      id: "sales",
      host: "10.0.0.5",
      port: 1433,
      user: "report_ro",
      auth: "sql",
      sslmode: "require",
    });
  });

  test("ignores a database field left over from older versions", () => {
    assert.equal("database" in validateServer({ id: "sales", host: "h", user: "u", database: "SalesDB" }), false);
  });

  test("rejects invalid input with a message per field", () => {
    const base = { id: "sales", host: "h", user: "u" };
    assert.throws(() => validateServer({ ...base, id: "Sales-1" }), /id:/);
    assert.throws(() => validateServer({ ...base, port: "99999" }), /port:/);
    assert.throws(() => validateServer({ ...base, auth: "ntlm" }), /domain:/);
    assert.throws(() => validateServer({ ...base, user: "CORP\\jdoe" }), /awalan domain/);
    assert.throws(() => validateServer({ ...base, host: "bad host" }), /host:/);
    assert.throws(() => validateServer({ ...base, host: "10.0.0.5/evil" }), /host:/);
    assert.throws(() => validateServer({ ...base, host: "user@10.0.0.5" }), /host:/);
    assert.throws(() => validateServer({ ...base, description: "two\nlines" }), /description:/);
  });
});

describe("buildDbhubToml", () => {
  const servers = [
    validateServer({ id: "sales", host: "10.0.0.5", user: "report ro", description: 'Sales "prod"' }),
    validateServer({ id: "hr", host: "sql02", user: "svc", auth: "ntlm", domain: "CORP", instance: "HR" }),
  ];
  const toml = buildDbhubToml(servers);

  test("creates one source and four read-only tools per server", () => {
    assert.equal(toml.match(/^\[\[sources\]\]$/gm).length, 2);
    assert.equal(toml.match(/^\[\[tools\]\]$/gm).length, 8);
    assert.equal(toml.match(/^readonly = true$/gm).length, 2);
  });

  test("builds DSNs without a database and with the password as an env placeholder", () => {
    assert.match(toml, /^dsn = "sqlserver:\/\/report%20ro:\$\{MSSQL_DATA_PW_SALES\}@10\.0\.0\.5:1433\/\?sslmode=require"$/m);
    assert.match(toml, /^dsn = "sqlserver:\/\/svc:\$\{MSSQL_DATA_PW_HR\}@sql02:1433\/\?sslmode=require&instanceName=HR&authentication=ntlm&domain=CORP"$/m);
    assert.doesNotMatch(toml, /^database = /m);
  });

  test("escapes the description", () => {
    assert.match(toml, /^description = "Sales \\"prod\\""$/m);
  });
});

describe("mssql-servers CLI", () => {
  test("adds, lists, replaces, changes the password of, and removes a server", () => {
    const env = isolatedEnv();
    const servers = path.join(env.MSSQL_DATA_HOME, "servers.json");
    const secrets = path.join(env.MSSQL_DATA_HOME, "secrets.json");

    const added = cli(env, ["add", ...SALES, "--description", "Sales prod", "--password-stdin"], "s3cret\n");
    assert.equal(added.status, 0, added.stderr);
    assert.match(added.stdout, /ditambahkan: report_ro@10\.0\.0\.5:1433/);
    if (process.platform !== "win32") {
      assert.equal(fileMode(servers), 0o600);
      assert.equal(fileMode(secrets), 0o600);
    }
    assert.doesNotMatch(fs.readFileSync(servers, "utf8"), /s3cret/);
    assert.deepEqual(readJson(secrets), { sales: "s3cret" });

    const listed = JSON.parse(cli(env, ["list", "--json"]).stdout);
    assert.deepEqual(listed.map(({ id, passwordStored }) => ({ id, passwordStored })), [{ id: "sales", passwordStored: true }]);

    const duplicate = cli(env, ["add", ...SALES, "--password-stdin"], "other\n");
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /--replace/);

    const replaced = cli(env, ["add", ...SALES.map((arg) => (arg === "10.0.0.5" ? "10.0.0.9" : arg)), "--replace"]);
    assert.equal(replaced.status, 0, replaced.stderr);
    assert.match(replaced.stdout, /Password lama dipertahankan/);
    assert.equal(readJson(servers).servers[0].host, "10.0.0.9");
    assert.deepEqual(readJson(secrets), { sales: "s3cret" });

    const changed = cli(env, ["set-password", "--id", "sales", "--password-stdin"], "n3w-pass\n");
    assert.equal(changed.status, 0, changed.stderr);
    assert.deepEqual(readJson(secrets), { sales: "n3w-pass" });

    const removed = cli(env, ["remove", "--id", "sales"]);
    assert.equal(removed.status, 0, removed.stderr);
    assert.deepEqual(JSON.parse(cli(env, ["list", "--json"]).stdout), []);
    assert.deepEqual(readJson(secrets), {});
  });

  test("saves nothing when the input is invalid or the password is empty", () => {
    const env = isolatedEnv();
    const invalid = cli(env, ["add", "--id", "Bad Id", "--host", "h", "--user", "u", "--password-stdin"], "x\n");
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Data server tidak valid/);

    const empty = cli(env, ["add", ...SALES, "--password-stdin"], "\n");
    assert.equal(empty.status, 2);
    assert.equal(fs.existsSync(path.join(env.MSSQL_DATA_HOME, "servers.json")), false);
    assert.equal(fs.existsSync(path.join(env.MSSQL_DATA_HOME, "secrets.json")), false);
  });

  test("rejects the removed --database option and unknown commands", () => {
    const env = isolatedEnv();
    const withDatabase = cli(env, ["add", ...SALES, "--database", "SalesDB", "--password-stdin"], "x\n");
    assert.equal(withDatabase.status, 1);
    assert.match(withDatabase.stderr, /--database/);
    const unknown = cli(env, ["frobnicate"]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Perintah tidak dikenal/);
  });
});

describe("start-dbhub launcher", () => {
  test("serves no tools and points to add-server when no server is configured", async () => {
    const { initialize, tools } = await probeMcp(isolatedEnv());
    assert.deepEqual(tools, []);
    assert.match(initialize.instructions, /\/mssql-data:add-server/);
  });

  test("serves no tools and points to manage-servers when no password is stored", async () => {
    const env = isolatedEnv();
    assert.equal(cli(env, ["add", ...SALES, "--password-stdin"], "s3cret\n").status, 0);
    fs.writeFileSync(path.join(env.MSSQL_DATA_HOME, "secrets.json"), "{}\n", { mode: 0o600 });
    const { initialize, tools } = await probeMcp(env);
    assert.deepEqual(tools, []);
    assert.match(initialize.instructions, /\/mssql-data:manage-servers/);
  });

  test("starts DBHub for a server whose password needs URL encoding", { timeout: DBHUB_TIMEOUT_MS }, async () => {
    const env = isolatedEnv();
    assert.equal(cli(env, ["add", ...SALES, "--password-stdin"], `${TRICKY_PASSWORD}\n`).status, 0);
    const { tools } = await probeMcp(env);
    assert.deepEqual(tools, DBHUB_TOOLS);
  });

  test("gives each server its own suffixed tools and skips servers without a password", { timeout: DBHUB_TIMEOUT_MS }, async () => {
    const env = isolatedEnv();
    assert.equal(cli(env, ["add", ...SALES, "--password-stdin"], "s3cret\n").status, 0);
    assert.equal(cli(env, ["add", ...HR, "--password-stdin"], "s3cret\n").status, 0);
    const both = await probeMcp(env);
    assert.deepEqual(both.tools, [...DBHUB_TOOLS.map((tool) => `${tool}_sales`), ...DBHUB_TOOLS.map((tool) => `${tool}_hr`)]);

    fs.writeFileSync(path.join(env.MSSQL_DATA_HOME, "secrets.json"), `${JSON.stringify({ sales: "s3cret" })}\n`, { mode: 0o600 });
    const salesOnly = await probeMcp(env);
    assert.deepEqual(salesOnly.tools, DBHUB_TOOLS);
  });
});

for (const { name, platform, flag, backend, service } of [
  { name: "Windows DPAPI store", platform: "win32", flag: "MSSQL_DATA_TEST_DPAPI", backend: "dpapi" },
  { name: "macOS Keychain store", platform: "darwin", flag: "MSSQL_DATA_TEST_KEYCHAIN", backend: "keychain", service: "mssql-data-selftest" },
]) {
  describe(name, { skip: process.platform !== platform || process.env[flag] !== "1" }, () => {
    const storeEnv = () => ({ ...isolatedEnv(backend), ...(service ? { MSSQL_DATA_KEYCHAIN_SERVICE: service } : {}) });

    test("round-trips passwords with spaces, quotes, backslashes and non-ASCII characters", () => {
      const store = secretStore(storeEnv());
      try {
        store.set("selftest", TRICKY_PASSWORD);
        assert.equal(store.get("selftest"), TRICKY_PASSWORD);
        assert.equal(store.has("selftest"), true);
      } finally {
        store.delete("selftest");
      }
      assert.equal(store.has("selftest"), false);
    });

    test("launcher starts DBHub with a password read from the store", { timeout: DBHUB_TIMEOUT_MS }, async () => {
      const env = storeEnv();
      assert.equal(cli(env, ["add", ...SALES, "--password-stdin"], `${TRICKY_PASSWORD}\n`).status, 0);
      try {
        const { tools } = await probeMcp(env);
        assert.deepEqual(tools, DBHUB_TOOLS);
      } finally {
        assert.equal(cli(env, ["remove", "--id", "sales"]).status, 0);
      }
      assert.equal(secretStore(env).has("sales"), false);
    });
  });
}

describe("password dialog", { skip: !["win32", "darwin"].includes(process.platform) || process.env.MSSQL_DATA_TEST_DIALOG !== "1" }, () => {
  test("opens a visible dialog and reports a timeout as cancelled", (t) => {
    const result =
      process.platform === "win32" ? windowsPasswordDialog("mssql-data test dialog", 3, { probe: true }) : macPasswordDialog("mssql-data test dialog", 3);
    if (result.status === DIALOG_UNAVAILABLE) return t.skip(`no interactive desktop: ${result.stderr}`);
    assert.equal(result.status, DIALOG_CANCELLED, result.stderr);
    if (process.platform === "win32") assert.match(result.stderr, /probe-visible=True/);
    return undefined;
  });
});
