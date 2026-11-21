export function formatIssues(issues) {
  return issues
    .map(({ path, message }) => {
      let text = '';
      for (const part of path) text += typeof part === 'number' ? `[${part}]` : text === '' ? part : `.${part}`;
      return `${text === '' ? '(root)' : text}: ${message}`;
    })
    .join('\n');
}
