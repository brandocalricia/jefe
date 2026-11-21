import { createApi } from './api/index.mjs';
import { AuditLog } from './events/audit.mjs';
import { EventBus } from './events/bus.mjs';
import { createServices } from './services/index.mjs';
import { openDatabase } from './store/database.mjs';

const systemClock = () => new Date().toISOString();

// Wires the layers together. `clock` returns an ISO timestamp such as 2026-03-01T09:00:00.000Z.
export function createApp({ dataFile, clock = systemClock }) {
  const db = openDatabase(dataFile);
  const bus = new EventBus();
  const audit = new AuditLog({ db, bus });
  audit.attach();
  const services = createServices({ db, bus, clock, audit });
  const api = createApi({ services });
  return { db, bus, audit, services, api };
}
