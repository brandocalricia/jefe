import { addTodo, completeTodo, listTodos } from './commands.mjs';
import { formatList, formatTodo } from './format.mjs';
import { parseStore, serializeStore } from './store.mjs';

// io: { load() -> string | null, save(text), out(text) }
export function main(argv, io) {
  const [command, ...rest] = argv;
  try {
    const store = parseStore(io.load());
    if (command === 'add') {
      const { store: next, todo } = addTodo(store, rest.join(' '));
      io.save(serializeStore(next));
      io.out(`added ${formatTodo(todo)}\n`);
      return 0;
    }
    if (command === 'list') {
      const tags = [];
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--tag') {
          if (rest[i + 1] === undefined) throw new Error('--tag needs a value');
          tags.push(rest[++i]);
        } else if (rest[i].startsWith('--tag=')) {
          tags.push(rest[i].slice('--tag='.length));
        }
      }
      io.out(formatList(listTodos(store, { tags })));
      return 0;
    }
    if (command === 'done') {
      const id = Number(rest[0]);
      if (!Number.isInteger(id)) throw new Error('done needs a todo id');
      const { store: next, todo } = completeTodo(store, id);
      io.save(serializeStore(next));
      io.out(`completed ${formatTodo(todo)}\n`);
      return 0;
    }
    io.out('usage: todo <add|list|done> ...\n');
    return 2;
  } catch (e) {
    io.out(`error: ${e.message}\n`);
    return 1;
  }
}
