import { text } from './validation.mjs';

export function buildComment({ taskId, body, actor, now }) {
  return { taskId, body: text(body, 'body', { max: 2000, required: true }), author: actor, createdAt: now };
}
