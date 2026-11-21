export function add(list, text) { return [...list, { text, done: false }]; }
export function complete(list, index) { return list.map((t, j) => (j === index ? { ...t, done: true } : t)); }
export function format(list) { return list.map((t, i) => `${i + 1}. [${t.done ? 'x' : ' '}] ${t.text}`).join('\n'); }
