import { notFound } from '../domain/errors.mjs';
import { isOverdue, PRIORITIES, STATUSES } from '../domain/task.mjs';

export function createReportService({ db, clock }) {
  return {
    // Counts for all tasks, or only the tasks of one project. "Today" is the date part of the clock.
    summary(actor, { projectId } = {}) {
      if (projectId !== undefined && !db.projects.get(projectId)) throw notFound('project');
      const tasks = projectId === undefined ? db.tasks.all() : db.tasks.findBy('projectId', projectId);
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
