import { conflict, notFound } from '../domain/errors.mjs';
import { applyProjectPatch, buildProject } from '../domain/project.mjs';
import { authorize, emit, subject } from './support.mjs';

export function createProjectService(ctx) {
  const { db, clock } = ctx;

  function load(workspaceId, id) {
    const project = db.projects.get(id);
    if (!project || project.workspaceId !== workspaceId) throw notFound('project');
    return project;
  }

  return {
    create(actor, workspaceId, input) {
      authorize(db, actor, workspaceId, 'project.write');
      const now = clock();
      const draft = buildProject({ input, actor, now });
      const project = db.projects.insert({ id: db.nextId('project'), workspaceId, ...draft });
      emit(ctx, now, 'project.created', actor, workspaceId, subject('project', project.id), { name: project.name });
      db.save();
      return project;
    },

    get(actor, workspaceId, id) {
      authorize(db, actor, workspaceId, 'project.read');
      return load(workspaceId, id);
    },

    // Archived projects are left out unless includeArchived is true.
    list(actor, workspaceId, { includeArchived = false } = {}) {
      authorize(db, actor, workspaceId, 'project.read');
      return db.projects.findBy('workspaceId', workspaceId).filter((project) => includeArchived || !project.archived);
    },

    update(actor, workspaceId, id, patch) {
      authorize(db, actor, workspaceId, 'project.write');
      const now = clock();
      const { project, fields } = applyProjectPatch(load(workspaceId, id), patch, now);
      const saved = db.projects.update(id, project);
      emit(ctx, now, 'project.updated', actor, workspaceId, subject('project', id), { fields });
      db.save();
      return saved;
    },

    archive(actor, workspaceId, id) {
      authorize(db, actor, workspaceId, 'project.archive');
      const now = clock();
      const project = load(workspaceId, id);
      if (project.archived) throw conflict('project is already archived');
      const saved = db.projects.update(id, { archived: true, updatedAt: now });
      emit(ctx, now, 'project.archived', actor, workspaceId, subject('project', id), {});
      db.save();
      return saved;
    },
  };
}
