// A tiny synchronous publish/subscribe bus. Handlers for a type run first, then the '*' handlers.
// An error thrown by a handler propagates to the code that emitted the event.
export class EventBus {
  #handlers = new Map();

  on(type, handler) {
    if (!this.#handlers.has(type)) this.#handlers.set(type, new Set());
    this.#handlers.get(type).add(handler);
    return () => this.off(type, handler);
  }

  off(type, handler) {
    this.#handlers.get(type)?.delete(handler);
  }

  emit(event) {
    const direct = [...(this.#handlers.get(event.type) ?? [])];
    const wildcard = [...(this.#handlers.get('*') ?? [])];
    for (const handler of [...direct, ...wildcard]) handler(event);
    return event;
  }
}
