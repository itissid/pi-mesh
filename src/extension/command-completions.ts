import { isValidRoom } from "../protocol/envelope.js";
import { parseMjoinArgs } from "./mjoin-args.js";
import type { CommandCompletion } from "./pi-types.js";

const COMMANDS = [
  ["status", "Show online peers, rooms, and hosts"],
  ["join", "Join or create a room"],
  ["leave", "Leave a room"],
  ["alias", "Show or change this session's alias"],
  ["new", "Start a fresh Pi session"],
  ["reset", "Reset the mesh identity"],
  ["log", "Show or set transcript logging"],
  ["ping", "Ping a peer"],
  ["stale", "Show reservations and their ages"],
  ["broker", "Show broker and connection information"],
  ["inbox", "List or flush deferred broadcasts"],
  ["help", "Show mesh command usage"],
] as const;

type Hint = readonly [label: string, description: string];
const AS: Hint = ["as", "Choose an alias before joining"];
const OBSERVER: Hint = ["observer", "Join as an observer"];
const DETAILS: Hint = ["--details", "Show timestamps and raw addresses"];
const STATIC_ARGS: Readonly<Partial<Record<string, readonly Hint[]>>> = {
  log: [["on", "Enable transcript logging"], ["off", "Disable transcript logging"]],
  inbox: [["flush", "Deliver deferred broadcasts now"]],
  new: [["--history", "Carry recent mesh frames into the fresh session"]],
};

function matching(before: string, prefix: string, hints: readonly Hint[]): CommandCompletion[] {
  return hints.filter(([label]) => label.startsWith(prefix))
    .map(([label, description]) => ({ value: before + label, label, description }));
}

function keepTyped(raw: string, items: CommandCompletion[]): CommandCompletion[] {
  // Pi can apply the selected completion on Enter instead of submitting it.
  // Keep a valid command unchanged, including its trailing whitespace.
  if (items.length > 0) items.unshift({ value: raw, label: raw.trim(), description: "Keep typed command" });
  return items;
}

function roomOperand(value: string): boolean {
  return value !== "as" && value !== "observer" && isValidRoom(value);
}

/** `before` is the already typed subcommand and separator, or empty at a command root. */
export function completeJoin(raw: string, before: string, rooms: readonly string[], compact = false): CommandCompletion[] {
  const [room, rest] = splitFirst(raw);
  if (rest === undefined) {
    const matches = [...new Set(rooms)].filter((name) => roomOperand(name) && name.startsWith(room)).sort();
    const items = matching(before, room, matches.map((name) => [name, "Known mesh room"]));
    if (roomOperand(room) && !matches.includes(room)) {
      items.unshift({ value: before + room, label: room, description: "Use typed name; create on join if absent" });
    }
    return items;
  }
  if (!roomOperand(room)) return [];
  const { tokens, fixed, prefix } = partialToken(rest);
  const argsBefore = before + raw.slice(0, raw.length - rest.length) + fixed;
  if (compact) {
    const parsed = parseMjoinArgs(argsBefore.trim().split(/\s+/));
    const hints = parsed ? [...(parsed.asAlias ? [] : [AS]), ...(parsed.observer ? [] : [OBSERVER])] : [];
    const items = matching(argsBefore, prefix, hints).filter(({ value }) => value !== before + raw);
    const typed = (before + raw).trim().split(/\s+/);
    return parseMjoinArgs(typed) ? keepTyped(before + raw, items) : items;
  }
  const modifiers = tokens.join(" ");
  const hints = tokens.length === 0 ? [AS, OBSERVER]
    : modifiers === "observer" ? [AS]
    : tokens.length === 2 && tokens[0] === "as" && tokens[1] !== "observer" ? [OBSERVER]
    : [];
  const items = matching(argsBefore, prefix, hints);
  return prefix === "" ? keepTyped(before + raw, items) : items;
}

/** Preserve the raw separator; undefined means the first token is still being typed. */
function splitFirst(raw: string): [string, string?] {
  const match = /^(\S*)\s+/.exec(raw);
  return match ? [match[1]!, raw.slice(match[0].length)] : [raw];
}

function partialToken(raw: string): { tokens: string[]; fixed: string; prefix: string } {
  const prefix = /\S*$/.exec(raw)![0];
  const fixed = raw.slice(0, raw.length - prefix.length);
  return { tokens: fixed.split(/\s+/).filter(Boolean), fixed, prefix };
}

export function completeMjoin(raw: string, rooms: readonly string[]): CommandCompletion[] | null {
  const before = /^\s*(?:observer\s+)?/.exec(raw)![0];
  const items = completeJoin(raw.slice(before.length), before, rooms, true);
  return items.length > 0 ? items : null;
}

export function completeMesh(raw: string, getRooms: () => readonly string[]): CommandCompletion[] | null {
  const input = raw.trimStart();
  const [sub, args] = splitFirst(input);
  const leading = raw.slice(0, raw.length - input.length);
  if (args === undefined) {
    const items = matching(leading, sub, COMMANDS);
    return items.length > 0 ? items : null;
  }
  const before = raw.slice(0, raw.length - args.length);
  let items: CommandCompletion[] = [];
  if (sub === "join") {
    items = completeJoin(args, before, getRooms());
  } else {
    const { tokens, fixed, prefix } = partialToken(args);
    const hints = sub === "status" && (tokens.length === 0 || (tokens.length === 1 && isValidRoom(tokens[0]!)))
      ? [DETAILS] : tokens.length === 0 && Object.hasOwn(STATIC_ARGS, sub) ? STATIC_ARGS[sub]! : [];
    items = matching(before + fixed, prefix, hints);
    if (prefix === "") keepTyped(raw, items);
  }
  return items.length > 0 ? items : null;
}
