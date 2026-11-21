// One list of file extensions that say "text", shared by the secrets scan (TEXT_EXT) and `ask --in` (IN_EXT, a subset).
// No imports: both sides can import this file without a cycle.

// `ask --in` is allowed BY EXTENSION: plain text, markdown and source code only. No dot-files, no config formats (json, yaml, toml, ini, conf, env, xml), no key files.
export const IN_EXT = new Set(['txt', 'md', 'markdown', 'rst', 'csv', 'tsv', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'lua', 'sh', 'sql', 'html', 'css', 'scss', 'vue', 'svelte']);

// The secrets scan scans a file with one of these names as text even when it holds NUL bytes.
export const TEXT_EXT = new Set([...IN_EXT, 'pl', 'r', 'scala', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'json', 'jsonc', 'json5', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'properties',
  'xml', 'htm', 'less', 'env', 'tf', 'tfvars', 'gradle', 'log', 'pem', 'key', 'crt', 'ipynb', 'graphql', 'proto']);

const TEXT_NAMES = new Set(['makefile', 'gemfile', 'rakefile', 'procfile', 'jenkinsfile', '.envrc', '.pypirc', '.netrc', '.gitconfig', '.bashrc', '.zshrc', '.profile']);

// Does the file name (lower case, no folders) say it is text?
export function isTextBaseName(b) {
  if (TEXT_NAMES.has(b) || /^dockerfile(\..+)?$/.test(b) || /^\.npmrc/.test(b) || /^\.env(\..+)?$/.test(b)) return true;
  const i = b.lastIndexOf('.');
  return i > 0 && TEXT_EXT.has(b.slice(i + 1));
}
