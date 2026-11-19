// test/commands.test.ts — /mesh join parsing (D22): `join <room> as <alias>`.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseJoinArgs, registerCommands } from "../src/extension/commands.js";
import { parseMjoinArgs } from "../src/extension/mjoin-args.js";
import type { CommandDefinition, ExtensionAPI, SessionContext } from "../src/extension/pi-types.js";
import type { MeshRuntime } from "../src/extension/tools.js";
import type { PersistedIdentity } from "../src/shared/identity-store.js";

describe("parseJoinArgs", () => {
  it("plain room", () => {
    assert.deepEqual(parseJoinArgs(["ops"]), { room: "ops", observer: false });
  });

  it("room + observer", () => {
    assert.deepEqual(parseJoinArgs(["ops", "observer"]), { room: "ops", observer: true });
  });

  it("room as alias", () => {
    assert.deepEqual(parseJoinArgs(["ops", "as", "agent-1"]), {
      room: "ops",
      asAlias: "agent-1",
      observer: false,
    });
  });

  it("room as alias observer", () => {
    assert.deepEqual(parseJoinArgs(["ops", "as", "agent-1", "observer"]), {
      room: "ops",
      asAlias: "agent-1",
      observer: true,
    });
  });

  it("as alias without room (alias-only)", () => {
    assert.deepEqual(parseJoinArgs(["as", "agent-1"]), {
      asAlias: "agent-1",
      observer: false,
    });
  });

  it("no args", () => {
    assert.deepEqual(parseJoinArgs([]), { room: undefined, observer: false });
  });

  it("still ignores a second bare token in the legacy command", () => {
    assert.deepEqual(parseJoinArgs(["ops", "ignored"]), { room: "ops", observer: false });
  });
});

describe("/mjoin", () => {
  it("supports room only, both alias spellings, and observer in any position", () => {
    for (const [input, asAlias, observer] of [
      ["ops", undefined, false], ["ops fox", "fox", false], ["ops as fox", "fox", false],
      ["ops observer", undefined, true], ["ops fox observer", "fox", true],
      ["observer ops as fox", "fox", true], ["ops as observer fox", "fox", true],
      ["ops @observer", "@observer", false], ["ops as as", "as", false], ["ops @as", "@as", false],
    ] as const) {
      assert.deepEqual(parseMjoinArgs(input.split(" ")), { room: "ops", asAlias, observer }, input);
    }
  });

  it("rejects malformed input before rename, join, save, or refresh", async () => {
    const { mjoin, events, notifications } = joinHarness();
    for (const input of ["", "as fox", "observer", "ops as", "ops as observer", "ops fox yak",
      "ops observer observer", "ops --observer", "--ops", "ops as --new"]) {
      assert.equal(parseMjoinArgs(input.split(" ").filter(Boolean)), undefined, input);
      await mjoin(input);
      assert.match(notifications.at(-1) ?? "", /^usage: \/mjoin /);
    }
    assert.deepEqual(events, []);
  });

  it("reads the runtime at execution and preserves rename, persistence, session naming and refresh", async () => {
    const { mjoin, mesh, events, notifications, setOnline } = joinHarness();
    setOnline(false);
    await mjoin("ops fox");
    assert.equal(notifications.at(-1), "mesh: session not started");
    assert.deepEqual(events, []);
    setOnline(true);
    await mjoin("  ops  as  @Fox   observer ");
    assert.deepEqual(events, ["rename @Fox", "save fox default slot", "join ops observer",
      "save fox default,ops slot", "name mesh @fox · default,ops", "refresh"]);
    events.length = 0;
    await mesh("join team ignored");
    assert.deepEqual(events, ["join team member", "save fox default,ops,team slot", "name mesh @fox · default,ops,team", "refresh"]);
  });

  it("joins under the current alias when rename is refused", async () => {
    const { mjoin, events, notifications } = joinHarness({ refuseRename: true });
    await mjoin("ops fox");
    assert.deepEqual(events, ["rename fox", "join ops member", "save original default,ops slot",
      "name mesh @original · default,ops", "refresh"]);
    assert.match(notifications[0]!, /joining as @original/);
  });

  it("keeps a successful rename when joining fails", async () => {
    const { mjoin, events, notifications } = joinHarness({ failJoin: true });
    await mjoin("ops fox");
    assert.deepEqual(events, ["rename fox", "save fox default slot", "join ops member", "refresh"]);
    assert.match(notifications.at(-1)!, /join failed/);
  });
});

function joinHarness({ refuseRename = false, failJoin = false } = {}) {
  let online = true;
  const events: string[] = [];
  const notifications: string[] = [];
  const commands = new Map<string, CommandDefinition>();
  const pi = {
    registerCommand(name: string, def: CommandDefinition) { commands.set(name, def); },
    getSessionName: () => undefined,
    setSessionName(name: string) { events.push(`name ${name}`); },
  } as ExtensionAPI;
  const runtime = {
    sessionId: "test", identityKey: "slot",
    identity: { save: (identity: PersistedIdentity, key: string) => {
      events.push(`save ${identity.preferredAlias ?? identity.alias} ${identity.rooms.join(",")} ${key}`);
    } },
    client: {
      alias: "original", rooms: ["default"], reservations: [],
      async rename(alias: string) {
        events.push(`rename ${alias}`);
        if (refuseRename) return { ok: false, reason: "alias_taken" };
        this.alias = alias.replace(/^@/, "").toLowerCase();
        return { ok: true, alias: this.alias };
      },
      async join(room: string, role: string) {
        events.push(`join ${room} ${role}`);
        if (failJoin) throw new Error("invalid_room");
        this.rooms.push(room);
      },
    },
  } as unknown as MeshRuntime;
  const ctx: SessionContext = { cwd: process.cwd(), ui: {
    notify: (text) => notifications.push(text), setStatus() {}, setWidget() {},
  } };
  registerCommands(pi, () => online ? runtime : null, () => events.push("refresh"));
  return { events, notifications, setOnline(value: boolean) { online = value; },
    mjoin: (input: string) => commands.get("mjoin")!.handler(input, ctx),
    mesh: (input: string) => commands.get("mesh")!.handler(input, ctx) };
}
