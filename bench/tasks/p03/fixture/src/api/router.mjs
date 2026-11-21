function escapeRegExp(source) {
  return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// '/tasks/:id/move' becomes a regular expression plus the list of parameter names.
export function compile(pattern) {
  const keys = [];
  const source = pattern
    .split('/')
    .map((part) => {
      if (!part.startsWith(':')) return escapeRegExp(part);
      keys.push(part.slice(1));
      return '([^/]+)';
    })
    .join('/');
  return { regex: new RegExp(`^${source}$`), keys };
}

export function createRouter(routes) {
  const compiled = routes.map((route) => ({ ...route, ...compile(route.path) }));
  return {
    // Returns { route, params }, { methodNotAllowed: true } when only the method is wrong, or null.
    match(method, path) {
      const clean = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
      let pathMatched = false;
      for (const route of compiled) {
        const found = route.regex.exec(clean);
        if (!found) continue;
        pathMatched = true;
        if (route.method !== method) continue;
        const params = {};
        route.keys.forEach((key, index) => {
          params[key] = decodeURIComponent(found[index + 1]);
        });
        return { route, params };
      }
      return pathMatched ? { methodNotAllowed: true } : null;
    },
  };
}
