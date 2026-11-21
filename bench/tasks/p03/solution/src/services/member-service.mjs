import { conflict, notFound } from '../domain/errors.mjs';
import { buildMembership, validateMemberInput, validateRole } from '../domain/workspace.mjs';
import { authorize, emit, membershipId, subject } from './support.mjs';

const RANK = { owner: 0, editor: 1, viewer: 2 };

export function createMemberService(ctx) {
  const { db, clock } = ctx;

  function load(workspaceId, user) {
    const membership = db.memberships.get(membershipId(workspaceId, user));
    if (!membership) throw notFound('member');
    return membership;
  }

  function guardLastOwner(workspaceId, membership) {
    if (membership.role !== 'owner') return;
    const owners = db.memberships.findBy('workspaceId', workspaceId).filter((m) => m.role === 'owner');
    if (owners.length === 1) throw conflict('workspace must keep at least one owner');
  }

  return {
    // Owners first, then editors, then viewers; by user id inside a role.
    list(actor, workspaceId) {
      authorize(db, actor, workspaceId, 'member.read');
      return db.memberships
        .findBy('workspaceId', workspaceId)
        .sort((a, b) => RANK[a.role] - RANK[b.role] || (a.user < b.user ? -1 : a.user > b.user ? 1 : 0));
    },

    add(actor, workspaceId, input) {
      authorize(db, actor, workspaceId, 'member.manage');
      const now = clock();
      const { user, role } = validateMemberInput(input);
      if (db.memberships.get(membershipId(workspaceId, user))) throw conflict('user is already a member');
      const membership = db.memberships.insert(buildMembership({ workspaceId, user, role, actor, now }));
      emit(ctx, now, 'member.added', actor, workspaceId, subject('member', user), { role });
      db.save();
      return membership;
    },

    setRole(actor, workspaceId, user, role) {
      authorize(db, actor, workspaceId, 'member.manage');
      const now = clock();
      validateRole(role);
      const membership = load(workspaceId, user);
      if (membership.role === role) return membership;
      if (role !== 'owner') guardLastOwner(workspaceId, membership);
      const saved = db.memberships.update(membership.id, { role });
      emit(ctx, now, 'member.role_changed', actor, workspaceId, subject('member', user), { role, previous: membership.role });
      db.save();
      return saved;
    },

    // A member may always leave; removing somebody else needs member.manage.
    remove(actor, workspaceId, user) {
      authorize(db, actor, workspaceId, actor === user ? undefined : 'member.manage');
      const now = clock();
      const membership = load(workspaceId, user);
      guardLastOwner(workspaceId, membership);
      db.memberships.remove(membership.id);
      emit(ctx, now, 'member.removed', actor, workspaceId, subject('member', user), { role: membership.role });
      for (const task of db.tasks.findBy('assignee', user)) {
        if (task.workspaceId !== workspaceId) continue;
        db.tasks.update(task.id, { assignee: null, updatedAt: now });
        emit(ctx, now, 'task.assigned', actor, workspaceId, subject('task', task.id), { assignee: null, previous: user });
      }
      db.save();
    },
  };
}
