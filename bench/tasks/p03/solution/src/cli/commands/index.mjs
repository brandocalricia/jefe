import { auditCommand } from './audit.mjs';
import { commentCommand } from './comment.mjs';
import { memberCommand } from './member.mjs';
import { projectCommand } from './project.mjs';
import { reportCommand } from './report.mjs';
import { taskCommand } from './task.mjs';
import { workspaceCommand } from './workspace.mjs';

const inWorkspace = () => true;

// run(ctx) does the work; needsWorkspace(args) says whether --workspace must be given.
export const COMMANDS = {
  workspace: { run: workspaceCommand, needsWorkspace: ([sub]) => sub === 'rename' },
  member: { run: memberCommand, needsWorkspace: inWorkspace },
  project: { run: projectCommand, needsWorkspace: inWorkspace },
  task: { run: taskCommand, needsWorkspace: inWorkspace },
  comment: { run: commentCommand, needsWorkspace: inWorkspace },
  report: { run: reportCommand, needsWorkspace: inWorkspace },
  audit: { run: auditCommand, needsWorkspace: inWorkspace },
};
