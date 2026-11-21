import { notFound } from '../domain/errors.mjs';
import { isOverdue, PRIORITIES, STATUSES } from '../domain/task.mjs';
import { authorize } from './support.mjs';

export function createReportService({ db, clock }) {
  return {
    // Counts for all tasks of the workspace, or only the tasks of one project. "Today" is the date
    // part of the clock.
    summary(actor, workspaceId, { projectId } = {}) {
      authorize(db, actor, workspaceId, 'report.read');
      if (projectId !== undefined) {
        const project = db.projects.get(projectId);
        if (!project || project.workspaceId !== workspaceId) throw notFound('project');
      }
      const all = db.tasks.findBy('workspaceId', workspaceId);
      const tasks = projectId === undefined ? all : all.filter((task) => task.projectId === projectId);
      const today = clock().slice(0, 10);
      const byStatus = Object.fromEntries(STATUSES.map((status) => [status, 0]));
      const byPriority = Object.fromEntries(PRIORITIES.map((priority) => [priority, 0]));
      let overdue = 0;
      let unassigned = 0;
      for (const task of tasks) {
        byStatus[task.status] += 1;
        byPriority[task.priority] += 1;
        if (isOverdue(task, today)) overdue += 1;
        if (task.assignee === null) unassigned += 1;
      }
      return { total: tasks.length, byStatus, byPriority, overdue, unassigned };
    },
  };
}
