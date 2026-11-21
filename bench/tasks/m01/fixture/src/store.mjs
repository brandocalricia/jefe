import { createTodo } from './model.mjs';

const VERSION = 1;

export function emptyStore() {
  return { nextId: 1, todos: [] };
}

// text is the contents of the data file, or null when it does not exist yet.
export function parseStore(text) {
  if (text === null || text.trim() === '') return emptyStore();
  const data = JSON.parse(text);
  if (data.version !== VERSION) throw new Error(`unsupported data file version ${data.version}`);
  return { nextId: data.nextId, todos: data.todos.map((t) => createTodo(t)) };
}

export function serializeStore(store) {
  return JSON.stringify({ version: VERSION, nextId: store.nextId, todos: store.todos }, null, 2) + '\n';
}
