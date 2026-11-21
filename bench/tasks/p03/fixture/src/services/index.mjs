import { createAuditService } from './audit-service.mjs';
import { createCommentService } from './comment-service.mjs';
import { createProjectService } from './project-service.mjs';
import { createReportService } from './report-service.mjs';
import { createTaskService } from './task-service.mjs';

// ctx: { db, bus, clock, audit }. Every service method takes the acting user id first.
export function createServices(ctx) {
  return {
    projects: createProjectService(ctx),
    tasks: createTaskService(ctx),
    comments: createCommentService(ctx),
    reports: createReportService(ctx),
    audit: createAuditService(ctx),
  };
}
