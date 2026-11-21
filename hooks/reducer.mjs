// Jefe phase logic. Pure: reduce(state, event) -> state. No Claude Code imports.
//
// Rule for everything here: only observed facts are shown. A phase gets a done
// tick only when the run really entered it and then left it forward.
//
// WHEN IS THE BAND IN WHICH STATE (the rule, in full):
//   - INTERVIEW is shown only while an interview is observable: from start until
//     either (a) a question has been asked and not yet confirmed, or (b) only
//     recon agents (Explore, jefe:researcher, Plan) have run. A run that has not
//     asked anything yet still shows INTERVIEW while it does recon.
//   - A build-type agent (anything that is not a recon type) spawned while no Go has
//     been observed and no question is open makes the run NEUTRAL: nothing about its
//     phases can be observed, so the band says only `working`. This covers the SMALL
//     path (no question at all) and an unknown answer shape on the confirm question.
//     A neutral run shows `review` only when a verifier type (isVerifierType) spawns
//     after every build agent finished, and `done` when a non-aborted turn ends with
//     no running agents and the job really over (turn_end end 'pass'). A neutral run never shows phase chips or ticks.
//   - `done` (REPORT) in every kind of run needs end 'pass': the gate's report record of a passing ending
//     finish, with the review answered or the approvals ended. Any other turn end keeps the phase.
//   - Scripted runs (prompt carried ANSWERS:) are neutral from the start.
//   - DIRECT run: Go observed and no agent spawned (a MEDIUM or LARGE job the planner builds itself).
//     Nothing is delegated, so the band says only `working` (never DELEGATE with zero agents), then `done`
//     when a turn ends with nothing running and the job really over, and it dismisses like any other run. The first agent
//     spawned after Go turns it into the ordinary DELEGATE flow.
//   - After `done` / REPORT the mod sends `dismiss` (hooks/jefe.jsx, 8 s later) and the
//     state returns to inactive. A turn that ends with no agent ever spawned, no
//     question asked and no Go also resets the band (nothing was observed).
//
// Events (built by hooks/jefe.jsx from the engine's events):
//   { type: 'start', task }                     /jefe or /jefe:jefe submitted
//   { type: 'reset' }                           session.end (clear, resume, exit)
//   { type: 'dismiss' }                         hide the band after REPORT
//   { type: 'question', questions }             AskUserQuestion opened
//                                               questions: [{ question, options: [label|{label}] }]
//   { type: 'answer', answers }                 AskUserQuestion returned; answers is
//                                               { [question]: label } or null if the shape is unknown
//   { type: 'go_call' }                         a main-loop `jefe-gate go` Bash call started: its permission prompt is the
//                                               confirmation, so the phase shows CONFIRM while it is open
//   { type: 'go_result', ok }                   that call returned; ok only when that call's own output has the `goal: .jefe/goal.md` and `allowed:` lines (or false when it threw)
//                                               (a declined prompt or a failed go leaves the phase at INTERVIEW)
//   { type: 'spawn', id, agentType, model }     agent.spawn answered (main loop only)
//   { type: 'agents', list }                    $.agent.list(): [{ id, status }]
//   { type: 'turn_end', isAborted, parked, end } main-loop turn.complete; parked is the reason ('context' or
//                                               'usage') that `jefe-gate park` recorded for this run, else falsy.
//                                               end: 'pass' | 'unchecked' | 'stopped' | null from the gate's own files (hooks/report-record.mjs jobOutcome).
//                                               Never read from the model's own text.
//   { type: 'planner', model }                  $.session.model(); ignored when empty
//   { type: 'context', reading }                { tokens, window, percent, over } or null (unknown)
//   { type: 'guard' }                           the context guard line was injected this turn

export const PHASES = ['INTERVIEW', 'CONFIRM', 'DELEGATE', 'REVIEW', 'REPORT'];

const RUNNING = new Set(['pending', 'running', 'waiting']);
const FAILED = new Set(['failed', 'killed']);

