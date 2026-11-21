// What of a run's raw stream may be kept in bench/results (uploaded as a workflow artifact, public once the repository is):
// the transcript stays (it is the evidence for the score), but every rate-limit event (the account's usage windows,
// overage state) is dropped, and the system/init line loses the fields that describe the account or the machine.
// Pure: text in, text out. A line that is not JSON is kept as it is.

// Fields of the system/init line that say something about the account or the machine rather than the run.
export const INIT_DROP = ['apiKeySource', 'memory_paths', 'messaging_socket_path'];
// Any other init field whose name looks like an account, organisation, user or email field.
const ACCOUNT_KEY = /account|organi[sz]ation|^org_?id$|^org_?uuid$|email|user_?id|user_?uuid/i;

export function publicStream(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    let ev = null;
    try {
      ev = line.trim() ? JSON.parse(line) : null;
    } catch {
      ev = null;
    }
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
      out.push(line);
      continue;
    }
    if (ev.type === 'rate_limit_event' || 'rate_limit_info' in ev) continue;
    if (ev.type === 'system' && ev.subtype === 'init') {
      for (const k of Object.keys(ev)) if (INIT_DROP.includes(k) || ACCOUNT_KEY.test(k)) delete ev[k];
      out.push(JSON.stringify(ev));
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}
