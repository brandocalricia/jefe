import { createAuditService } from './audit-service.mjs';
import { createCommentService } from './comment-service.mjs';
import { createMemberService } from './member-service.mjs';
import { createProjectService } from './project-service.mjs';
import { createReportService } from './report-service.mjs';
import { createTaskService } from './task-service.mjs';
import { createWorkspaceService } from './workspace-service.mjs';

// ctx: { db, bus, clock, audit }. Every service method takes the acting user id first; all but
// workspaces.create and workspaces.listForUser take the workspace id second.
export function createServices(ctx) {
  return {
    workspaces: createWorkspaceService(ctx),
    members: createMemberService(ctx),
    projects: createProjectService(ctx),
    tasks: createTaskService(ctx),
    comments: createCommentService(ctx),
    reports: createReportService(ctx),
    audit: createAuditService(ctx),
  };
}
