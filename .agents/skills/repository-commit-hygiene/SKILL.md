---
name: repository-commit-hygiene
description: Audit KhataSathi commits and pushes so local, generated, internal-process, and non-codebase artifacts never enter Git while legitimate product functionality remains intact.
---

# Repository Commit Hygiene

Use this skill whenever preparing, reviewing, amending, or pushing a KhataSathi commit.

## Required preflight

Run the local path-policy checker from the repository root before a commit or push:

```powershell
python .agents/skills/repository-commit-hygiene/scripts/check_hygiene.py
```

It checks HEAD and the index, prints only violations, and exits nonzero on failure.
For commit preparation, HEAD-only violations already removed from the index are
reported as pending cleanup. Before pushing, append --pre-push for the strict
HEAD-and-index gate; the default invocation alone is not the push gate.
Inspect git status --short and the staged diff for semantic review, without dumping
the full tracked tree. Refuse to commit or push forbidden paths. Stage intended files
explicitly and preserve local files. This is an agent-run check, not an installed Git hook.

## Canonical workflow exception

Only explicitly designated canonical repository workflow assets may be committed. Local, personal, session, and generated AI artifacts remain forbidden. The exact path allowlist enforced by `check_hygiene.py` is:

```text
AGENTS.md
GEMINI.md
docs/engineering/ai/README.md
docs/engineering/ai/tasks/TASK_TEMPLATE.md
docs/engineering/ai/reports/IMPLEMENTATION_REPORT_TEMPLATE.md
docs/engineering/ai/reviews/REVIEW_TEMPLATE.md
.agents/skills/repository-commit-hygiene/SKILL.md
.agents/skills/repository-commit-hygiene/scripts/check_hygiene.py
.agents/skills/repository-commit-hygiene/scripts/test_hygiene.py
.agents/skills/khatasathi-workflow-router/SKILL.md
.agents/skills/khatasathi-implementation-planner/SKILL.md
```

An allowed path is eligible for review, not automatically authorized for a commit. Keep the checkpoint, progress dashboard, task registry, individual tasks, plans, reports, reviews, backlog, Master Plan, personal skills, transcripts, and scratch material ignored unless a separate narrow policy decision designates exact files. Do not force-add ignored paths.

## Always forbidden

- Every Markdown file (`*.md`, case-insensitive) except the root `README.md` and the exact canonical paths above. Other guides, plans, workflows, validations, specifications, and skill documents remain forbidden.
- Local agent or AI-working directories such as `.agents/` and `ThingsforAI/`, except the exact canonical skill files above.
- Runtime/user data such as root `document-storage/`, uploads, backups, database files, logs, build output, caches, dependency directories, coverage, and test reports.
- The root-level `scripts/` workspace, including one-off product-image importers, agent instructions, catalog-review packages, images, and mapping exports. This does not prohibit maintained utilities under `backend/src/scripts/`.
- The existing repository screenshots under `screenshots/` are approved documentation assets and may remain tracked.
- Browser/editor metadata, especially `frontend/public/.well-known/appspecific/com.chrome.devtools.json`.
- Sample production configuration, especially `deploy/production.env.example`, and any real environment or secret file.
- The obsolete diagnostic `backend/check_db.ts`.
- Internal pilot, clean-pilot, or rehearsal artifacts:
  - `deploy/compose.pilot-review.yml`
  - `deploy/scripts/prepare-clean-pilot.ps1`
  - `deploy/scripts/prepare-local-rehearsal.ps1`
  - `backend/src/scripts/auditCleanPilot.ts`
  - `backend/src/scripts/cleanPilotBundle.ts`
  - `backend/src/scripts/cleanPilotSource.ts`
  - `backend/src/scripts/exportCleanPilotIdentities.ts`
  - `backend/src/scripts/importCleanPilotIdentities.ts`
  - `backend/src/scripts/rehearseNeutralRateCatalog.ts`
  - `backend/src/tests/cleanPilotBundle.test.ts`
- Optional and one-time backend tooling that has been retired from the tracked codebase:
  - `backend/src/scripts/benchmarkImportExtraction.ts`
  - `backend/src/scripts/benchmarkProductSearchTypoTolerance.ts`
  - `backend/src/scripts/fulfillSupplierStock.ts`
  - `backend/src/scripts/importApprovedNeutralRateCatalog.ts`
  - `backend/src/scripts/importSupplierProducts.ts`
  - `backend/src/scripts/prepareApprovedNeutralRateCatalog.ts`
  - `backend/src/scripts/remediateArchivedUserPhones.ts`

Also reject newly added one-off analysis, audit, benchmark, migration-helper, data-preparation, generated-media, or debugging scripts when they are not called by the application, a maintained test, a deployment entrypoint, or an intentional package command. Flag ambiguous files for user review; do not infer permission to delete them.

## Legitimate AI product functionality

Do not classify Gemini extraction as repository residue. Gemini integration in application modules, UI, tests, deployment wiring, environment-variable reads, model configuration, and extraction prompts is valid KhataSathi functionality. The prohibition concerns AI working artifacts and authorship residue, not AI-powered product features.

## Sensitive content and secret blocking

Suspected secrets, credentials, and sensitive private data inside any tracked or staged file are a HARD commit blocker. Do not rely solely on path allowlisting or `.gitignore`.

The checker audits staged index and commit content for:
- API keys (AWS, GitHub, Slack, generic API keys)
- Access and refresh tokens, Bearer tokens
- Hardcoded passwords and password assignments
- JWT, session, and OAuth secrets
- Database credentials and credential-bearing connection strings (`mysql://`, `postgres://`, `mongodb://`, `redis://`, etc.)
- SSH private keys and private certificates (`-----BEGIN ... PRIVATE KEY-----`, `-----BEGIN ... CERTIFICATE-----`)
- Cloud, VPS, and backup credentials (`aws_secret_access_key`, `cloud_api_key`, `restic_password`)
- Real environment configurations and raw credential assignments
- Database dumps (MySQL or PostgreSQL dump headers, bulk table INSERT statements)
- Sensitive customer/payment data (e.g. credit card numbers)

### Enforcement and reporting behavior:
1. **HARD STOP:** If a suspected secret or sensitive data pattern is detected, the check exits nonzero (`BLOCK [index:content]`).
2. **Never print secrets:** The checker NEVER prints the discovered secret value or the full line content.
3. **Safe metadata only:** Reports only `file_path:line_number`, category/type, and remediation guidance:
   `BLOCK [index:content] path/file.ts:42: suspected api-key-or-token. Remediation: Remove sensitive value from tracked files; use environment variables or test fixtures.`
4. **Resolution required:** The finding must be completely remediated before commit hygiene can PASS.
5. **Candidate value filtering:** Safe synthetic placeholder exemptions (e.g. `test-`, `dummy-`, `mock-`, `placeholder-`) apply strictly to the candidate value itself. Surrounding comments or descriptive text (such as `// example` or `// test`) cannot cause an otherwise secret-like value to bypass detection. Private keys, certificates, provider tokens, dumps, and card numbers are unconditionally blocked.

## Commit and push gate

Check staged and tracked paths case-insensitively against the policy. Also inspect staged text for local absolute paths, assistant names, prompt-development notes, generated-by statements, real credentials, and unrelated internal commentary. Product prompts used at runtime by Gemini are allowed.

If a forbidden file is staged, stop and identify it. Unstage it only when doing so is within the user's requested commit preparation. Never commit or push first and clean up afterward.
