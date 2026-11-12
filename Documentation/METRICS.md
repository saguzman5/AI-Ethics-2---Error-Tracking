# Metric Definitions

All metrics are calculated live by the server (`Source Code/src/reports.js`, function `metrics`) from the central database. The dashboard, spreadsheet and exports never calculate metrics from their own copies of the data.

## Three different things are counted

| Term | What is counted | Source |
|---|---|---|
| **Reported errors** | Error reports (rows in `error_reports`). | `COUNT(error_reports)` |
| **Affected products** | Distinct boxes with at least one error report. | `COUNT(DISTINCT box_id)` over error reports |
| **Products requiring rework** | Distinct boxes with at least one error report where `requires_rework = 1`. | `COUNT(DISTINCT box_id WHERE requires_rework = 1)` |
| **Products produced (in scope)** | Boxes registered in `products` whose `produced_at` falls in the selected date range (and that match the Order ID / Box ID filter). | `COUNT(products)` |

These are not interchangeable. One box can have three errors, and only one of them may need rework. Example: 10 errors on 4 boxes, of which 2 boxes needed rework, out of 100 boxes produced, gives a rework rate of 2 % (2 / 100), not 10 % or 4 %.

## When is a report marked "requires rework"?

- It is set automatically when a manager moves the report to **In Rework**.
- A manager can also tick or untick **Product requires rework** in the report panel, for example when a report is resolved by reworking without using the In Rework status, or when it was resolved as "within tolerance".
- The flag stays set after the report is Resolved, because it records that rework *was required*.
- Every change of the flag is written to the revision log.

## KPI formulas

| KPI | Formula |
|---|---|
| Total errors reported | `count(reports)` |
| Unresolved errors | `count(reports where status ∈ {Open, Under Review, In Rework})` |
| High & critical errors | `count(reports where severity ∈ {High, Critical})` |
| Resolved errors | `count(reports where status = Resolved)` |
| **Rework rate** | `products requiring rework ÷ products produced (in scope)` |
| Product error rate | `affected products ÷ products produced (in scope)` |
| Errors per affected product | `reported errors ÷ affected products` |
| Share of errors requiring rework | `reports with requires_rework ÷ reported errors` |
| Resolution rate | `resolved errors ÷ reported errors` |
| Average time to resolve | `mean(resolved_at − reported_at)` over Resolved reports. The median is shown too, because a few long cases can skew the mean. |
| Status counts | `count(reports)` per status: Open, Under Review, In Rework, Resolved |

If a denominator is 0 the metric is shown as "–" instead of 0 %.

## How filters apply

- **Date range** filters reports by `reported_at` and products by `produced_at`. Dates are calendar days in the factory time zone (`TIMEZONE` setting), inclusive of both ends.
- **Order ID** and **Box ID** filter both reports and products. They match any part of the ID (for example `0112` matches `PO-2026-0112`).
- **Stage, Error type, Severity and Status** describe errors, not products. They filter the reports (numerators) but not the "products produced" denominator. For example, with Stage = Welding the rework rate reads as "share of products produced in the period that needed rework because of a welding-stage error".

## Charts

| Chart | Data |
|---|---|
| Errors over time | Reports per local calendar day; days without reports show 0. |
| Errors by production stage | Reports per stage, highest first. Click a bar to filter. |
| Errors by type | Reports per error type (top 8 plus "Other types"). Click a slice or legend item to filter. |
| Error severity | Reports per severity with share of total. Click a bar to filter. |
| Most common errors | Top 10 combinations of *error type at stage*, ranked by count, with the number of High/Critical reports and the date last seen. |
