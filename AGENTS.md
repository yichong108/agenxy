# Agent instructions

This file guides AI assistants and contributors working on this repository.

## Project

**Agenxy** — an Electron desktop app for agents (React, Ant Design, AI SDK, MCP). Main code lives under `src/` (`main`, `renderer`, `preload`).

## Package Manager

- **pnpm is the only allowed package manager.** npm must not be used for this project. All dependency management operations (installing, updating, adding dependencies) must be performed using pnpm.

## Language and commits

- **Git commit messages, PR titles, and PR descriptions must be written in English.** Use clear, imperative-style subjects (e.g. "Fix workspace pane scroll", "Add MCP reconnect handler"). Body text may add context in English when helpful.
- **Follow Conventional Commits format:** `<type>(<scope>): <description>`

  - **Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `merge`, `improvement`
  - **Scope:** optional, describes the module/page (e.g., `feat(auth):`, `fix(payment):`)
  - **Description:** imperative mood, max 50 characters, no period
  - **Examples:**
    - `feat(auth): add OAuth2 support`
    - `fix(api): resolve rate limit bypass`
    - `perf(dashboard): lazy load chart data`
    - `docs: update API documentation`
  - **Breaking changes:** add `!` before `:` or include `BREAKING CHANGE:` in footer

- **Changelog-style or release notes entries** intended for the repo or automation should also be in English unless an existing localized process says otherwise.
- User-facing UI copy and docs may follow product language choices; this rule applies to **version control and review metadata** (commits, PRs, merge commit messages).

## Code changes

- Keep diffs focused on the requested task; avoid unrelated refactors.
- Match existing naming, imports, and patterns in touched files.
- Run checks the project defines (e.g. `pnpm typecheck`, `pnpm lint`) before opening a PR when feasible.

## Communication

- When the maintainer asks for responses in a specific language (e.g. chat replies), follow that request for **conversation**; **commits and PR text remain English** as above.
