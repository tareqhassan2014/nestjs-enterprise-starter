# Commit Quality

## Purpose

Local git quality gates: Husky-managed hooks, lint-staged on staged TypeScript, and Conventional Commits validation on commit messages.

## Requirements

### Requirement: Husky-managed git hooks install on dependency install

The repository SHALL install git hooks via Husky when a contributor runs the package manager’s install lifecycle (`prepare` or equivalent). Hooks MUST live in-repo under a conventional Husky directory so clones receive them after install without a separate global tool.

#### Scenario: Fresh install wires hooks

- **WHEN** a contributor clones the repository and runs `pnpm install`
- **THEN** Husky hooks are installed into the local git hooks path

#### Scenario: Hooks are versioned

- **WHEN** the repository is inspected
- **THEN** Husky hook scripts are committed under `.husky/` (or the project’s chosen Husky path)

### Requirement: Pre-commit runs lint-staged on staged TypeScript

A pre-commit hook SHALL run lint-staged against staged TypeScript files under application, test, and scripts trees. The staged-file pipeline MUST include ESLint with autofix where the project already supports `--fix`, and MUST NOT run the full unit or e2e suites on every commit.

#### Scenario: Staged lint error blocks commit

- **WHEN** a contributor stages a TypeScript file that fails ESLint and attempts to commit
- **THEN** the pre-commit hook fails and the commit is not created

#### Scenario: Untouched files are not linted by the hook

- **WHEN** a contributor commits a change that does not stage a given TypeScript file
- **THEN** lint-staged does not require that unstaged file to be lint-clean for the hook to pass

### Requirement: Commit messages follow Conventional Commits

A commit-msg hook SHALL validate commit subjects against the Conventional Commits specification (type optional scope, description). Commits that do not match MUST be rejected locally.

#### Scenario: Conventional subject is accepted

- **WHEN** a contributor commits with a subject like `feat(docs): tighten five-minute first run`
- **THEN** the commit-msg hook accepts the message

#### Scenario: Non-conventional subject is rejected

- **WHEN** a contributor commits with a free-form subject like `wip stuff`
- **THEN** the commit-msg hook rejects the commit

### Requirement: Escape hatches are documented

The README or contributor docs MUST document how to skip hooks in an emergency (`HUSKY=0` and/or `--no-verify`) and MUST state that CI quality gates still apply.

#### Scenario: Contributor finds bypass guidance

- **WHEN** a contributor reads the documented developer workflow for git hooks
- **THEN** the docs state how to bypass hooks intentionally and that CI remains authoritative
