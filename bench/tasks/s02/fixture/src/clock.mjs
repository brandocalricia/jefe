// A clock is any object with now() -> milliseconds. Tests pass a fake one.
export const systemClock = { now: () => Date.now() };
