import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CombinedAutocompleteProvider } from "@mariozechner/pi-tui";
import { registerCommands } from "../src/extension/commands.js";
import { MeshHud } from "../src/extension/hud.js";
import type { CommandDefinition, ExtensionAPI } from "../src/extension/pi-types.js";
import type { MeshRuntime } from "../src/extension/tools.js";

function setup() {
  let runtime: MeshRuntime | null = null;
  let hud: MeshHud | null = null;
  const commands = new Map<string, CommandDefinition>();
  const pi = { registerCommand(name: string, def: CommandDefinition) { commands.set(name, def); } } as ExtensionAPI;
  registerCommands(pi, () => runtime, undefined, () => hud);
  const provider = new CombinedAutocompleteProvider([...commands].map(([name, def]) => ({ name, ...def })), process.cwd());
  return {
    commands, provider,
    setRuntime(value: MeshRuntime) { runtime = value; },
    setHud(value: MeshHud) { hud = value; },
    async values(prefix: string, name = "mesh") {
      const complete = commands.get(name)?.getArgumentCompletions;
      assert.ok(complete, `/${name} registered argument completion`);
      return (await complete(prefix))?.map((item) => item.value) ?? [];
    },
  };
}

describe("/mesh argument completion", () => {
  it("suggests all subcommands and replaces the whole argument prefix", async () => {
    const { provider, values } = setup();
    assert.deepEqual(await values(""), ["status", "join", "leave", "alias", "new", "reset", "log", "ping", "stale", "broker", "inbox", "help"]);
    assert.deepEqual(await values("st"), ["status", "stale"]);
    assert.deepEqual(await values("unknown"), []);
    const line = "/mesh st";
    const result = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
    assert.ok(result);
    const item = result.items[0]!;
    assert.equal(item.value, "status");
    assert.ok(item.description);
    assert.deepEqual(provider.applyCompletion([line], 0, line.length, item, result.prefix).lines, ["/mesh status"]);
  });

  it("offers flags and actions without turning a bare command into an action", async () => {
    const { values } = setup();
    assert.deepEqual(await values("log o"), ["log on", "log off"]);
    assert.deepEqual(await values("inbox "), ["inbox ", "inbox flush"]);
    assert.deepEqual(await values("inbox f"), ["inbox flush"]);
    assert.deepEqual(await values("new --h"), ["new --history"]);
    assert.deepEqual(await values("status vm-env --d"), ["status vm-env --details"]);
    assert.deepEqual(await values("status --details "), []);
    assert.deepEqual(await values("ping agent"), []);
  });

  it("keeps typed room names first, also using only cached and joined rooms", async () => {
    const { values, setRuntime, setHud } = setup();
    assert.deepEqual(await values("join "), []);
    assert.deepEqual(await values("join room-n"), ["join room-n"]);
    let reads = 0;
    const status = async () => {
      ++reads;
      return { rooms: ["room-new", "foreign", "room-new", "UPPER", "as", "observer", "a".repeat(65)], peers: [] };
    };
    const runtime = { client: {
      rooms: ["local", "room-new"], isOnline: () => true, status,
      connect: () => assert.fail("completion must not connect"),
      join: () => assert.fail("completion must not join"),
      rename: () => assert.fail("completion must not rename"),
    } } as unknown as MeshRuntime;
    setRuntime(runtime);
    assert.deepEqual(await values("join "), ["join local", "join room-new"]);
    const hud = new MeshHud({ getRuntime: () => runtime });
    setHud(hud);
    hud.fetchStatus();
    await Promise.resolve();
    assert.deepEqual(await values("join "), ["join foreign", "join local", "join room-new"]);
    assert.deepEqual(await values("join room-n"), ["join room-n", "join room-new"]);
    assert.deepEqual(await values("join room-new"), ["join room-new"]);
    assert.equal(reads, 1, "only the explicit HUD refresh reads broker status");
  });

  it("keeps exact whitespace for a valid join and stops room suggestions at modifiers and aliases", async () => {
    const { provider, values } = setup();
    const line = "/mesh join  foo  ";
    const result = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
    assert.ok(result);
    assert.deepEqual(result.items.map(({ value }) => value), ["join  foo  ", "join  foo  as", "join  foo  observer"]);
    assert.deepEqual(provider.applyCompletion([line], 0, line.length, result.items[0]!, result.prefix).lines, [line]);
    assert.deepEqual(await values("join foo as "), []);
    assert.deepEqual(await values("join foo as al"), []);
    assert.deepEqual(await values("join foo as alice "), ["join foo as alice ", "join foo as alice observer"]);
    assert.deepEqual(await values("join foo ob"), ["join foo observer"]);
    assert.deepEqual(await values("join as ali"), []);
  });
});
