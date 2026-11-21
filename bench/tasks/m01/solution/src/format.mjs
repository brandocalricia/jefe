export function formatTodo(todo) {
  const tags = todo.tags && todo.tags.length ? ' ' + todo.tags.map((t) => `#${t}`).join(' ') : '';
  return `[${todo.done ? 'x' : ' '}] ${todo.id} ${todo.title}${tags}`;
}

export function formatList(todos) {
  if (todos.length === 0) return 'no todos\n';
  return todos.map(formatTodo).join('\n') + '\n';
}
