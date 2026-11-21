// Jefe mod: glue only. Engine events -> reduce() -> band.mjs -> Text elements.
// Display only: registers no tool, adds no prompt text, blocks nothing. Every
// hook runs the engine's own behaviour (next) unchanged, and any error in here
// means "no visual".
//
// All phase logic is in ./reducer.mjs and all drawing decisions in ./band.mjs,
// both pure and covered by tests/. The Claude Code docs say a file of the
// plugin is imported with an ordinary import declaration.
//
// NO_COLOR draws with weight and dim only, and static. JEFE_STILL (any value) makes the line static.
// (NO_COLOR is the documented no-colour convention; JEFE_STILL is Jefe's own switch. No other name is read.)
//
// The only thing drawn: ONE quiet line above the prompt while a /jefe job is active (./line.mjs): the word
// `jefe` with a slow colour sweep, the phase in one word and the running helpers. Nothing else: no footer chip,
// no context, usage, cost or level. The mod never sends a prompt, wake-up or keep-alive to the model.
//
// Usage level: the /jefe-level command (no argument cycles normal > thorough; an argument sets it) writes
// the same config.json that `jefe-gate level set` writes. A mod cannot register a key chord, so there is none.
//
// Files are keyed by the PROJECT ROOT (runfile.mjs projectRoot, the function bin/jefe-gate calls too), so a
// subfolder, a parent and a symlinked path share one run file. Parking is read from the gate file that
// `jefe-gate park` writes, never from the model's own text. The pure decisions live in ./modlogic.mjs.

import { reduce, initialState } from './reducer.mjs';
import { contextReading, guardLine, plannerLine } from './guard.mjs';
import { jobOutcome } from './report-record.mjs';
import { pickJefeHome, realishWith } from './jefe-home.mjs';
import { runFilePath, levelFilePath, gateFilePath, reportFilePath, allowFilePath, projectRoot, rootCache, fiveHourOf, rateLimitsOf, serialise, dueToWrite, writeRunFile, spawnsFilePath, spawnLine, appendSpawn } from './runfile.mjs';
import { clearedPhaseBody, extractAnswers, goSucceeded, isGoCall, isJefeSkill, jefePrompt, parkedFrom, phaseBody, shapeOf, shouldBegin } from './modlogic.mjs';
import { FRAME_MS, LOOP_FRAMES, colorMode, isAnimating, jefeLine, phaseWord } from './line.mjs';
import { configPath, downshift, modelWord, spawnRole, isTrustedProject, nextLevel, parseConfig, parseLevel, parseLevelCommand, patchConfig, resolveLevel, usageState } from './levels.mjs';

const POLL_MS = 500;
const REPORT_HOLD_MS = 8000;

let state = initialState();
let frame = 0; // animation frame of the `jefe` sweep
let settleFrame = null; // frames since the job turned `done` (the one last sweep), null otherwise
let drawEnv = null; // { colorterm, termProgram, ascii }, read once for the drawing
let isPlain = false;
let isStill = false;
let generation = 0;
let pollTimer = null;
let animTimer = null;
let reportTimer = null;
let loggedShape = false;
let loggedRates = false;
let levelInfo = null; // what the indicator draws: { level, source, from, usedPercent, state }
let levelResolved = { level: 'normal', source: 'default' }; // before any plan-usage downshift
let plainNow = false;
let lastUsage = null;
let lastRunWrite = null;
let startLines = [];
let beginning = null; // the begin() in flight, so the two events that reach it share one
let lastBeginAt = null;
let runStartMs = 0; // when this run began: a park older than this belongs to an earlier run

function stopTimers() {
  for (const t of [pollTimer, animTimer, reportTimer]) {
    try {
      if (t) t.cancel();
    } catch (err) {
      // already gone
    }
  }
  pollTimer = animTimer = reportTimer = null;
}

function dispatch($, event) {
  const next = reduce(state, event);
  if (next !== state) {
    state = next;
    syncAnimation($);
    $.ui.invalidate('ui.render');
  }
}