export function initialState() {
  return {
    active: false,
    task: '',
    // INTERVIEW | CONFIRM | DELEGATE | REVIEW | REPORT | WORKING
    // WORKING is the scripted fast path: the prompt carried ANSWERS:, so no
    // interview or confirm step is observable. See hooks/band.mjs.
    phase: null,
    scripted: false,
    neutral: false, // phases not observable: band shows working / review / done only
    reviewing: false, // neutral run only: a verifier is running after the build wave
    unknownAnswer: false, // the confirm question was answered in a shape we could not read
    done: [], // phases entered and left forward
    interviewAsked: false, // an interview question was actually observed
    question: null, // { text, isConfirm } while an AskUserQuestion is open
    goSeen: false,
    waveClosed: false, // every build agent has finished
    reviewSeen: false,
    spawned: 0,
    planner: '', // the session model, only when known
    context: null, // { tokens, window, percent, over } when known
    guardTurn: false, // the guard fired in the current main turn
    parked: false, // `jefe-gate park` recorded a park for this run
    parkReason: null, // 'context' | 'usage' when parked
    direct: false, // Go observed, nothing delegated yet: shown as `working`
    unchecked: false, // REPORT only: the job ended with a PASS that checked nothing; the line says `done, nothing checked`, no tick
    agents: [], // { id, type, model, status, role: recon|build|review }
  };
}

export function isRunning(a) {
  return RUNNING.has(a.status);
}
export function runningCount(state) {
  return state.agents.filter(isRunning).length;
}
export function failedAgents(state) {
  return state.agents.filter((a) => FAILED.has(a.status));
}
export function failedNote(state) {
  const n = failedAgents(state).length;
  return n === 0 ? '' : `${n} agent${n === 1 ? '' : 's'} failed`;
}

function labelOf(o) {
  return String(o && typeof o === 'object' ? o.label : o == null ? '' : o).trim();
}

// "Go", "Change", "Go (Recommended)", "Change (edit the plan)" -> "go" / "change".
// Anything else ("Go with Postgres") is returned lower-cased and unchanged.
export function baseLabel(label) {
  const t = String(label == null ? '' : label).trim();
  const m = t.match(/^(go|change)(?:\s*\([^()]*\))?$/i);
  return m ? m[1].toLowerCase() : t.toLowerCase();
}

// A confirm question has exactly two options, labelled Go and Change (an optional
// parenthesised suffix such as "(Recommended)" is allowed).
export function isConfirmQuestion(q) {
  const labels = ((q && q.options) || []).map((o) => baseLabel(labelOf(o))).sort();
  return labels.length === 2 && labels[0] === 'change' && labels[1] === 'go';
}

// Agent types that only gather information. Everything else counts as build work.
export function isReconType(type) {
  return /^(explore|plan|jefe:researcher)$/i.test(String(type || '').trim());
}

function markDone(state, ...phases) {
  const done = state.done.slice();
  for (const p of phases) if (!done.includes(p)) done.push(p);
  return done;
}

// Only these agent types can start REVIEW. Unknown or missing types never do.
export function isVerifierType(type) {
  return /^(jefe:runner|jefe:researcher)$/.test(String(type || '')) || /code-review|security-review/i.test(String(type || ''));
}

function allBuildFinished(agents) {
  const build = agents.filter((a) => a.role === 'build');
  return build.length > 0 && build.every((a) => !isRunning(a));
}

// After any status change: close the build wave, and send a failed verifier
// back to DELEGATE.
function settle(state) {
  let s = state;
  if ((s.goSeen || s.neutral) && !s.waveClosed && allBuildFinished(s.agents)) {
    s = { ...s, waveClosed: true };
  }
  if (s.phase === 'REVIEW') {
    const reviewers = s.agents.filter((a) => a.role === 'review');
    if (reviewers.some((a) => FAILED.has(a.status))) {
      s = { ...s, phase: 'DELEGATE', done: s.done.filter((p) => p !== 'DELEGATE') };
    }
  }
  return s;
}

function answerLabel(answers, questionText) {
  if (!answers || typeof answers !== 'object') return null;
  let v = answers[questionText];
  if (v === undefined) {
    // The key may differ slightly (trim); accept a single-answer map.
    const keys = Object.keys(answers);
    if (keys.length === 1) v = answers[keys[0]];
  }
  if (Array.isArray(v)) v = v[0];
  if (v && typeof v === 'object') v = v.label !== undefined ? v.label : v.answer;
  if (typeof v !== 'string') return null;
  return v.trim();
}

