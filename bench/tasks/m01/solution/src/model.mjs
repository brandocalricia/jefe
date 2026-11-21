export function createTodo({ id, title, done = false, tags = [] }) {
  return { id, title, done, tags: [...tags] };
}

// "Buy milk #Home #errands #home" -> { title: "Buy milk", tags: ["home", "errands"] }
export function splitTags(rawTitle) {
  const words = [];
  const tags = [];
  for (const word of rawTitle.split(/\s+/).filter(Boolean)) {
    const m = /^#([\p{L}\p{N}_-]+)$/u.exec(word);
    if (m) {
      const tag = m[1].toLowerCase();
      if (!tags.includes(tag)) tags.push(tag);
    } else {
      words.push(word);
    }
  }
  return { title: words.join(' '), tags };
}
