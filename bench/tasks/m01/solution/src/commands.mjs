import { createTodo, splitTags } from './model.mjs';

export function addTodo(store, rawTitle) {
  const { title, tags } = splitTags(rawTitle);
  if (title === '') throw new Error('title is empty');
  const todo = createTodo({ id: store.nextId, title, tags });
  return { store: { nextId: store.nextId + 1, todos: [...store.todos, todo] }, todo };
}

export function listTodos(store, { tags = [] } = {}) {
  const wanted = tags.map((t) => t.replace(/^#/, '').toLowerCase());
  return store.todos.filter((t) => wanted.every((w) => t.tags.includes(w)));
}

export function completeTodo(store, id) {
  const found = store.todos.find((t) => t.id === id);
  if (!found) throw new Error(`no todo with id ${id}`);
  const todos = store.todos.map((t) => (t.id === id ? { ...t, done: true } : t));
  return { store: { ...store, todos }, todo: { ...found, done: true } };
}
