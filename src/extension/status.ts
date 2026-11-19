import { lookupService, Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import { wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { StatusSnapshot } from "../client/client.js";
import type { RenderTheme } from "./pi-types.js";

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

function connectionAge(since?: string, capturedAt?: number): string | undefined {
  if (!since || capturedAt === undefined) return undefined;
  const minutes = Math.floor((capturedAt - Date.parse(since)) / 60_000);
  if (!Number.isFinite(minutes)) return undefined;
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / (24 * 60))}d ago`;
}

export function statusLines(entry: StatusEntry, theme?: RenderTheme): string[] {
  const { options, rooms, peers } = entry;
  const text = (line: string) => theme?.fg("text", line) ?? line;
  const heading = (line: string) => theme?.bold?.(text(line)) ?? text(line);
  const scope = options.room ? ` in ${options.room}` : "";
  if (peers.length === 0) return [heading(`Mesh · no online peers${scope}`)];

  const lines = [heading(`Mesh peers (${peers.length})${scope}`)];
  for (const peer of peers) {
    const host = peer.host?.replace(/\.([^.]+)\.ts\.net$/i, "");
    const origin = host ?? originAddress(peer.via) ?? peer.via;
    const alias = heading(`@${peer.alias}`);
    const memberships = peer.rooms.join(", ") || "(no rooms)";
    const age = connectionAge(peer.since, entry.capturedAt);
    const summary = [memberships, origin && `via ${origin}`, age].filter(Boolean).join(" · ");
    lines.push(`  ${alias}${text(` · ${summary}`)}`);
    if (options.details) {
      const details = [peer.since && `since ${peer.since}`, peer.via, peer.host !== host && peer.host]
        .filter(Boolean).join(" · ");
      if (details) lines.push(text(`    ${details}`));
    }
  }
  lines.push(text(`Rooms: ${rooms.join(", ") || "(none)"}`));
  return lines;
}

export function renderStatusEntry(entry: StatusEntry, width: number, theme: RenderTheme): string[] {
  return statusLines(entry, theme).flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
}
