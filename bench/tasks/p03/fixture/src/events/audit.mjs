// Records every event on the bus as an audit entry in the database. The services save the
// database after emitting, so the log does not write to disk itself.
export class AuditLog {
  constructor({ db, bus }) {
    this.db = db;
    this.bus = bus;
  }

  attach() {
    return this.bus.on('*', (event) => this.record(event));
  }

  record(event) {
    const entry = {
      id: this.db.nextId('audit'),
      at: event.at,
      type: event.type,
      actor: event.actor,
      subject: event.subject,
      data: event.data,
    };
    return this.db.audit.insert(entry);
  }

  // Newest entries first.
  list({ type, limit = 50 } = {}) {
    const entries = this.db.audit.all().reverse();
    return entries.filter((entry) => type === undefined || entry.type === type).slice(0, limit);
  }
}
