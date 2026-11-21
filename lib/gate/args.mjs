// Option parsing: the known options per command and the unknown-option check.

// Every option name that takes a value, in any command: a scan skips the value that follows one (a goal text that reads `--helpers` is a value, not an option).
const VALUED = new Set();

// The value of the first `name` that is an option, not another option's value; '' when it has no value; null when absent.
export function optValue(args, name) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return i + 1 < args.length ? args[i + 1] : '';
    if (VALUED.has(args[i])) i++;
  }
  return null;
}

// Is the flag `name` given as an option (not as another option's value)?
export function hasFlag(args, name) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return true;
    if (VALUED.has(args[i])) i++;
  }
  return false;
}

// Known options per command: { flags, valued } (valued ones take the next argument as their value).
const OPTIONS = {
  size: { flags: [], valued: ['--base', '--since'] },
  secrets: { flags: ['--staged'], valued: [] },
  tests: { flags: [], valued: ['--timeout'] },
  context: { flags: [], valued: ['--level'] },
  cost: { flags: [], valued: [] },
  all: { flags: [], valued: ['--timeout', '--deadline', '--since'] },
  verify: { flags: [], valued: ['--deadline', '--since', '--stage'] },
  finish: { flags: ['--no-tests'], valued: ['--deadline', '--since', '--plan', '--stage', '--goal', '--note', '--commit', '--review'] },
  allow: { flags: ['--clear', '--show'], valued: [] },
  park: { flags: [], valued: ['--reason'] },
  push: { flags: [], valued: ['--review'] },
  level: { flags: ['--project'], valued: [] },
  knobs: { flags: [], valued: ['--level'] },
  start: { flags: ['--guide'], valued: ['--level', '--words'] },
  go: { flags: ['--resume'], valued: ['--goal', '--done', '--out', '--ref', '--why', '--free', '--answer', '--pref', '--branch', '--name', '--allow-kind', '--allow-cmd', '--allow-provider', '--push-to', '--stage', '--helpers', '--helper-model'] },
  amend: { flags: [], valued: ['--goal', '--done', '--out', '--ref', '--answer', '--stage', '--drop-stage', '--note'] },
  ask: { flags: [], valued: ['--provider', '--use', '--model', '--max-out', '--in', '--timeout'] },
  'runfile-path': { flags: [], valued: [] },
};

for (const o of Object.values(OPTIONS)) for (const v of o.valued) VALUED.add(v);

// The first unknown option-looking argument, or null. Everything after a literal -- in verify is a command.
export function badOption(cmd, args) {
  const o = OPTIONS[cmd];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((cmd === 'verify' || cmd === 'finish' || cmd === 'allow' || cmd === 'ask') && a === '--') return null;
    if (o.valued.includes(a)) i++;
    else if (a.startsWith('-') && a.length > 1 && !o.flags.includes(a) && !(cmd === 'level' && i > 0 && args[0] === 'set' && !a.startsWith('--'))) return a;
  }
  return null;
}
// go and allow take no positional words: the first word that is neither one of their options nor an option's value (a literal -- included),
// or null. Other commands are not checked here (finish, verify and ask take commands after --; level takes set/unset and a value).
export function strayWord(cmd, args) {
  if (cmd !== 'go' && cmd !== 'allow') return null;
  const o = OPTIONS[cmd];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (o.valued.includes(a)) i++;
    else if (!o.flags.includes(a) && !(a.startsWith('-') && a.length > 1 && a !== '--')) return a;
  }
  return null;
}
// Every value of a repeatable option in the gate's own arguments.
export function optValues(args, name) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) {
      if (i + 1 < args.length) out.push(args[++i]);
    } else if (VALUED.has(args[i])) i++;
  }
  return out;
}
