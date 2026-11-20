# 04 — GitHub–Railway Commit Synchronization Report

**Project:** Celebration Sisters Event Decor  
**Railway Staging Project:** `celebration-sisters-staging` (`786a7d31-23a8-4154-8185-0d5f07914c24`)  
**Railway Staging Environment:** `0ad6480e-6259-4a1a-81f8-a4bc89869cca`  
**Railway Staging Backend Service:** `5ba79779-aa42-4516-b294-900ef137f23c`  
**Staging URL:** `https://celebrationsisterseventdecor-staging-staging.up.railway.app/`  
**Audit Timestamp:** 2026-11-20T22:48Z

---

## 1. Critical Synchronization Invariant Check

```text
GITHUB_APPROVED_SHA  ===  RAILWAY_DEPLOYED_SHA  ===  STAGING_TESTED_SHA
```

| Commit Variable | Current Observed Value | Independent Evidence Source |
| --- | --- | --- |
| `GITHUB_REMOTE_HEAD_SHA` (`ops/staging-migration-job-20261121`) | `fdf693187be1993aa151f0ab8b2f0b41fb44fff7` | GitHub API (`pulls/21` + CI Run `44829640388`) |
| `WORKSPACE_RECONCILED_DELTA` | Unpushed local repairs on top of `fdf69318` | Preserved in `release-artifacts/phase32-reconciled/` |
| `RAILWAY_DEPLOYED_SHA` | **UNVERIFIED / BLOCKED** (last independently verified SHA prior to this run: `de848c890138ee00db72ce08e093a0f337215226`) | `RAILWAY_API_TOKEN` / `RAILWAY_TOKEN` not provisioned in sandbox |

---

## 2. Fail-Closed Gate Execution Evidence (`scripts/verify-staging-deployment.mjs`)

Running the upgraded verification gate without `RAILWAY_API_TOKEN` properly refused to fake synchronization and exited **`2` (`BLOCKED`)**:
```json
{
  "status": "BLOCKED",
  "exitCode": 2,
  "executedAt": "2026-11-20T22:48:24.253Z",
  "stagingUrl": "https://celebrationsisterseventdecor-staging-staging.up.railway.app",
  "githubApprovedSha": "fdf693187be1993aa151f0ab8b2f0b41fb44fff7",
  "railwayDeployedSha": null,
  "stagingTestedSha": null,
  "shaEvidenceSource": "none",
  "checks": [
    {
      "id": "independent_evidence_present",
      "passed": false,
      "detail": "Missing independent deployment evidence: DEPLOYED_COMMIT_SHA (or RAILWAY_API_TOKEN + RAILWAY_SERVICE_ID + RAILWAY_ENVIRONMENT_ID)"
    }
  ]
}
```

---

## 3. Exact Manual Procedure to Complete Phase 34 Synchronization

1. Push the reconciled commit from an authorized workstation to `ops/staging-migration-job-20261121` and record the new 40-character `GITHUB_APPROVED_SHA`.
2. Confirm GitHub Actions `CI Verification & Production Hardening Checks` + `Docker Production Image Build Check` both complete with `success` on `GITHUB_APPROVED_SHA`.
3. In Railway (`celebration-sisters-staging` -> service `5ba79779-aa42-4516-b294-900ef137f23c`):
   - Verify source repository `OphireumTechnology/CelebrationSistersEventDecor` and branch `ops/staging-migration-job-20261121`.
   - Record the previous successful deployment ID as the rollback candidate.
   - Confirm `EMAIL_LIVE_DELIVERY_ENABLED=false` and `RAILWAY_ENVIRONMENT_NAME=staging` (do not alter production services or database).
   - Deploy `GITHUB_APPROVED_SHA` and wait for `SUCCESS` status.
4. Execute the independent post-deploy verification gate (or trigger `.github/workflows/staging-deployment-gate.yml` with `RAILWAY_API_TOKEN` configured as a repository secret):
   ```bash
   STAGING_URL=https://celebrationsisterseventdecor-staging-staging.up.railway.app \
   GITHUB_APPROVED_SHA="<NEW_40_CHAR_SHA>" \
   RAILWAY_API_TOKEN="<SECRET_RAILWAY_TOKEN>" \
   RAILWAY_PROJECT_ID="786a7d31-23a8-4154-8185-0d5f07914c24" \
   RAILWAY_ENVIRONMENT_ID="0ad6480e-6259-4a1a-81f8-a4bc89869cca" \
   RAILWAY_SERVICE_ID="5ba79779-aa42-4516-b294-900ef137f23c" \
   node scripts/verify-staging-deployment.mjs --output staging-deployment-certification.json
   ```
5. Confirm exit code `0` (`PASS`) and `githubApprovedSha === railwayDeployedSha === stagingTestedSha`.

**Phase 34 Acceptance Status:** **BLOCKED** (requires GitHub push + Railway deployment access + `RAILWAY_API_TOKEN`).
