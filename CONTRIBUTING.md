# Contributing to notion-ical-bridge

Thanks for your interest. This project is open source under MIT — fork it, run it, modify it. PRs are welcome.

## Code of Conduct

By participating, you agree to follow the [Code of Conduct](./CODE_OF_CONDUCT.md). In short: be kind, be patient, assume good faith.

## Branching model: Git Flow

We follow the classic [Git Flow](https://nvie.com/posts/a-successful-git-branching-model/) model.

| Branch | Purpose | Direct pushes? |
|--------|---------|----------------|
| `main` | Production-ready code, tagged releases only | No — protected, PRs only |
| `develop` | Integration branch for completed features | No — protected, PRs only |
| `feature/<name>` | New features and improvements | Yes — push freely; PR into `develop` |
| `release/<version>` | Stabilization for an upcoming release | Yes — push for fixes; PR into `main` AND `develop` |
| `hotfix/<name>` | Urgent fixes for production | Yes — push for fixes; PR into `main` AND `develop` |

### Naming

- `feature/add-google-cal-quirk-handling`
- `feature/issue-42-fix-timezone`
- `release/1.1.0`
- `hotfix/leak-token-in-error-log`

Use lowercase, hyphenated, prefixed.

## Workflow

```bash
# Start from develop
git checkout develop
git pull origin develop

# Create a feature branch
git checkout -b feature/your-feature

# Hack, commit
git add .
git commit -m "feat: add support for foo property type"

# Push and open PR
git push -u origin feature/your-feature
# Then open a PR in GitHub targeting `develop`
```

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <short description>

<optional body explaining why>
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`, `build`.

Examples:
- `feat: add per-calendar token auth`
- `fix: handle null date property without crashing`
- `docs: clarify webcal vs https URL trick`
- `test: add fixtures for all-day date ranges`

## Pull request checklist

Before requesting review, please ensure:

- [ ] `pnpm test` passes
- [ ] `pnpm typecheck` passes
- [ ] New code has tests (we aim for >=80% coverage)
- [ ] No `any` without an explanatory comment
- [ ] No secrets, tokens, or hardcoded user-specific data
- [ ] PR description explains *why* (not just *what*)
- [ ] PR targets `develop` (or `main` for hotfixes/releases)

## Development setup

Requires Node 22+ and pnpm.

```bash
pnpm install
pnpm test          # run tests
pnpm test:watch    # TDD mode
pnpm typecheck     # strict TS
pnpm dev           # start server with hot reload
pnpm build         # produce dist/ for production
```

## Code style

- Strict TypeScript — no `any` without comment
- ESM with `.js` import suffixes (NodeNext requires this even when source is `.ts`)
- All async paths use try/catch; no unhandled promise rejections
- Logging via Fastify's pino logger; never `console.log` in committed code
- Tests live in `test/` mirroring `src/` structure

## Reporting bugs

Use the [bug report template](https://github.com/Afro666/notion-ical-bridge/issues/new?template=bug_report.yml). Include:
- Server version (commit hash or release tag)
- A redacted snippet of your `config.yaml` (remove tokens and database IDs)
- The Notion property types involved
- Calendar client (Apple, Google, Outlook, etc.)

## Reporting security issues

**Do not open a public issue for security vulnerabilities.** See [SECURITY.md](./SECURITY.md).

## Questions

Open a [Discussion](https://github.com/Afro666/notion-ical-bridge/discussions) (once enabled) or a feature-request issue.
