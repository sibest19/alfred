# Agent instructions

Read README.md for the project structure and development checks.

## Public repository

This repository is public and open source. Commit generic code, sanitized examples
and clearly synthetic test data only. Keep personal identities, real messages,
workflow exports, credentials and private infrastructure configuration outside it.
Review the public diff, commit history, PR text and included artifacts before
pushing; secret scanning alone does not detect identifying information.

## Clean migrations

Compatibility is temporary. Record a removal step for every compatibility shim,
fallback, duplicate path or legacy credential introduced during a migration.
A migration is complete only after callers have moved and the superseded code,
configuration, credentials, workflows, components and dependencies are removed.
Verify supported behavior and rejection of retired access paths. Update rollback
and restore procedures so they do not silently reinstate retired credentials or
components.
