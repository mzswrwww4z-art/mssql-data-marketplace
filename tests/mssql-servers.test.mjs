// Tests for the mssql-data server list, CLI, and MCP launcher.
// Run from the repository root: node --test
// They use a temporary config folder and the file password store. The macOS Keychain test
// only runs with MSSQL_DATA_TEST_KEYCHAIN=1 and uses its own "mssql-data-selftest" service.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildDbhubToml, secretStore, validateServer } from "../plugins/mssql-data/scripts/lib.mjs";

const SCRIPTS = fileURLToPath(new URL("../plugins/mssql-data/scripts/", import.meta.url));
const CLI = path.join(SCRIPTS, "mssql-servers.mjs");
const LAUNCHER = path.join(SCRIPTS, "start-dbhub.mjs");
const DBHUB_TIMEOUT_MS = 90_000;
const DBHUB_TOOLS = ["execute_sql", "search_objects", "explain_sql", "health_check"];

const SALES = ["--id", "sales", "--host", "10.0.0.5", "--database", "SalesDB", "--user", "report_ro"];
const HR = ["--id", "hr", "--host", "sql02.corp.local", "--database", "HRDB", "--user", "svc", "--auth", "ntlm", "--domain", "CORP", "--instance", "HR"];

const tempHomes = [];
after(() => tempHomes.forEach((home) => fs.rmSync(home, { recursive: true, force: true })));

function isolatedEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mssql-data-test-"));
  tempHomes.push(home);
  return { ...process.env, MSSQL_DATA_HOME: home, MSSQL_DATA_SECRET_BACKEND: "file" };
}

const cli = (env, args, input = "") => spawnSync(process.execPath, [CLI, ...args], { env, input, encoding: "utf8" });
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const fileMode = (file) => fs.statSync(file).mode & 0o777;

function probeMcp(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [LAUNCHER], { env, stdio: ["pipe", "pipe", "pipe"] });
    const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("MCP probe timed out"));
    }, DBHUB_TIMEOUT_MS);
    let buffer = "";
    let initialize;
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
    assert.deepEqual(validateServer({ id: "sales", host: "10.0.0.5", database: "SalesDB", user: "report_ro" }), {
      id: "sales",
      host: "10.0.0.5",
      port: 1433,
      database: "SalesDB",
      user: "report_ro",
      auth: "sql",
      sslmode: "require",
    });
  });

  test("rejects invalid input with a message per field", () => {
    const base = { id: "sales", host: "h", database: "d", user: "u" };
    assert.throws(() => validateServer({ ...base, id: "Sales-1" }), /id:/);
    assert.throws(() => validateServer({ ...base, port: "99999" }), /port:/);
    assert.throws(() => validateServer({ ...base, auth: "ntlm" }), /domain:/);
    assert.throws(() => validateServer({ ...base, user: "CORP\\jdoe" }), /awalan domain/);
    assert.throws(() => validateServer({ ...base, host: "bad host" }), /host:/);
    assert.throws(() => validateServer({ ...base, description: "two\nlines" }), /description:/);
  });
});

describe("buildDbhubToml", () => {
  const servers = [
    validateServer({ id: "sales", host: "10.0.0.5", database: "SalesDB", user: "report_ro", description: 'Sales "prod"' }),
    validateServer({ id: "hr", host: "sql02", database: "HRDB", user: "svc", auth: "ntlm", domain: "CORP", instance: "HR" }),
  ];
  const toml = buildDbhubToml(servers);

  test("creates one source and four read-only tools per server", () => {
    assert.equal(toml.match(/^\[\[sources\]\]$/gm).length, 2);
    assert.equal(toml.match(/^\[\[tools\]\]$/gm).length, 8);
    assert.equal(toml.match(/^readonly = true$/gm).length, 2);
  });

  test("references passwords through env vars only", () => {
    assert.match(toml, /^password = "\$\{MSSQL_DATA_PW_SALES\}"$/m);
    assert.match(toml, /^password = "\$\{MSSQL_DATA_PW_HR\}"$/m);
  });

  test("writes NTLM, named instance and escaped description fields", () => {
    assert.match(toml, /^authentication = "ntlm"$/m);
    assert.match(toml, /^domain = "CORP"$/m);
    assert.match(toml, /^instanceName = "HR"$/m);
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
    assert.match(added.stdout, /ditambahkan/);
    assert.equal(fileMode(servers), 0o600);
    assert.equal(fileMode(secrets), 0o600);
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
    const invalid = cli(env, ["add", "--id", "Bad Id", "--host", "h", "--database", "d", "--user", "u", "--password-stdin"], "x\n");
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Data server tidak valid/);

    const empty = cli(env, ["add", ...SALES, "--password-stdin"], "\n");
    assert.equal(empty.status, 2);
    assert.equal(fs.existsSync(path.join(env.MSSQL_DATA_HOME, "servers.json")), false);
    assert.equal(fs.existsSync(path.join(env.MSSQL_DATA_HOME, "secrets.json")), false);
  });

  test("rejects unknown commands", () => {
    const result = cli(isolatedEnv(), ["frobnicate"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Perintah tidak dikenal/);
  });
});

describe("macOS Keychain store", { skip: process.platform !== "darwin" || process.env.MSSQL_DATA_TEST_KEYCHAIN !== "1" }, () => {
  test("round-trips passwords with spaces, quotes, backslashes and non-ASCII characters", () => {
    const store = secretStore({ ...isolatedEnv(), MSSQL_DATA_SECRET_BACKEND: "keychain", MSSQL_DATA_KEYCHAIN_SERVICE: "mssql-data-selftest" });
    const secret = 'p@ss w0rd "quoted" \\back$lash ü€';
    try {
      store.set("selftest", secret);
      assert.equal(store.get("selftest"), secret);
      assert.equal(store.has("selftest"), true);
    } finally {
      store.delete("selftest");
    }
    assert.equal(store.has("selftest"), false);
  });

  test("launcher starts DBHub with a password read from the Keychain", { timeout: DBHUB_TIMEOUT_MS }, async () => {
    const env = { ...isolatedEnv(), MSSQL_DATA_SECRET_BACKEND: "keychain", MSSQL_DATA_KEYCHAIN_SERVICE: "mssql-data-selftest" };
    assert.equal(cli(env, ["add", ...SALES, "--password-stdin"], "s3cret ü\n").status, 0);
    try {
      const { tools } = await probeMcp(env);
      assert.deepEqual(tools, DBHUB_TOOLS);
    } finally {
      assert.equal(cli(env, ["remove", "--id", "sales"]).status, 0);
    }
    assert.equal(secretStore(env).has("sales"), false);
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

  test("starts DBHub with plain tool names for a single server", { timeout: DBHUB_TIMEOUT_MS }, async () => {
    const env = isolatedEnv();
    assert.equal(cli(env, ["add", ...SALES, "--password-stdin"], "s3cret\n").status, 0);
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
