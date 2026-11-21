export const DEFAULT_RETENTION = { maxEntries: 500, maxAgeDays: 90 };

const DAY_MS = 86400000;
// Membership and workspace changes are a security trail: they are never pruned and never counted.
const EXEMPT = /^(workspace|member)\./;

// Records every event on the bus as an audit entry in the database, then prunes the workspace's
// log by the retention rule. The services save the database after emitting, so the log does not
// write to disk itself.
export class AuditLog {
  constructor({ db, bus, retention = {} }) {
    this.db = db;
    this.bus = bus;
    this.retention = { ...DEFAULT_RETENTION, ...retention };
  }

  attach() {
    return this.bus.on('*', (event) => this.record(event));
  }

  record(event) {
    const entry = this.db.audit.insert({
      id: this.db.nextId('audit'),
      at: event.at,
      type: event.type,
      actor: event.actor,
      workspaceId: event.workspaceId,
      subject: event.subject,
      data: event.data,
    });
    this.prune(entry);
    return entry;
  }

  // Applies to the workspace of `entry` only: first the age limit, then the count limit.
  prune(entry) {
    const { maxEntries, maxAgeDays } = this.retention;
    const cutoff = Date.parse(entry.at) - maxAgeDays * DAY_MS;
    const candidates = this.db.audit.findBy('workspaceId', entry.workspaceId).filter((e) => !EXEMPT.test(e.type));
    const live = [];
    for (const candidate of candidates) {
      if (Date.parse(candidate.at) < cutoff) this.db.audit.remove(candidate.id);
      else live.push(candidate);
    }
    for (const stale of live.slice(0, Math.max(0, live.length - maxEntries))) this.db.audit.remove(stale.id);
  }

  // Newest entries of one workspace first.
  list({ workspaceId, type, limit = 50 }) {
    const entries = this.db.audit.findBy('workspaceId', workspaceId).reverse();
    return entries.filter((entry) => type === undefined || entry.type === type).slice(0, limit);
  }
}
