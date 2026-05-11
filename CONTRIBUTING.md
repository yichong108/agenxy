# Contributing

Thank you for your interest in **Agenxy**. This document explains how to set up your environment, submit changes, and follow project conventions when working with maintainers.

Repository-wide guidance for humans and AI assistants is in [AGENTS.md](AGENTS.md).

## Prerequisites

- Install [Node.js](https://nodejs.org/) (LTS recommended).
- After cloning the repository, from the project root run:

```bash
npm install
```

## Local development and checks

| Command                | Purpose                             |
| ---------------------- | ----------------------------------- |
| `npm run dev`          | Development mode with HMR           |
| `npm run dev:debug`    | Development mode with debug ports   |
| `npm run typecheck`    | TypeScript check                    |
| `npm run lint`         | ESLint                              |
| `npm run lint:fix`     | ESLint with auto-fix where possible |
| `npm run format`       | Prettier write                      |
| `npm run format:check` | Prettier check                      |

Before opening a pull request, please run `typecheck` and `lint` locally when feasible. If you touch layout or style-heavy files, consider `format:check` or `format`.

## Repository layout (overview)

| Path            | Role                         |
| --------------- | ---------------------------- |
| `src/main/`     | Electron main process        |
| `src/renderer/` | React UI                     |
| `src/preload/`  | Preload and IPC bridges      |
| `src/shared/`   | Shared code across processes |

Match existing naming, imports, and patterns in the files you touch. Keep each PR focused on a single concern and avoid unrelated refactors.

## Pull request workflow

1. Create a feature branch from the latest default branch.
2. Prefer small commits with clear intent (“what” and “why”).
3. In the PR description, include motivation, a summary of changes, and how to verify manually when applicable.
4. Address review feedback; reorganize history with `git rebase` if maintainers ask.

## Language policy (important)

For collaboration and tooling, the following must be in **English**:

- Git **commit messages**
- **PR titles** and **PR bodies** (and changelog-style entries aimed at the repo or automation)

Use short, imperative subjects—for example: `Fix workspace pane scroll`, `Add MCP reconnect handler`.

User-facing UI copy and reader-facing documentation may follow product language choices; the rule above applies to **version control and review metadata** only. See [AGENTS.md](AGENTS.md).

## Code of conduct

Be respectful, professional, and constructive. Critique ideas and code, not people. Issues and pull requests are welcome for design and implementation discussion.

## License

By contributing code that is merged into this repository, you agree to license your contribution under the same terms as the project. If a `LICENSE` file (or equivalent) exists at the repository root, follow that file.
