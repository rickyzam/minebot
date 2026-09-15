# <stage> r<N> — response

<!-- Author writes this. Copy to docs/reviews/<YYYY-MM-DD>-<slug>/<stage>-r<N>-response.md.
     Delete every comment before committing. See docs/REVIEW-PROTOCOL.md §4.4–4.5.
     Every finding ID in the round gets exactly one row — Minors included. -->

**Findings:** [`<stage>-r<N>-findings.md`](<stage>-r<N>-findings.md)

## Dispositions

| ID | Disposition | Detail |
|---|---|---|
| <!-- S1-m1 --> | <!-- fixed <sha> --> | |
| <!-- S1-C1 --> | <!-- accept-recommended --> | <!-- will implement; SHA goes in the next request --> |
| <!-- S1-M2 --> | <!-- propose --> | <!-- see below --> |
| <!-- S1-M3 --> | <!-- dispute --> | <!-- see below --> |
| <!-- S1-m2 --> | <!-- leave --> | <!-- Minor only: why it is not worth changing --> |

## Proposals

<!-- One per `propose` row. Describe the fix, the files and tests it changes. WRITE NO CODE until confirmed. -->

### S1-M2

## Disputes

<!-- One per `dispute` row. Evidence: file:line, a test, a measurement, a spec section. -->

### S1-M3

## Author-found issues

<!-- Problems you noticed while fixing and deliberately did NOT fix. The reviewer classifies them. Or "None." -->

## Next

<!-- One of:
     "No proposals, disputes or human questions — implementing accepted fixes; r<N+1> request follows."
     "Waiting for confirmation on: S1-M2, S1-M3." -->
