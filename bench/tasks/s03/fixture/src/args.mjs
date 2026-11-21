export class UsageError extends Error {}

function positiveInt(name, text) {
  if (!/^[0-9]+$/.test(text) || Number(text) < 1) {
    throw new UsageError(`${name} needs a positive whole number, got "${text}"`);
  }
  return Number(text);
}

// long flag -> spec
const OPTIONS = {
  '--top': { key: 'top', short: '-t', value: true, parse: positiveInt },
  '--ignore-blank': { key: 'ignoreBlank', short: '-b', value: false },
  '--help': { key: 'help', short: '-h', value: false },
};

export const HELP = `usage: linestat <file> [options]

options:
  -t, --top N         show the N longest lines (default 5)
  -b, --ignore-blank  skip blank lines
  -h, --help          show this help
`;

export function parseArgs(argv) {
  const opts = { top: 5, ignoreBlank: false, help: false };
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let inline = null;
    if (arg.startsWith('--') && arg.includes('=')) {
      inline = arg.slice(arg.indexOf('=') + 1);
      arg = arg.slice(0, arg.indexOf('='));
    }
    if (!arg.startsWith('-')) {
      files.push(arg);
      continue;
    }
    const long = OPTIONS[arg] ? arg : Object.keys(OPTIONS).find((k) => OPTIONS[k].short === arg);
    if (!long) throw new UsageError(`unknown option ${arg}`);
    const spec = OPTIONS[long];
    if (!spec.value) {
      opts[spec.key] = true;
      continue;
    }
    const raw = inline ?? argv[++i];
    if (raw === undefined) throw new UsageError(`${long} needs a value`);
    opts[spec.key] = spec.parse(long, raw);
  }
  if (!opts.help && files.length !== 1) throw new UsageError('expected exactly one file');
  return { file: files[0], ...opts };
}
