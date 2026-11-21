// The contract every validator follows.
//
//   validator.parse(input, path = [])
//     -> { ok: true, value }
//      | { ok: false, issues: [{ path: (string | number)[], message: string }, ...] }
//
// `path` is where `input` sits inside the whole document being validated; every issue a
// validator reports has a path that starts with it. A validator never throws for bad input.

export const ok = (value) => ({ ok: true, value });
export const fail = (issues) => ({ ok: false, issues });
export const issue = (path, message) => ({ path: [...path], message });
