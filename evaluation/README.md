# Evaluation: baseline versus LEARNX

`run-evaluation.js` runs the same eight workloads against two implementations and records how many
outcomes are wrong.

- **Baseline** (`baseline.js`): the straightforward design. Each webhook directly turns an access flag on
  or off and records revenue. There is no inbox, ledger, deduplication, order matching, amount check or
  reconciliation, and limits are "read, then write" in application code. It runs in its own schema
  (`eval_baseline`) on the same PostgreSQL server, which is dropped afterwards.
- **LEARNX**: the real code. Webhook inbox and processor, append-only ledger and projection, retry
  worker, reconciliation, quotas, seats and the agent purchase service.

The payment provider is simulated in-process (the same approach as `test/verify-m2-m6.js`). Nothing
external is called, and no keys are needed.

## Workloads and metrics

| ID | Workload | Correct outcome | Metric ("incorrect outcomes") |
|---|---|---|---|
| S1 | Each payment webhook delivered 3×, shuffled, concurrently | One purchase and one charge per payment | Extra purchases recorded |
| S2 | Refund delivered before its purchase | No access after the refund | Users with access after refund |
| S3 | 30 % of payment webhooks dropped, then reconciliation | Every paying user has access | Paying users without access |
| S4 | Half pay 0.01; half pay the right number in JPY | No access | Users wrongly granted |
| S5 | 50 parallel quota requests, limit 10 | Exactly 10 accepted | \|accepted − 10\| |
| S6 | 6 parallel assignments to a 1-seat pack | Exactly 1 seat used | Seats over capacity |
| S7 | One approval executed 5× in parallel | Exactly 1 order | Extra orders |
| S8 | Time to process one payment webhook | — (cost of the safety) | p50 / p95 in ms |

Each workload uses `--size` users (default 10) and is repeated `--runs` times (default 5). Shuffles
come from a seeded generator (`--seed`, default 42), so a run can be reproduced.

## Run

```bash
npm run db:init                       # schema up to date
node evaluation/run-evaluation.js     # or: --runs 5 --size 10 --seed 42
```

Output in `evaluation/results/`:

| File | Content |
|---|---|
| `RESULTS.md` | Tables and charts |
| `latest.json`, `raw-<timestamp>.json` | Every run's raw metrics, plus environment (commit, Node, PostgreSQL, OS, CPU, seed) |
| `summary.csv` | Mean, min and max per metric |
| `chart-incorrect-outcomes.svg`, `chart-webhook-latency.svg` | The two charts |

The script removes its own rows afterwards. The ledger rows of the generated `eval_*@test.local` users
stay, because the ledger is append-only by design.

## Known defect found by the evaluation

The first S6 run used 10 simultaneous assignments and froze the whole app. Each assignment holds a
database connection while it waits for the pack lock, and the one holding the lock needs more
connections than the pool of 10 has left. The seat count stays correct; the app stops responding until
it is restarted.

A fix (an in-memory queue so that waiting assignments hold no connection) was prototyped and passed,
but it is **not part of the submitted code** (ADR-031). S6 therefore uses 6 parallel assignments, below
the pool size, so it measures correctness of the race rather than the freeze. The freeze is listed as a
known defect in the report (§8) and as a GitHub issue.
