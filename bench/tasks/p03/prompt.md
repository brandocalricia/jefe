Please add workspaces and roles to `trackboard`, our small task tracker. Today it is one flat board where everybody sees everything; we are about to onboard several teams, so the data has to be split per workspace and each person needs a role (owner, editor or viewer) in every workspace they belong to.

`SPEC.md` in the repository root has the full requirements, split into parts A to F: the role and permission rules, the new data file version with a one-off migration command, workspace-scoped and permission-checked services, new events and an audit log with a retention rule, the new API routes and CLI commands, and a list of behaviour that must not change. `README.md` describes the current layout and documents the existing behaviour, which has to keep working inside a workspace. The work goes through every layer, so please read the existing code first and keep to the structure it already has.

Update the existing tests for the new signatures and routes, add tests for the new behaviour, and make `npm test` pass.

ANSWERS:
- Language and runtime: plain JavaScript ES modules, Node 22, standard library only, no dependencies
- Where: new and changed files under `src/` in the existing layers (domain, store, services, events, api, cli); tests under `tests/`
- Design: follow the existing layering and style; the paths, exports, signatures, messages and formats named in SPEC.md are exact; permission checks and workspace isolation live in the services, not in the API or CLI
- Scope: no new dependencies, no package.json changes; the README may be updated but nothing in it is required
