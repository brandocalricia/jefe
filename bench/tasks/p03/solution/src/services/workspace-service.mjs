import { buildMembership, buildWorkspace, validateWorkspaceInput } from '../domain/workspace.mjs';
import { authorize, emit, subject } from './support.mjs';

export function createWorkspaceService(ctx) {
  const { db, clock } = ctx;
  const view = (workspace, role) => ({ ...workspace, role });

  return {
    // Any user can start a workspace; they become its first owner.
    create(actor, input) {
      const now = clock();
      const draft = buildWorkspace({ input, actor, now });
      const workspace = db.workspaces.insert({ id: db.nextId('workspace'), ...draft });
      db.memberships.insert(buildMembership({ workspaceId: workspace.id, user: actor, role: 'owner', actor, now }));
      emit(ctx, now, 'workspace.created', actor, workspace.id, subject('workspace', workspace.id), { name: workspace.name });
      emit(ctx, now, 'member.added', actor, workspace.id, subject('member', actor), { role: 'owner' });
      db.save();
      return view(workspace, 'owner');
    },

    get(actor, workspaceId) {
      const membership = authorize(db, actor, workspaceId, 'workspace.read');
      return view(db.workspaces.get(workspaceId), membership.role);
    },

    // Workspaces the actor belongs to, in creation order.
    listForUser(actor) {
      const roles = new Map(db.memberships.findBy('user', actor).map((m) => [m.workspaceId, m.role]));
      return db.workspaces.all().filter((w) => roles.has(w.id)).map((w) => view(w, roles.get(w.id)));
    },

    rename(actor, workspaceId, input) {
      const membership = authorize(db, actor, workspaceId, 'workspace.update');
      const now = clock();
      const { name } = validateWorkspaceInput(input);
      const previous = db.workspaces.get(workspaceId).name;
      const saved = db.workspaces.update(workspaceId, { name });
      emit(ctx, now, 'workspace.renamed', actor, workspaceId, subject('workspace', workspaceId), { name, previous });
      db.save();
      return view(saved, membership.role);
    },
  };
}
