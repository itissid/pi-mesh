import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@mariozechner/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { registerCommands } from "../src/extension/commands.js";
import type { CommandDefinition, EntryRenderer, ExtensionAPI, RenderTheme, SessionContext } from "../src/extension/pi-types.js";
import {
  parseStatusArgs, renderStatusEntry, resolveStatusHosts, statusLines,
  STATUS_ENTRY, type StatusEntry,
} from "../src/extension/status.js";
import type { MeshRuntime } from "../src/extension/tools.js";

const status: StatusEntry = {
  capturedAt: Date.parse("2026-11-19T00:03:38.576Z"),
  options: { details: false },
  rooms: ["default", "vm-env"],
  peers: [
    { alias: "mac", rooms: ["default"], via: "tcp:100.73.184.27",
      host: "macbook-pi-web.example.ts.net", since: "2026-11-18T21:03:38.576Z" },
    { alias: "devbox", rooms: ["vm-env"] },
    { alias: "remote", rooms: ["default", "vm-env"], via: "tls:2001:db8::1" },
  ],
};

const theme: RenderTheme = {
  fg(color, text) {
    assert.ok(!["dim", "muted"].includes(color), "status text must be readable");
    return `\x1b[37m${text}\x1b[39m`;
  },
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
};

describe("/mesh status", () => {
  it("preserves the room filter and accepts --details in either order", () => {
    assert.deepEqual(parseStatusArgs([]), { room: undefined, details: false });
    assert.deepEqual(parseStatusArgs(["vm-env"]), { room: "vm-env", details: false });
    assert.deepEqual(parseStatusArgs(["--details"]), { room: undefined, details: true });
    for (const args of [["vm-env", "--details"], ["--details", "vm-env"]]) {
      assert.deepEqual(parseStatusArgs(args), { room: "vm-env", details: true });
    }
    assert.equal(parseStatusArgs(["--invalid"]), undefined);
    assert.equal(parseStatusArgs(["default", "vm-env"]), undefined);
  });

  it("looks up each remote IP only once and falls back on DNS errors or numeric answers", async () => {
    const seen: string[] = [];
    const hosts = await resolveStatusHosts([
      ...status.peers,
      { alias: "same-mac", rooms: [], via: "tls:100.73.184.27" },
      { alias: "numeric", rooms: [], via: "tcp:192.0.2.1" },
      { alias: "invalid", rooms: [], via: "tcp:?" },
    ], { lookup: async (ip) => {
      seen.push(ip);
      if (ip === "2001:db8::1") throw new Error("no PTR");
      return ip === "192.0.2.1" ? ip : "macbook-pi-web.example.ts.net.";
    } });
    assert.deepEqual(seen, ["100.73.184.27", "2001:db8::1", "192.0.2.1"]);
    assert.deepEqual([...hosts], [["100.73.184.27", "macbook-pi-web.example.ts.net"]]);
  });

  it("tries MagicDNS only for unresolved Tailscale-range addresses", async () => {
    const seen: string[] = [];
    const hosts = await resolveStatusHosts(status.peers, {
      lookup: async (ip) => ip,
      magicLookup: async (ip) => {
        seen.push(ip);
        return "macbook-pi-web.example.ts.net.";
      },
    });
    assert.deepEqual(seen, ["100.73.184.27"]);
    assert.deepEqual([...hosts], [["100.73.184.27", "macbook-pi-web.example.ts.net"]]);
  });

  it("returns already-resolved hosts even when another lookup stalls", async () => {
    let finish!: (value: string) => void;
    const slow = new Promise<string>((resolve) => { finish = resolve; });
    const hosts = await resolveStatusHosts(status.peers, {
      lookup: (ip) => ip === "100.73.184.27" ? Promise.resolve("fast.example.com") : slow,
      timeoutMs: 10,
    });
    finish("late.example.com");
    await slow;
    assert.deepEqual([...hosts], [["100.73.184.27", "fast.example.com"]]);
  });

  it("shows compact connection age and hostname or IP, with exact timestamps only in details", () => {
    assert.deepEqual(statusLines(status), [
      "Mesh peers (3)",
      "  @mac · default · via macbook-pi-web · 3h ago",
      "  @remote · default, vm-env · via 2001:db8::1",
      "  @devbox · vm-env",
      "Rooms: default, vm-env",
    ]);
    const details = statusLines({ ...status, options: { details: true } }).join("\n");
    assert.match(details, /since 2026-11-18T21:03:38.576Z · tcp:100.73.184.27 · macbook-pi-web.example.ts.net/);
    assert.match(details, /tls:2001:db8::1/);
  });

  it("shows minutes or days, handles fresh connections, and skips invalid times", () => {
    const rows = statusLines({ ...status, peers: [
      { alias: "new", rooms: ["default"], since: "2026-11-19T00:03:28.576Z" },
      { alias: "skewed", rooms: ["default"], since: "2026-11-19T00:03:39.576Z" },
      { alias: "minutes", rooms: ["default"], since: "2026-11-18T23:54:00.000Z" },
      { alias: "days", rooms: ["default"], since: "2026-11-16T00:00:00.000Z" },
      { alias: "invalid", rooms: ["default"], since: "invalid" },
    ] });
    assert.deepEqual(rows.slice(1, -1), [
      "  @skewed · default · just now",
      "  @new · default · just now",
      "  @minutes · default · 9m ago",
      "  @days · default · 3d ago",
      "  @invalid · default",
    ]);
  });

  it("sorts rooms alphabetically, then connections newest first without duplicating multi-room peers", () => {
    const lines = statusLines({ ...status, rooms: ["vm-env", "default"], peers: [
      { alias: "no-room", rooms: [] },
      { alias: "mouse", rooms: ["vm-env"], since: "2026-11-19T00:00:00Z" },
      ...status.peers.slice(0, 1),
      { alias: "multi", rooms: ["vm-env", "default"], since: "2026-11-19T00:00:00Z" },
    ] });
    assert.deepEqual(lines, [
      "Mesh peers (4)",
      "  @multi · default, vm-env · 3m ago",
      "  @mac · default · via macbook-pi-web · 3h ago",
      "  @mouse · vm-env · 3m ago",
      "  @no-room · (no rooms)",
      "Rooms: default, vm-env",
    ]);
  });

  it("matches room colors to the legend and distinguishes recent, older, and undated connections", () => {
    const colored: StatusEntry = { ...status, peers: [
      ...status.peers,
      { alias: "recent", rooms: ["default"], since: "2026-11-19T00:00:00Z" },
    ] };
    for (const appearance of ["dark", "light"] as const) {
      const colors = new Map<string, number[]>();
      const lines = renderStatusEntry(colored, 100, { ...theme, appearance, style(text, { fg }) {
        colors.set(text, [fg.r, fg.g, fg.b]);
        return `\x1b[38;2;${fg.r};${fg.g};${fg.b}m${text}\x1b[39m`;
      } });
      assert.deepEqual(lines.map(stripVTControlCharacters), statusLines(colored));
      for (const room of colored.rooms) {
        const color = colors.get(room);
        assert.ok(color);
        const token = `\x1b[38;2;${color.join(";")}m${room}\x1b[39m`;
        assert.ok(lines.some((line) => line.includes("@recent") && room === "default" && line.includes(token))
          || lines.some((line) => line.includes("@devbox") && room === "vm-env" && line.includes(token)));
        assert.ok(lines.at(-1)?.includes(token));
      }
      assert.notDeepEqual(colors.get("default"), colors.get("vm-env"));
      const recent = colors.get("@recent")!;
      const older = colors.get("@mac")!;
      assert.ok(recent[1]! > recent[0]! && recent[1]! > recent[2]!);
      assert.ok(older[0]! > older[1]! && older[0]! > older[2]!);
      assert.deepEqual(recent, colors.get("3m ago"));
      assert.deepEqual(older, colors.get("3h ago"));
      assert.equal(colors.has("@devbox"), false);
    }
  });

  it("uses readable theme colors and wraps to narrow terminals", () => {
    for (const width of [24, 40, 100]) {
      const lines = renderStatusEntry(status, width, theme);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.match(lines.join("\n"), /\x1b\[1m/);
    }
    assert.deepEqual(statusLines({ ...status, options: { details: false, room: "vm-env" }, peers: [] }),
      ["Mesh · no online peers in vm-env"]);
  });

  it("appends a TUI-only entry and falls back to plain notifications outside the TUI", async () => {
    let command: CommandDefinition | undefined;
    let renderer: EntryRenderer<StatusEntry> | undefined;
    let entry: StatusEntry | undefined;
    const notified: string[] = [];
    const ctx: SessionContext = {
      cwd: process.cwd(), mode: "tui",
      ui: { notify: (text) => notified.push(text), setStatus() {}, setWidget() {} },
    };
    const pi = {
      registerCommand(_name: string, def: CommandDefinition) { command = def; },
      registerEntryRenderer(name: string, fn: EntryRenderer<StatusEntry>) {
        assert.equal(name, STATUS_ENTRY);
        renderer = fn;
      },
      appendEntry(name: string, data: StatusEntry) {
        assert.equal(name, STATUS_ENTRY);
        entry = data;
      },
    } as ExtensionAPI;
    const rt = { client: { isOnline: () => true, status: async (room?: string) => {
      assert.equal(room, "vm-env");
      return { peers: [{ alias: "devbox", rooms: ["vm-env"] }], rooms: ["vm-env"] };
    } } } as MeshRuntime;
    registerCommands(pi, () => rt);
    assert.ok(command);
    assert.ok(renderer);
    await command.handler("status vm-env --details", ctx);
    assert.deepEqual(entry?.options, { details: true, room: "vm-env" });
    assert.ok(Number.isFinite(entry?.capturedAt));
    assert.match(renderer({ customType: STATUS_ENTRY, data: entry }, {}, theme)?.render(60).join("\n") ?? "", /@devbox/);
    assert.deepEqual(notified, []);
    entry = undefined;
    await command.handler("status vm-env", { ...ctx, mode: "rpc" });
    assert.equal(entry, undefined);
    assert.deepEqual(notified, ["Mesh peers (1) in vm-env\n  @devbox · vm-env\nRooms: vm-env"]);
  });
});