// The sweep timer runs only while the line is moving (a job is active and working); it is stopped otherwise,
// so an idle session or a finished/parked job costs nothing.
function syncAnimation($) {
  // the one settling sweep of `done` counts from the moment the job turned done
  if (phaseWord(state) !== 'done') settleFrame = null;
  else if (settleFrame === null && !isPlain && !isStill) settleFrame = 0;
  const moving = isAnimating(state, { plain: isPlain, still: isStill, settleFrame });
  if (!moving) {
    try {
      if (animTimer) animTimer.cancel();
    } catch (err) {
      // already gone
    }
    animTimer = null;
    return;
  }
  if (animTimer) return;
  const mine = generation;
  animTimer = $.clock.every(FRAME_MS, () => {
    if (mine !== generation || !isAnimating(state, { plain: isPlain, still: isStill, settleFrame })) {
      syncAnimation($);
      return;
    }
    frame = (frame + 1) % LOOP_FRAMES;
    if (settleFrame !== null) settleFrame += 1;
    $.ui.invalidate('ui.render');
  });
}

async function refreshAgents($) {
  if (!state.active || state.agents.length === 0) return;
  try {
    const list = await $.agent.list();
    if (Array.isArray(list)) {
      dispatch($, { type: 'agents', list: list.map((a) => ({ id: a.id, status: a.status })) });
    }
  } catch (err) {
    // keep the last observed statuses
  }
}

// Reads $.session.usage() and the two env limits. Returns { reading, over } or null.
async function readContext($) {
  try {
    const usage = await $.session.usage();
    lastUsage = usage;
    if (!loggedRates) {
      loggedRates = true;
      $.ui.log('jefe: rateLimits shape ' + JSON.stringify(shapeOf(usage && usage.rateLimits, 0, true)), { to: 'debug' });
    }
    const env = {
      JEFE_CONTEXT_LIMIT: await $.env.get('JEFE_CONTEXT_LIMIT'),
      JEFE_CONTEXT_PERCENT: await $.env.get('JEFE_CONTEXT_PERCENT'),
    };
    const reading = contextReading(usage, env);
    if (reading) dispatch($, { type: 'context', reading });
    return reading;
  } catch (err) {
    return null; // unknown, never a false alarm
  }
}

// ---- usage level ----------------------------------------------------------------------

async function readText($, file) {
  try {
    const t = await $.fs.read(file);
    return typeof t === 'string' ? t : null;
  } catch (err) {
    return null;
  }
}

// $.env.get takes literal names (so the variables a mod reads can be listed).
async function envValue(get) {
  try {
    const v = await get();
    return v === undefined || v === null ? undefined : v;
  } catch (err) {
    return undefined; // unreadable: left out
  }
}

// The project root for the session's folder: the same rule bin/jefe-gate uses (runfile.mjs projectRoot). Cached per folder for a few seconds, so a write
// is not a new walk up the folders. This root keys the run, level, gate and spawns files the gate reads. What the engine cannot do (see docs/SCRIPTS.md):
// no lstat and no folder modes, and the home folder is $HOME.
const cachedRoot = rootCache();
async function rootOf($, cwd) {
  return cachedRoot(cwd, async () => {
    const io = {
      exists: async (p) => {
        try {
          return Boolean(await $.fs.exists(p));
        } catch (err) {
          return false;
        }
      },
      // called inside try/catch (never feature-detected); a host without realpath throws and the path is kept as is
      realpath: async (p) => {
        try {
          const r = await $.fs.realpath(p);
          return typeof r === 'string' && r ? r : p;
        } catch (err) {
          return p;
        }
      },
    };
    // Mods have no account database: the home folder is the HOME of the process the mod runs in (not a repository's setting).
    io.home = await envValue(() => $.env.get('HOME'));
    return projectRoot(cwd, io);
  });
}

