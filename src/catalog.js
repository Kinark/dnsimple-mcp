// The command catalog is read from the CLI itself (`dnsimple ai --full`), so
// the MCP tracks whatever CLI version is installed instead of a frozen copy.

// Commands the MCP owns (auth) or that make no sense over MCP.
const EXCLUDED_GROUPS = new Set(['auth', 'ai', 'completion', 'help']);

// Leaf verbs that only read. Anything unlisted is treated as a write, so a
// verb added by a future CLI release lands on the cautious side.
const READ_VERBS = new Set([
  'list', 'get', 'status', 'check', 'prices', 'query', 'charges',
  'check-distribution', 'file', 'applied', 'extended-attributes',
  'whoami', 'download', 'private-key',
]);

export function isReadOnly(command) {
  return READ_VERBS.has(command.split(' ').at(-1));
}

/** Collapse whitespace and resolve aliases to the canonical command path. */
export function normalizeCommand(input, aliases = {}) {
  let words = String(input).trim().split(/\s+/).filter(Boolean);
  if (words[0] === 'dnsimple') words = words.slice(1);
  if (words.length && aliases[words[0]]) {
    words = [...aliases[words[0]].split(' '), ...words.slice(1)];
  }
  return words.join(' ');
}

/**
 * Parse the markdown printed by `dnsimple ai --full`.
 * Returns { commands: Map<path, Command>, aliases: Record<alias, path> }.
 */
export function parseCatalog(markdown) {
  const commands = new Map();
  const aliases = {};
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => /^## Commands\s*$/.test(l));
  if (start === -1) return { commands, aliases };

  let group = null; // { path, summary, hasCommands }
  let current = null;

  const closeGroup = () => {
    // A heading with no bullets is itself a command (e.g. `whoami`).
    if (group && !group.hasCommands && !EXCLUDED_GROUPS.has(group.path.split(' ')[0])) {
      addCommand(group.path, '', group.summary);
    }
  };

  const addCommand = (path, argSpec, summary) => {
    const positionals = [];
    for (const m of argSpec.matchAll(/(\[)?<([^>]+)>\]?/g)) {
      positionals.push({ name: m[2], required: !m[1] });
    }
    current = { path, summary, positionals, flags: new Map(), readOnly: isReadOnly(path) };
    commands.set(path, current);
  };

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^## /.test(line)) break;

    const heading = line.match(/^### (.+?)\s*$/);
    if (heading) {
      closeGroup();
      current = null;
      const alias = heading[1].match(/^(\S+) \(alias for `(.+)`\)$/);
      if (alias) {
        aliases[alias[1]] = alias[2];
        group = null;
      } else {
        group = { path: heading[1], summary: '', hasCommands: false };
      }
      continue;
    }
    if (!group) continue;

    const aliasLine = line.match(/^Aliases: (.+)$/);
    if (aliasLine) {
      for (const a of aliasLine[1].split(',')) aliases[a.trim()] = group.path;
      continue;
    }

    const cmd = line.match(/^- `([^`]+)`: (.*)$/);
    if (cmd) {
      group.hasCommands = true;
      if (EXCLUDED_GROUPS.has(group.path.split(' ')[0])) { current = null; continue; }
      const [verb, ...rest] = cmd[1].split(' ');
      addCommand(`${group.path} ${verb}`, rest.join(' '), cmd[2].trim());
      continue;
    }

    const flag = line.match(/^ {2}- `(?:-\w, )?--([\w-]+)`: (.*)$/);
    if (flag && current) {
      const required = /\*\*\(required\)\*\*/.test(flag[2]);
      current.flags.set(flag[1], {
        description: flag[2].replace(/\s*\*\*\(required\)\*\*/, '').trim(),
        required,
      });
      continue;
    }

    if (line.trim() && !group.summary && !line.startsWith(' ') && !group.hasCommands) {
      group.summary = line.trim();
    }
  }
  closeGroup();
  return { commands, aliases };
}

/** One-line usage string for error messages and the command index. */
export function usage(cmd) {
  const args = cmd.positionals.map((p) => (p.required ? `<${p.name}>` : `[<${p.name}>]`));
  return [cmd.path, ...args].join(' ');
}
