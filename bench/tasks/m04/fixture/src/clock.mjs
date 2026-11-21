// A clock is any object with now() -> whole seconds since some fixed point.
// Tests pass a fake one.
export const systemClock = { now: () => Date.now() };