// The Jefe home for a project root, decided by THE rule the gate and the hooks use (jefe-home.mjs pickJefeHome, which registryInfo applies too):
// JEFE_HOME only when it is absolute, resolves and is not inside the project, else $HOME/.claude/jefe. -> the env object the path helpers
// (runfile.mjs, levels.mjs) take, { JEFE_HOME: <that folder> }, or null when nothing usable resolves (then nothing is read or written).
// The mod cannot tell the platform, so the inside test ignores case everywhere: a doubtful JEFE_HOME falls back to the default, never the reverse.
const cachedHome = rootCache();
async function homeEnv($, root) {
  return cachedHome(root, async () => {
    const given = await envValue(() => $.env.get('JEFE_HOME'));
    const HOME = await envValue(() => $.env.get('HOME'));
    // The gate also compares device and inode (registryInfo); the engine's $.fs.stat is known here only to report isLink, so the mod keeps to
    // the text rules, which cover the macOS alias paths too (jefe-home.mjs). exists: a path that exists but does not resolve gives no real path.
    const io = {
      realpath: async (p) => $.fs.realpath(p),
      isLink: async (p) => {
        const st = await $.fs.stat(p);
        return Boolean(st && st.isLink);
      },
      exists: async (p) => Boolean(await $.fs.exists(p)),
    };
    const g = typeof given === 'string' && given ? given : undefined;
    const fallback = typeof HOME === 'string' && HOME.startsWith('/') ? HOME.replace(/\/+$/, '') + '/.claude/jefe' : null;
    const picked = pickJefeHome({
      given: g,
      absolute: Boolean(g && g.startsWith('/')),
      real: g ? await realishWith(g, io) : null,
      rootReal: typeof root === 'string' && root ? root : null,
      fallback,
      fallbackReal: fallback ? await realishWith(fallback, io) : null,
      ci: true,
      fallbackMustBeOutside: true, // the mod's fallback comes from $HOME, which a repository's settings can point inside the project: then no home
    });
    return picked.home === null ? null : { JEFE_HOME: picked.home };
  });
}

