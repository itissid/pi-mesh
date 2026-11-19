export const MJOIN_USAGE = "/mjoin <room> [<alias> | as <alias>] [observer]";

export interface MjoinArgs {
  room: string;
  asAlias?: string;
  observer: boolean;
}

/** Compact grammar only; the legacy /mesh join parser deliberately differs. */
export function parseMjoinArgs(args: readonly string[]): MjoinArgs | undefined {
  let observer = false;
  const operands: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-")) return undefined;
    if (arg === "observer") {
      if (observer) return undefined;
      observer = true;
    } else {
      operands.push(arg);
    }
  }
  const [room, aliasOrAs, explicitAlias] = operands;
  if (!room || room === "as") return undefined;
  if (aliasOrAs === "as") {
    if (operands.length !== 3 || !explicitAlias) return undefined;
    return { room, asAlias: explicitAlias, observer };
  }
  if (operands.length > 2) return undefined;
  return { room, asAlias: aliasOrAs, observer };
}
