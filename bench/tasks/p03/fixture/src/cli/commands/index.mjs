import { auditCommand } from './audit.mjs';
import { commentCommand } from './comment.mjs';
import { projectCommand } from './project.mjs';
import { reportCommand } from './report.mjs';
import { taskCommand } from './task.mjs';

export const COMMANDS = {
  project: projectCommand,
  task: taskCommand,
  comment: commentCommand,
  report: reportCommand,
  audit: auditCommand,
};