// Go observed (an answer `Go`, or a `jefe-gate go` call that succeeded): INTERVIEW and CONFIRM are done.
function goApproved(s) {
  const done = markDone(s, ...(s.interviewAsked ? ['INTERVIEW'] : []), 'CONFIRM');
  // No agent yet: nothing is delegated, so show working until one is spawned.
  if (s.spawned === 0) return { ...s, phase: 'WORKING', direct: true, goSeen: true, question: null, done };
  return { ...s, phase: 'DELEGATE', goSeen: true, question: null, done };
}

export function reduce(state, event) {
  let s = state || initialState();
  switch (event.type) {
    case 'reset':
      return initialState();

    case 'start': {
      const task = String(event.task || '').replace(/\s+/g, ' ').trim();
      const scripted = /\bANSWERS:/.test(String(event.task || ''));
      return {
        ...initialState(),
        active: true,
        task,
        scripted,
        phase: scripted ? 'WORKING' : 'INTERVIEW',
        // The skill treats ANSWERS: as a finished interview and takes Go.
        goSeen: scripted,
        neutral: scripted,
      };
    }

    case 'planner': {
      const m = typeof event.model === 'string' ? event.model.trim() : '';
      return s.active && m ? { ...s, planner: m } : s;
    }

    case 'context':
      return s.active && event.reading ? { ...s, context: event.reading } : s;

    case 'guard':
      return s.active ? { ...s, guardTurn: true } : s;

    case 'dismiss':
      return s.phase === 'REPORT' ? initialState() : s;

    case 'question': {
      if (!s.active) return s;
      const qs = event.questions || [];
      const confirm = qs.find(isConfirmQuestion);
      if (confirm) {
        if (s.goSeen) return s;
        return {
          ...s,
          phase: 'CONFIRM',
          question: { text: String(confirm.question || ''), isConfirm: true },
        };
      }
      if (s.goSeen) return s;
      return {
        ...s,
        interviewAsked: true,
        question: { text: '', isConfirm: false },
      };
    }

    case 'answer': {
      if (!s.active || !s.question) return s;
      const q = s.question;
      if (!q.isConfirm) return { ...s, question: null };
      const label = answerLabel(event.answers, q.text);
      if (label === null) {
        // Unknown shape: we cannot tell Go from Change. Stay in CONFIRM only until
        // the next observed event: a build agent spawn makes the run neutral.
        return { ...s, question: null, unknownAnswer: true };
      }
      if (baseLabel(label) === 'go') return goApproved(s);
      // Change, or anything else (free text): back to the interview.
      return { ...s, phase: 'INTERVIEW', question: null };
    }

    // The single confirmation is Claude Code's permission prompt for the `go` command: CONFIRM while it is
    // open, Go observed only when the call succeeded. A declined or failed call goes back to the interview.
    case 'go_call': {
      if (!s.active || s.goSeen || s.neutral || s.scripted) return s;
      return { ...s, phase: 'CONFIRM', question: { text: '', isConfirm: true, viaGate: true } };
    }

    case 'go_result': {
      if (!s.active || s.goSeen || s.neutral || s.scripted) return s;
      if (event.ok) return goApproved(s);
      return s.question && s.question.viaGate ? { ...s, phase: 'INTERVIEW', question: null } : s;
    }

    case 'spawn': {
      if (!s.active || s.agents.some((a) => a.id === event.id)) return s;
      let role = 'recon';
      let phase = s.phase;
      let done = s.done;
      let waveClosed = s.waveClosed;
      let reviewSeen = s.reviewSeen;
      let neutral = s.neutral;
      let reviewing = s.reviewing;
      const hasBuild = s.agents.some((a) => a.role === 'build');
      if (s.scripted) {
        role = 'build'; // phase stays WORKING: nothing about phases is observable
      } else if (s.neutral) {
        if (s.waveClosed && hasBuild && isVerifierType(event.agentType)) {
          role = 'review';
          reviewing = true;
          reviewSeen = true;
        } else {
          role = 'build';
          waveClosed = false;
          reviewing = false;
        }
      } else if (s.goSeen) {
        if (s.direct) {
          // the first agent after a direct start: now it is delegation
          role = 'build';
          phase = 'DELEGATE';
          waveClosed = false;
        } else if (s.phase === 'REVIEW' || s.phase === 'REPORT') {
          role = 'review';
        } else if (s.waveClosed && hasBuild && isVerifierType(event.agentType)) {
          // Spawned after every build agent finished, and of a verifier type: REVIEW.
          role = 'review';
          phase = 'REVIEW';
          reviewSeen = true;
          done = markDone(s, 'DELEGATE');
        } else {
          // A builder (or an unknown type: a missed REVIEW beats a false one) is more build work.
          role = 'build';
          waveClosed = false;
        }
      } else if (!isReconType(event.agentType) && !s.question) {
        // No Go observed, no question open, and build work starts: the interview and
        // confirm steps cannot be observed for this run. Neutral `working`.
        role = 'build';
        neutral = true;
        phase = 'WORKING';
        done = [];
        waveClosed = false;
      }
      const agent = {
        id: event.id,
        type: String(event.agentType || ''),
        model: event.model || '',
        status: 'running',
        role,
      };
      return {
        ...s,
        phase,
        done,
        waveClosed,
        reviewSeen,
        neutral,
        reviewing,
        direct: false,
        unknownAnswer: neutral ? false : s.unknownAnswer,
        spawned: s.spawned + 1,
        agents: [...s.agents, agent],
      };
    }

    case 'agents': {
      if (!s.active) return s;
      const byId = new Map((event.list || []).map((a) => [a.id, a.status]));
      const agents = s.agents.map((a) => (byId.has(a.id) ? { ...a, status: byId.get(a.id) } : a));
      return settle({ ...s, agents });
    }

    case 'turn_end': {
      if (!s.active) return s;
      if (event.isAborted) return initialState();
      // A parked run stops: no REPORT, no done tick, whatever finishes afterwards.
      if (s.parked || event.parked) {
        const reason = s.parkReason || (event.parked === 'context' || event.parked === 'usage' ? event.parked : null);
        return { ...s, parked: true, parkReason: reason, guardTurn: false };
      }
      // The job's approvals were ended during this run without a passing report: it stopped (given up after a FAIL). Nothing is ticked, the line goes.
      if (event.end === 'stopped') return initialState();
      s = { ...s, guardTurn: false };
      if (runningCount(s) > 0) return s; // paused for agents: keep the phase
      // `done` only when the job really ended with a pass (event.end === 'pass', hooks/report-record.mjs jobOutcome). Any other turn end (a FAIL,
      // a question to the user, a builder that finished with no review yet) keeps the phase, and the run stays active.
      // end 'unchecked': it ended with a PASS that checked nothing (no tests, no checks): REPORT too, flagged so the line shows no tick.
      if (event.end === 'pass' || event.end === 'unchecked') {
        const unchecked = event.end === 'unchecked';
        if (s.neutral) return { ...s, phase: 'REPORT', done: [], reviewing: false, unchecked };
        if (s.direct && s.goSeen && s.spawned === 0) return { ...s, phase: 'REPORT', unchecked }; // direct stays true: the band says done, not a chip row
        const done = s.goSeen && s.spawned > 0 && (s.phase === 'DELEGATE' || s.phase === 'REVIEW') ? markDone(s, 'DELEGATE', ...(s.reviewSeen && s.phase === 'REVIEW' ? ['REVIEW'] : [])) : s.done;
        return { ...s, phase: 'REPORT', done, unchecked };
      }
      if (!s.goSeen && !s.question) {
        // Nothing observable happened (no question, no build agent) or an unknown
        // confirm answer was followed by a turn end: do not leave the band up.
        if (s.unknownAnswer) return initialState();
        if (!s.interviewAsked && s.spawned === 0) return initialState();
      }
      return s;
    }

    default:
      return s;
  }
}
