import { lookupService, Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import { wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { StatusSnapshot } from "../client/client.js";
import type { RenderTheme, ThemeColor } from "./pi-types.js";

export const STATUS_ENTRY = "mesh-status";
export const STATUS_USAGE = "/mesh status [room] [--details]";

export interface StatusOptions {
  room?: string;
  details: boolean;
}

export function parseStatusArgs(args: string[]): StatusOptions | undefined {
  const rooms = args.filter((arg) => arg !== "--details");
  if (rooms.length > 1 || rooms[0]?.startsWith("-")) return undefined;
  return { room: rooms[0], details: args.includes("--details") };
}

function originAddress(via?: string): string | undefined {
  const address = /^(?:tcp|tls):(.+)$/.exec(via ?? "")?.[1];
  return address && isIP(address) ? address : undefined;
}

const systemLookup = async (address: string): Promise<string> =>
  (await lookupService(address, 0)).hostname;

function isTailnetAddress(ip: string): boolean {
  if (isIP(ip) === 6) return /^fd7a:115c:a1e0:/i.test(ip);
  const [first, second = 0] = ip.split(".").map(Number);
  return first === 100 && second >= 64 && second <= 127;
}

async function hostname(lookup: () => Promise<string | undefined>): Promise<string | undefined> {
  try {
    const name = (await lookup())?.replace(/\.$/, "");
    // getnameinfo may return a numeric address when there's no hostname.
    if (name && name.length <= 253 && !isIP(name) && name.split(".").every(
      (label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label),
    )) return name;
  } catch {
    // Unavailable DNS is normal on some peers' networks.
  }
  return undefined;
}

/** Try the system resolver, then MagicDNS for Tailscale-range addresses only.
 * Containers may be able to reach MagicDNS even when NSS doesn't use it. */
export async function resolveStatusHosts(
  peers: StatusSnapshot["peers"],
  {
    lookup = systemLookup,
    magicLookup,
    timeoutMs = 350,
  }: {
    lookup?: (address: string) => Promise<string>;
    magicLookup?: (address: string) => Promise<string | undefined>;
    timeoutMs?: number;
  } = {},
): Promise<Map<string, string>> {
  const addresses = new Set(peers.map((peer) => originAddress(peer.via)).filter((ip) => ip !== undefined));
  const hosts = new Map<string, string>();
  if (addresses.size === 0) return hosts;

  let resolver: Resolver | undefined;
  const reverseMagic = magicLookup ?? (async (ip: string) => {
    if (!resolver) {
      resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
      resolver.setServers(["100.100.100.100"]);
    }
    return (await resolver.reverse(ip))[0];
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  try {
    await Promise.race([
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
      Promise.all([...addresses].map(async (ip) => {
        let name = await hostname(() => lookup(ip));
        if (!name && !expired && isTailnetAddress(ip)) name = await hostname(() => reverseMagic(ip));
        if (!expired && name) hosts.set(ip, name);
      })),
    ]);
    return hosts;
  } finally {
    expired = true;
    clearTimeout(timer);
    resolver?.cancel();
  }
}

export interface StatusEntry {
  // Older saved transcript entries don't have a capture time.
  capturedAt?: number;
  options: StatusOptions;
  rooms: string[];
  peers: { alias: string; rooms: string[]; via?: string; since?: string; host?: string }[];
}

export async function makeStatusEntry(snap: StatusSnapshot, options: StatusOptions): Promise<StatusEntry> {
  const capturedAt = Date.now();
  const hosts = await resolveStatusHosts(snap.peers);
  return {
    capturedAt,
    options,
    rooms: snap.rooms,
    peers: snap.peers.map(({ alias, rooms, via, since }) => ({
      alias, rooms, via, since, host: hosts.get(originAddress(via) ?? ""),
    })),
  };
}

const MINUTE_MS = 60_000;

type StatusColor = readonly [fallback: ThemeColor, dark: number, light: number];

// Keep room hues separate from the green/red connection-age cue.
const ROOM_COLORS: readonly StatusColor[] = [
  ["mdLink", 0x72dcff, 0x005979],
  ["accent", 0xcaa4ff, 0x6036a1],
  ["warning", 0xffdc73, 0x6e5100],
  ["syntaxFunction", 0x8bb3ff, 0x204d9d],
  ["syntaxKeyword", 0xffa6e6, 0x8c266e],
  ["syntaxType", 0x63e2d0, 0x006252],
  ["syntaxNumber", 0xffbc89, 0x884013],
] as const;
const RECENT: StatusColor = ["success", 0x75ef8b, 0x00652e];
const OLDER: StatusColor = ["error", 0xff6b73, 0xa51c34];

function paint(theme: RenderTheme | undefined, color: StatusColor, text: string): string {
  if (!theme) return text;
  if (!theme.style) return theme.fg(color[0], text);
  const rgb = theme.appearance === "light" ? color[2] : color[1];
  return theme.style(text, { fg: { kind: "rgb", r: rgb >> 16, g: (rgb >> 8) & 255, b: rgb & 255 } });
}

function connectionAge(minutes: number): string | undefined {
  if (!Number.isFinite(minutes)) return undefined;
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / (24 * 60))}d ago`;
}

export function statusLines(entry: StatusEntry, theme?: RenderTheme): string[] {
  const { options, rooms, peers } = entry;
  const text = (line: string) => theme?.fg("text", line) ?? line;
  const bold = (line: string) => theme?.bold?.(line) ?? line;
  const compareNames = (a: string, b: string) => a.localeCompare(b, "en");
  const orderedRooms = [...rooms].sort(compareNames);
  const paletteRooms = [...new Set([...rooms, ...peers.flatMap((peer) => peer.rooms)])].sort(compareNames);
  const roomColors = new Map(paletteRooms.map((room, i) => [room, ROOM_COLORS[i % ROOM_COLORS.length]!]));
  const roomName = (room: string) => {
    const color = roomColors.get(room);
    return color ? paint(theme, color, room) : text(room);
  };
  const scope = options.room ? text(" in ") + roomName(options.room) : "";
  if (peers.length === 0) return [bold(text("Mesh · no online peers") + scope)];

  const orderedPeers = peers.map((peer) => ({
    ...peer, rooms: [...peer.rooms].sort(compareNames), connectedAt: Date.parse(peer.since ?? ""),
  })).sort((a, b) => {
    const roomA = a.rooms[0];
    const roomB = b.rooms[0];
    if (roomA !== undefined && roomB !== undefined) {
      const byRoom = compareNames(roomA, roomB);
      if (byRoom) return byRoom;
    } else if (roomA !== roomB) {
      return roomA === undefined ? 1 : -1;
    }
    const newestFirst = (Number.isFinite(b.connectedAt) ? b.connectedAt : -Infinity)
      - (Number.isFinite(a.connectedAt) ? a.connectedAt : -Infinity);
    return newestFirst || compareNames(a.alias, b.alias);
  });
  const comma = text(", ");
  const separator = text(" · ");
  const lines = [bold(text(`Mesh peers (${peers.length})`) + scope)];
  for (const peer of orderedPeers) {
    const host = peer.host?.replace(/\.([^.]+)\.ts\.net$/i, "");
    const origin = host ?? originAddress(peer.via) ?? peer.via;
    const minutes = Math.floor(((entry.capturedAt ?? NaN) - peer.connectedAt) / MINUTE_MS);
    const age = connectionAge(minutes);
    const ageColor = minutes < 60 ? RECENT : OLDER;
    const name = `@${peer.alias}`;
    const fields = [bold(age ? paint(theme, ageColor, name) : text(name)),
      peer.rooms.map(roomName).join(comma) || text("(no rooms)")];
    if (origin) fields.push(text(`via ${origin}`));
    if (age) fields.push(paint(theme, ageColor, age));
    lines.push(`  ${fields.join(separator)}`);
    if (options.details) {
      const details = [peer.since && `since ${peer.since}`, peer.via, peer.host !== host && peer.host]
        .filter(Boolean).join(" · ");
      if (details) lines.push(text(`    ${details}`));
    }
  }
  lines.push(text("Rooms: ") + (orderedRooms.map(roomName).join(comma) || text("(none)")));
  return lines;
}

export function renderStatusEntry(entry: StatusEntry, width: number, theme: RenderTheme): string[] {
  return statusLines(entry, theme).flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
}
