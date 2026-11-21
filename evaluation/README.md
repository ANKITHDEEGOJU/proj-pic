# Evaluation: two baselines versus LEARNX

`run-evaluation.js` runs the same eight workloads against three implementations and counts how many
outcomes are wrong.

| Implementation | File | What it has | What it lacks |
|---|---|---|---|
| **Naive baseline** | `baseline.js` | Each webhook turns an access flag on or off and records revenue; limits are "read, then write" | Deduplication, order matching, race-safe limits, event history, retry, reconciliation |
| **Careful baseline** | `baseline-careful.js` | The usual webhook advice: one row per payment id (duplicates ignored), payment must match the order's amount and currency, quota as one conditional `UPDATE`, seats under a row lock, one-time approval as a conditional `UPDATE` | Event history (access is still a flag), handling a refund that arrives before its payment (it is ignored), reconciliation |
| **LEARNX** | the real code | Webhook inbox and processor, append-only ledger and projection, retry worker, reconciliation, quotas, seats, agent purchase service | (see the report, Section 8) |

The careful baseline is there so the comparison is not against a strawman: it shows which failures
ordinary care already prevents, and which ones need LEARNX's design.

Both baselines run in their own schemas (`eval_baseline`, `eval_careful`) on the same PostgreSQL
server, and are dropped afterwards. The payment provider is simulated in-process (the same approach as
`test/verify-m2-m6.js`). Nothing external is called, and no keys are needed.

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

## Result (seed 42, 5 runs, size 10)

| | S1 | S2 | S3 | S4 | S5 | S6 | S7 | S8 p50 |
|---|---|---|---|---|---|---|---|---|
| Naive | 20 | 10 | 3 | 10 | 40 | 5 | 4 | 0.8 ms |
| Careful | 0 | **10** | **3** | 0 | 0 | 0 | 0 | 0.7 ms |
| LEARNX | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 5.0 ms |

Exact numbers, raw data and charts: `results/RESULTS.md`.

## How to read it (limits of this evaluation)

- **What it shows.** Duplicates, tampered amounts and races (S1, S4–S7) are handled by ordinary care;
  LEARNX's design adds correctness for **out-of-order events (S2)** and **lost events (S3)**, at about
  4 ms extra per webhook. It also keeps a full event history; that is not measured here.
- **The error counts follow from the inputs.** For example, S1's 20 is 10 payments × 2 extra copies.
  They show whether a design handles a failure, not how often a failure happens in production.
- **Runs are deterministic.** Every count was identical in all 5 runs (only S8's timings vary), so
  the repetitions confirm repeatability, not a statistical distribution.
- **S2 depends on a choice.** The careful baseline ignores a refund for an unknown payment and
  answers 200, the common choice. Answering "retry later" and having the provider resend works too;
  that is the mechanism LEARNX implements (webhook inbox + retry worker).
- **Simulated provider, no HTTP.** Webhooks go straight to the inbox and processor with the same SQL
  as `src/routes/webhooks.js`; signature checks and the HTTP route are covered by the test suites
  (`npm run verify:failures` runs both servers with signed webhooks), not here.
- **Small sizes.** 10 users per workload; this is not a load test.

## Run

```bash
npm run db:init                       # schema up to date
node evaluation/run-evaluation.js     # or: --runs 5 --size 10 --seed 42   (npm run evaluate)
```

Output in `evaluation/results/`:

| File | Content |
|---|---|
| `RESULTS.md` | Tables and charts |
| `latest.json`, `raw-<timestamp>.json` | Every run's raw metrics, plus environment (commit, Node, PostgreSQL, OS, CPU, seed) |
| `summary.csv` | Mean, min and max per metric and implementation |
| `chart-incorrect-outcomes.svg`, `chart-webhook-latency.svg` | The two charts |

The script removes its own rows afterwards. The ledger rows of the generated `eval_*@test.local` users
stay, because the ledger is append-only by design.

## Known defect found by the evaluation

The first S6 run used 10 simultaneous assignments and froze the whole app. Each assignment holds a
database connection while it waits for the pack lock, and the one holding the lock needs more
connections than the pool of 10 has left. The seat count stays correct; the app stops responding until
it is restarted.

A fix (an in-memory queue so that waiting assignments hold no connection) was prototyped and passed,
but it is **not part of the submitted code** (ADR-020). S6 therefore uses 6 parallel assignments, below
the pool size, so it measures correctness of the race rather than the freeze. The freeze is listed as a
known defect in the report (Section 8) and as a GitHub issue.