// The session id as the scripts see it (the same environment variables), or null: a run file naming another
// session is ignored by jefe-gate, so only an id both sides can read is ever written.
async function sessionId($) {
  const reads = [
    () => $.env.get('JEFE_SESSION_ID'),
    () => $.env.get('CLAUDE_SESSION_ID'),
    () => $.env.get('CLAUDE_CODE_SESSION_ID'),
  ];
  for (const read of reads) {
    const v = await envValue(read);
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

// JEFE_HOME here is the checked Jefe home (homeEnv), absent when none is usable: then no config file is read or written.
async function levelEnv($) {
  const home = await homeEnv($, await rootOf($, await $.session.cwd()));
  const env = {
    JEFE_HOME: home ? home.JEFE_HOME : undefined,
    JEFE_LEVEL: await envValue(() => $.env.get('JEFE_LEVEL')),
    JEFE_USAGE_DOWNSHIFT: await envValue(() => $.env.get('JEFE_USAGE_DOWNSHIFT')),
    JEFE_USAGE_PARK: await envValue(() => $.env.get('JEFE_USAGE_PARK')),
    JEFE_USAGE_GUARD: await envValue(() => $.env.get('JEFE_USAGE_GUARD')),
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
}

// true when any of the paths is itself a symbolic link (a planted link must not redirect a write).
async function anyLink($, paths) {
  for (const p of paths) {
    try {
      const st = await $.fs.stat(p);
      if (st && st.isLink) return p;
    } catch (err) {
      // missing: nothing to follow
    }
  }
  return null;
}

// <root>/.jefe/config.json of the project root (the one rule), when that folder holds a .jefe, or null.
async function projectConfigFile($, cwd) {
  try {
    const root = await rootOf($, cwd);
    if (await $.fs.exists(root + '/.jefe')) return root + '/.jefe/config.json';
  } catch (err) {
    // no project config
  }
  return null;
}

// Reads the level in effect from what the mod can see: the level file `jefe-gate start` wrote
// (when fresh, under 6 h), else env and the config files. Display only: the default with no
// level file reads nothing, so nothing is drawn.
async function refreshLevel($) {
  const before = JSON.stringify([levelInfo, plainNow]);
  try {
    plainNow = (await $.env.get('NO_COLOR')) !== undefined;
    const env = await levelEnv($);
    const cwd = await $.session.cwd();
    const user = env.JEFE_HOME ? parseConfig(await readText($, configPath(env))) : { ok: false };
    const pf = await projectConfigFile($, cwd);
    const project = pf ? parseConfig(await readText($, pf)) : { ok: false };
    // a committed project config only counts when this user trusted it (jefe-gate level set --project)
    const projectDir = pf ? pf.slice(0, -'/.jefe/config.json'.length) : null;
    let r = resolveLevel({
      env,
      project: project.ok ? project.config : null,
      user: user.ok ? user.config : null,
      projectTrusted: user.ok && isTrustedProject(user.config, projectDir),
    });
    let readable = r.source !== 'default';
    try {
      const lf = env.JEFE_HOME ? JSON.parse((await readText($, levelFilePath(await rootOf($, cwd), env))) || 'null') : null;
      const at = Date.parse(lf && lf.at);
      if (lf && Number.isFinite(at) && (await $.clock.now()) - at < 6 * 3600 * 1000) {
        readable = true;
        if (lf.source === 'run' && parseLevel(lf.base || lf.level)) r = { level: parseLevel(lf.base || lf.level), source: 'run' };
      }
    } catch (err) {
      // no level file
    }
    levelResolved = r;
    try {
      lastUsage = await $.session.usage(); // a plain call costs nothing; the footer reflects plan usage while idle too
    } catch (err) {
      // keep the last reading
    }
    const rate = rateLimitsOf(lastUsage);
    const st = usageState(rate, env);
    const shifted = st === 'downshift' ? downshift(r.level) : r.level;
    levelInfo = readable
      ? { level: shifted, source: r.source, base: r.level, from: shifted !== r.level ? r.level : null, usedPercent: rate ? rate.usedPercent : null, state: st }
      : null;
  } catch (err) {
    // keep the last known
  }
  if (state.active && JSON.stringify([levelInfo, plainNow]) !== before) $.ui.invalidate('ui.render');
}

// /jefe-level [normal|thorough|show]: no argument cycles normal > thorough > normal. Writes the same
// config.json as `jefe-gate level set` (merging its other keys), then redraws at once.
async function changeLevel($, args) {
  await refreshLevel($);
  const cmd = parseLevelCommand(args);
  if (cmd.action === 'error') return 'level: ' + cmd.message;
  if (cmd.action === 'show') return `level: ${levelResolved.level} (source: ${levelResolved.source})`;
  const level = cmd.action === 'set' ? cmd.level : nextLevel(levelResolved.level);
  const env = await levelEnv($);
  if (!env.JEFE_HOME) return 'level: no usable Jefe folder (JEFE_HOME and ~/.claude/jefe cannot be used)';
  const file = configPath(env);
  let text = null;
  try {
    if (await $.fs.exists(file)) text = await $.fs.read(file);
  } catch (err) {
    return `level: cannot read ${file}`;
  }
  const merged = patchConfig(text, { level });
  if (!merged.ok) {
    const copy = `${file}.corrupt-${new Date(await $.clock.now()).toISOString().replace(/[:.]/g, '-')}`;
    try {
      await $.fs.write(copy, String(text));
    } catch (err) {
      // the message below still stops the change
    }
    return `level: ${file} is not valid JSON (${merged.error}). A copy was saved to ${copy}. Fix or remove ${file}, then run again. Nothing was overwritten.`;
  }
  const linked = await anyLink($, [file]);
  if (linked) return `level: refusing to write: ${linked} is a symlink`;
  try {
    await $.fs.write(file, merged.text);
  } catch (err) {
    return `level: cannot write ${file}`;
  }
  // an explicit change replaces a per-run override recorded by `jefe-gate start --level`
  try {
    const cwd = await $.session.cwd();
    const lfile = levelFilePath(await rootOf($, cwd), env);
    const lf = JSON.parse((await readText($, lfile)) || 'null');
    if (lf && lf.source === 'run' && !(await anyLink($, [lfile, lfile.slice(0, lfile.lastIndexOf('/'))]))) {
      await $.fs.write(lfile, JSON.stringify({ level, source: 'user', base: level, at: new Date(await $.clock.now()).toISOString() }) + '\n');
    }
  } catch (err) {
    // the indicator still shows the new value
  }
  await refreshLevel($);
  const lines = [`level: ${level} (source: user) saved`];
  if (levelResolved.level !== level) lines.push(`note: ${levelResolved.level} is in effect (source: ${levelResolved.source}), which takes precedence over the user setting`);
  if (state.active) lines.push('applies from the next phase boundary (jefe-gate start or context shows it)');
  return lines.join('\n');
}

// Run file for bin/jefe-gate: live context and cost, overwritten atomically,
// at most once every 2 s unless force. Reads usage itself so it is never stale.
async function writeRun($, force = false) {
  try {
    const now = await $.clock.now();
    if (!force && !dueToWrite(lastRunWrite, now)) return;
    lastRunWrite = now;
    const reading = await readContext($);
    await refreshLevel($);
    const cwd = await $.session.cwd();
    let model = null;
    try {
      model = await $.session.model();
    } catch (err) {
      // unknown
    }
    const root = await rootOf($, cwd);
    const env = await homeEnv($, root);
    if (!env) return; // no usable Jefe home: nothing is written
    const file = runFilePath(root, env);
    const session = await sessionId($);
    const text = serialise({ now, reading, usage: lastUsage, model, session, phase: state.active ? (state.parked ? 'PARKED' : state.phase) : null });
    if (await anyLink($, [file, file.slice(0, file.lastIndexOf('/'))])) return; // never write through a symlink
    await writeRunFile(file, text, (f, t) => $.fs.write(f, t)); // $.fs.write replaces in place, not atomic
  } catch (err) {
    // no file, no harm
  }
}

// Overwrites <cwd>/.jefe/phase.json (read by stamp.mjs, which ignores it once it is old) when a project .jefe/
// exists. why 'dismiss' writes the empty phase: the band is gone, so nothing may be restamped as current.
async function writeState($, why) {
  try {
    const cwd = await $.session.cwd();
    const dir = cwd + '/.jefe';
    if (!(await $.fs.exists(dir))) return;
    if (await anyLink($, [dir, dir + '/phase.json', dir + '/state.json'])) return; // never write through a symlink
    const body = why === 'dismiss' ? clearedPhaseBody(await $.clock.now()) : phaseBody({ now: await $.clock.now(), why, state });
    await $.fs.write(dir + '/phase.json', JSON.stringify(body, null, 2) + '\n');
    if (why === 'turn') await $.fs.write(dir + '/state.json', JSON.stringify({ ...body, files: null }, null, 2) + '\n');
  } catch (err) {
    // no file, no harm
  }
}

// The park `jefe-gate park` recorded for this run ('context' | 'usage'), or null.
async function readParked($) {
  try {
    const cwd = await $.session.cwd();
    const root = await rootOf($, cwd);
    const env = await homeEnv($, root);
    if (!env) return null;
    const file = gateFilePath(root, env);
    const gate = JSON.parse((await readText($, file)) || 'null');
    return parkedFrom(gate, runStartMs, await $.clock.now());
  } catch (err) {
    return null;
  }
}

// Has the job really ended? From the gate's own files only (never the model's text): the report record of a passing ending finish and the
// job's approval record, the same files and rule the Stop hook uses (report-record.mjs jobOutcome). -> 'pass' | 'stopped' | null
async function readOutcome($) {
  try {
    const cwd = await $.session.cwd();
    const root = await rootOf($, cwd);
    const env = await homeEnv($, root);
    if (!env) return null;
    const parse = async (file) => {
      try {
        const j = JSON.parse((await readText($, file)) || 'null');
        return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
      } catch (err) {
        return null;
      }
    };
    const rec = await parse(reportFilePath(root, env));
    const allow = await parse(allowFilePath(root, env));
    return jobOutcome({ rec, allow, session: await sessionId($), runStart: runStartMs, now: await $.clock.now() });
  } catch (err) {
    return null; // cannot tell: the job goes on, never a false done
  }
}

// The session's model is the planner. It is never switched or requested.

// begin is reached from prompt.submit and from skill.prompt for one /jefe: shouldBegin() and the shared promise
// make it single.
function begin($, e, rawTask, source) {
  if (beginning) return beginning;
  beginning = (async () => {
    const now = await $.clock.now();
    if (!shouldBegin({ source, active: state.active, beginning: false, lastBeginAt, now })) return;
    lastBeginAt = now;
    runStartMs = now;
    await beginOnce($, e, rawTask);
  })().finally(() => {
    beginning = null;
  });
  return beginning;
}

async function beginOnce($, e, rawTask) {
  const task = String(rawTask || '').trim();
  generation += 1;
  stopTimers();
  const mine = generation;
  isPlain = (await $.env.get('NO_COLOR')) !== undefined;
  isStill = (await $.env.get('JEFE_STILL')) !== undefined;
  state = reduce(state, { type: 'start', task });
  let actual = '';
  try {
    actual = await $.session.model(); // what is really in use, not what was asked
  } catch (err) {
    // unknown
  }
  dispatch($, { type: 'planner', model: actual });
  const lines = [];
  const planner = plannerLine(actual);
  if (planner) lines.push(planner);
  const reading = await readContext($);
  if (reading && reading.over) lines.push(guardLine(reading)); // delivered through skill.prompt, the proven path
  frame = 0;
  syncAnimation($);
  $.ui.invalidate('ui.render');
  startLines = lines;
  pollTimer = $.clock.every(POLL_MS, async () => {
    if (mine !== generation) return;
    if (!state.active) {
      stopTimers();
      return;
    }
    await refreshAgents($);
    await writeRun($);
  });
  await writeRun($, true);
}

// Error handler for the hooks that gate a prompt, a tool call or an agent spawn. A mod error must never
// block any of them: pass the event on (when the hook had already called next, this returns its result).
const failOpen = async ($, e, next) => next(e);

export function register(on) {
  // Registered last in the hook, and wrapped: a taken name throws, and a throw would skip the rest.
  on('session.start', async ($, e, next) => {
    try {
      await refreshLevel($);
    } catch (err) {
      // no indicator
    }
    try {
      await $.command.register({
        name: 'jefe-level',
        description: 'Set how thorough Jefe is: normal or thorough (no argument cycles)',
        argumentHint: '[normal|thorough]',
        immediate: true,
      });
    } catch (err) {
      $.ui.log('jefe: /jefe-level not registered: ' + String(err && err.message ? err.message : err).slice(0, 200), { to: 'debug' });
    }
    return next(e);
  });

  on('command.run', { command: 'jefe-level' }, async ($, e) => {
    let text;
    try {
      text = await changeLevel($, e.args);
    } catch (err) {
      text = 'level: could not change the level';
    }
    return { text, isTextDisplayOnly: true }; // for the person alone; Claude does not read it
  });

  on('prompt.submit', async ($, e, next) => {
    try {
      const { isJefe, task } = jefePrompt(e);
      if (isJefe) await begin($, e, task, 'prompt'); // the start lines go to Claude through skill.prompt
    } catch (err) {
      state = initialState();
    }
    return next(e);
  }).catch(failOpen);

  // The skill can also start without the slash command going through prompt.submit.
  on('skill.prompt', async ($, e, next) => {
    let lines = [];
    try {
      if (isJefeSkill(e.skill)) {
        if (beginning) await beginning;
        else if (!state.active) await begin($, e, '', 'skill');
        lines = startLines;
        startLines = []; // delivered once
      }
    } catch (err) {
      state = initialState();
    }
    if (lines.length) $.ui.log('jefe: start lines added to skill text: ' + lines.length, { to: 'debug' });
    // A skill.prompt hook may return changed text; Claude reads the final text.
    return next(lines.length ? { ...e, text: String(e.text || '') + '\n\n' + lines.join('\n') } : e);
  });

  on('tool.call', async ($, e, next) => {
    const isQuestion = e.tool === 'AskUserQuestion' && !e.agentId && state.active;
    const goCommand = e.command || (e.input && e.input.command) || (e.args && e.args.command);
    const isGo = e.tool === 'Bash' && !e.agentId && state.active && isGoCall(goCommand);
    try {
      if (isQuestion) dispatch($, { type: 'question', questions: e.questions || [] });
      else if (isGo) dispatch($, { type: 'go_call' });
    } catch (err) {
      // no visual
    }
    let result;
    try {
      result = await next(e);
    } catch (err) {
      // a declined permission prompt can surface as a throw: the go did not happen, so the band leaves CONFIRM; the error goes on
      if (isGo) {
        try {
          dispatch($, { type: 'go_result', ok: false });
        } catch (e2) {
          // no visual
        }
      }
      throw err;
    }
    try {
      if (isQuestion) {
        if (!loggedShape) {
          loggedShape = true;
          $.ui.log('jefe: AskUserQuestion result shape ' + JSON.stringify(shapeOf(result)), { to: 'debug' });
        }
        dispatch($, { type: 'answer', answers: extractAnswers(result) });
      } else if (isGo) {
        const ok = goSucceeded(result, goCommand);
        dispatch($, { type: 'go_result', ok });
      } else if (e.tool === 'Agent' && !e.agentId) {
        await refreshAgents($);
      }
    } catch (err) {
      // no visual
    }
    return result;
  }).catch(failOpen);

  on('agent.spawn', async ($, e, next) => {
    const isMain = state.active && !e.parentAgentId;
    if (isMain) await refreshAgents($); // close the previous wave before this one starts
    const result = await next(e);
    try {
      if (isMain && result && result.agentId) {
        const text = typeof e.description === 'string' && e.description ? e.description : typeof e.prompt === 'string' ? e.prompt : '';
        dispatch($, { type: 'spawn', id: result.agentId, agentType: e.subagentType, model: result.model || e.model });
        // the role comes from the spawn itself (levels.mjs spawnRole), never from the band's phase; no known role or model: nothing is recorded
        const role = spawnRole(e.subagentType, text);
        const model = modelWord(result.model || e.model);
        // the gate's models: line reads what each spawn reported: each spawn appends one line to its own file (never read, changed and written back), so parallel spawns all count
        const line = role && model ? spawnLine(await sessionId($), role, model) : null;
        if (line) {
          const root = await rootOf($, await $.session.cwd());
          const env = await homeEnv($, root);
          const file = env ? spawnsFilePath(root, env) : null;
          if (file && !(await anyLink($, [file, file.slice(0, file.lastIndexOf('/'))]))) await appendSpawn(file, line, (argv, init) => $.process.run(argv, init));
        }
        await writeRun($, true);
      }
    } catch (err) {
      // no visual
    }
    return result;
  }).catch(failOpen);

  on('turn.step', async function* ($, e, next) {
    try {
      if (state.active) await writeRun($);
    } catch (err) {
      // no file
    }
    return yield* next(e);
  });

  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    try {
      if (!e.agentId) await refreshLevel($);
    } catch (err) {
      // no indicator
    }
    try {
      if (!state.active) return result;
      await refreshAgents($);
      if (e.agentId) {
        await writeRun($); // a subagent finished a turn
        return result; // statuses only
      }
      await readContext($);
      dispatch($, { type: 'turn_end', isAborted: !!e.isAborted, parked: await readParked($), end: e.isAborted ? null : await readOutcome($) });
      await writeState($, 'turn');
      await writeRun($, true);
      if (!state.active) {
        stopTimers();
      } else if (state.phase === 'REPORT') {
        const mine = generation;
        if (reportTimer) reportTimer.cancel();
        reportTimer = $.clock.after(REPORT_HOLD_MS, () => {
          if (mine === generation) {
            dispatch($, { type: 'dismiss' });
            stopTimers();
            if (!state.active) writeState($, 'dismiss'); // nothing is in progress any more
          }
        });
      }
    } catch (err) {
      // no visual
    }
    return result;
  });

  // session.start does not fire after /clear, so reset here (clear, resume, exit).
  on('session.end', async ($, e, next) => {
    generation += 1;
    stopTimers();
    state = initialState();
    return next(e);
  });

  // The one line. Hidden (next) when no job is active, so it costs nothing and shows nothing.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    try {
      if (!state.active || e.props.hasSurvey || e.props.isCollapsed) return next(e);
      // the line is drawn on the terminal and in the desktop app; any other surface draws nothing
      if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e);
      const { Box, Text } = $.ui.resolve(e);
      const park = state.parked ? parkInfo() : null;
      if (!drawEnv) {
        drawEnv = {
          colorterm: await $.env.get('COLORTERM'),
          termProgram: await $.env.get('TERM_PROGRAM'),
          term: await $.env.get('TERM'),
          ascii: (await $.env.get('JEFE_ASCII')) !== undefined,
        };
        drawEnv.ascii = drawEnv.ascii || drawEnv.term === 'dumb' || drawEnv.term === 'linux';
      }
      const mode = colorMode({ surface: e.surface, plain: isPlain, colorterm: drawEnv.colorterm, termProgram: drawEnv.termProgram });
      const line = jefeLine(state, { plain: isPlain, mode, still: isStill, frame, settleFrame: settleFrame === null ? undefined : settleFrame, ascii: drawEnv.ascii, columns: (e.props.bodyColumns || 80) - 2, park });
      if (!line.length) return next(e);
      return (
        <Box paddingX={1}>
          {line.map((s, j) => (
            <Text key={'s' + j} color={s.color} bold={s.bold} dimColor={s.dim} wrap="truncate">
              {s.t}
            </Text>
          ))}
        </Box>
      );
    } catch (err) {
      return next(e);
    }
  });
}

// What the parked line names: the one number that is the reason.
function parkInfo() {
  if (state.parkReason === 'usage') {
    // the number shown is the five-hour window specifically, not whichever window is highest
    const five = fiveHourOf(lastUsage);
    return { reason: 'usage', percent: five ? five.usedPercent : null, resetsAt: five ? five.resetsAt : null };
  }
  if (state.parkReason === 'context') return { reason: 'context', percent: state.context ? state.context.percent : null };
  return { reason: null };
}
