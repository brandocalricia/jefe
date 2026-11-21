export function formatTodo(todo) {
  return `[${todo.done ? 'x' : ' '}] ${todo.id} ${todo.title}`;
}

export function formatList(todos) {
  if (todos.length === 0) return 'no todos\n';
  return todos.map(formatTodo).join('\n') + '\n';
}
