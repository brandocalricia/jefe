import { conflict, notFound } from '../domain/errors.mjs';
import { applyProjectPatch, buildProject } from '../domain/project.mjs';
import { emit, subject } from './support.mjs';

export function createProjectService(ctx) {
  const { db, clock } = ctx;

  function load(id) {
    const project = db.projects.get(id);
    if (!project) throw notFound('project');
    return project;
  }

  return {
    create(actor, input) {
      const now = clock();
      const draft = buildProject({ input, actor, now });
      const project = db.projects.insert({ id: db.nextId('project'), ...draft });
      emit(ctx, now, 'project.created', actor, subject('project', project.id), { name: project.name });
      db.save();
      return project;
    },

    get(actor, id) {
      return load(id);
    },

    // Archived projects are left out unless includeArchived is true.
    list(actor, { includeArchived = false } = {}) {
      return db.projects.all().filter((project) => includeArchived || !project.archived);
    },

    update(actor, id, patch) {
      const now = clock();
      const { project, fields } = applyProjectPatch(load(id), patch, now);
      const saved = db.projects.update(id, project);
      emit(ctx, now, 'project.updated', actor, subject('project', id), { fields });
      db.save();
      return saved;
    },

    archive(actor, id) {
      const now = clock();
      const project = load(id);
      if (project.archived) throw conflict('project is already archived');
      const saved = db.projects.update(id, { archived: true, updatedAt: now });
      emit(ctx, now, 'project.archived', actor, subject('project', id), {});
      db.save();
      return saved;
    },
  };
}
