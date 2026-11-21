// The few provider rules the permit hook and the provider code must agree on (no imports: the hook loads this too).
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
// The longest question (the text after `--`) a job's approval covers: the hook approves `ask` only up to this, and `ask` enforces it while a job with the providers kind is live.
export const QUESTION_MAX = { untrusted: 2000, trusted: 20000 };
export const questionMax = (trusted) => (trusted === true ? QUESTION_MAX.trusted : QUESTION_MAX.untrusted);
// The model-id rule and the control / line-separator rule for file arguments: one definition for the hook, `ask` and `provider add`.
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}$/;
export const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
