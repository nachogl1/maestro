/**
 * The MCP server editor shows a server's args as one text field. These two helpers convert
 * between that text and the args array so that loading an existing server and saving it
 * unchanged writes back exactly the same args.
 */

/**
 * Split the args text into args. Spaces separate args; single or double quotes group text
 * (spaces included) into one arg. Quotes can be mixed inside one arg (`a"b c"d` is `ab cd`),
 * and an empty pair of quotes is an empty arg. There is no backslash escaping.
 */
export function parseArgs(argsStr: string): string[] {
  if (!argsStr.trim()) return [];
  const args: string[] = [];
  let current = "";
  // True once the current arg has any content or quotes, so `""` yields an empty arg.
  let started = false;
  let inQuotes = false;
  let quoteChar = "";

  for (const char of argsStr) {
    if ((char === '"' || char === "'") && !inQuotes) {
      inQuotes = true;
      quoteChar = char;
      started = true;
    } else if (char === quoteChar && inQuotes) {
      inQuotes = false;
      quoteChar = "";
    } else if (char === " " && !inQuotes) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
    } else {
      current += char;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}

/** Quote one arg so `parseArgs` reads it back unchanged. Plain args are left as they are. */
function quoteArg(arg: string): string {
  if (arg !== "" && !/[\s"']/.test(arg)) return arg;
  if (!arg.includes('"')) return `"${arg}"`;
  if (!arg.includes("'")) return `'${arg}'`;
  // Both quote kinds: double-quote the runs between double quotes, and write each double
  // quote as '"'. parseArgs joins adjacent quoted runs into one arg.
  return arg
    .split('"')
    .map((part) => (part === "" ? "" : `"${part}"`))
    .join(`'"'`);
}

/** Join args into the editor's text, quoting any arg with spaces or quotes in it. */
export function formatArgs(args: readonly string[]): string {
  return args.map(quoteArg).join(" ");
}
