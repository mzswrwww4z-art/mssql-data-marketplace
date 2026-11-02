#!/usr/bin/env node
// MCP entry point of the mssql-data plugin (Windows and macOS). Starts DBHub with one
// read-only source per server in servers.json, or a tool-less placeholder server while
// nothing usable is configured.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { DBHUB_PACKAGE, buildDbhubToml, loadServers, passwordEnvVar, registryPath, secretStore } from "./lib.mjs";

const PLUGIN_VERSION = JSON.parse(fs.readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8")).version;
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";
const METHOD_NOT_FOUND = -32601;

const log = (message) => process.stderr.write(`[mssql-data] ${message}\n`);

function main() {
  let servers;
  let store;
  try {
    servers = loadServers();
    store = secretStore();
  } catch (error) {
    log(error.message);
    return runPlaceholder(
      `The mssql-data server list could not be read (${error.message}). Fix ${registryPath()} or re-add the servers with /mssql-data:add-server, then start a new session.`,
    );
  }
  if (servers.length === 0) {
    return runPlaceholder(
      "No SQL Server is configured for the mssql-data plugin yet, so no database tools are available. Ask the user to run /mssql-data:add-server, then start a new session.",
    );
  }

  const readSecret = (id) => {
    try {
      return store.get(id);
    } catch (error) {
      log(`Cannot read the password of server "${id}": ${error.message}`);
      return null;
    }
  };
  const withSecrets = servers.map((server) => ({ server, secret: readSecret(server.id) }));
  const missing = withSecrets.filter(({ secret }) => secret === null).map(({ server }) => server.id);
  const ready = withSecrets.filter(({ secret }) => secret !== null);
  missing.forEach((id) => log(`Skipping server "${id}": no password stored. Set it with /mssql-data:manage-servers.`));
  if (ready.length === 0) {
    return runPlaceholder(
      `No password is stored for the configured SQL Server(s): ${missing.join(", ")}. Ask the user to set it with /mssql-data:manage-servers, then start a new session.`,
    );
  }
  const env = {
    ...process.env,
    ...Object.fromEntries(ready.map(({ server, secret }) => [passwordEnvVar(server.id), encodeURIComponent(secret)])),
  };
  return runDbhub(
    ready.map(({ server }) => server),
    env,
  );
}

function runDbhub(servers, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mssql-data-"));
  const config = path.join(dir, "dbhub.toml");
  fs.writeFileSync(config, buildDbhubToml(servers), { mode: 0o600 });
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  const { command, args, shell } = dbhubCommand(config);
  const child = spawn(command, args, { env, stdio: "inherit", shell, windowsHide: true });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    cleanup();
    log(`Could not start DBHub: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    cleanup();
    process.exit(code ?? (signal ? 1 : 0));
  });
}

const quoteForCmd = (arg) => `"${arg.replace(/"/g, '""')}"`;

function dbhubCommand(config) {
  const args = ["-y", DBHUB_PACKAGE, "--transport", "stdio", "--config", config];
  if (process.platform !== "win32") return { command: "npx", args, shell: false };
  // npx is a .cmd shim on Windows, which Node only starts through a shell. Run npm's npx
  // script with this Node binary instead, and fall back to the shim when it is elsewhere.
  const npxCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
  if (fs.existsSync(npxCli)) return { command: process.execPath, args: [npxCli, ...args], shell: false };
  return { command: "npx.cmd", args: args.map(quoteForCmd), shell: true };
}

/** Minimal MCP server with no tools whose instructions tell Claude how to add a server. */
function runPlaceholder(instructions) {
  const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", (line) => {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      return log("Ignoring a message that is not valid JSON");
    }
    if (request.id === undefined || request.id === null) return undefined; // notification
    if (request.method === "initialize") {
      return send({
        id: request.id,
        result: {
          protocolVersion: request.params?.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "mssql-data", version: PLUGIN_VERSION },
          instructions,
        },
      });
    }
    if (request.method === "tools/list") return send({ id: request.id, result: { tools: [] } });
    if (request.method === "ping") return send({ id: request.id, result: {} });
    return send({ id: request.id, error: { code: METHOD_NOT_FOUND, message: `Method not found: ${request.method}` } });
  });
  input.on("close", () => process.exit(0));
}

main();
