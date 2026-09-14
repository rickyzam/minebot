# <stage> r<N> — confirmation

<!-- Reviewer writes this, ONLY when the response has propose / dispute / needs-human rows.
     Copy to docs/reviews/<YYYY-MM-DD>-<slug>/<stage>-r<N>-confirmation.md.
     Delete every comment before committing. See docs/REVIEW-PROTOCOL.md §5.6. -->

**Response:** [`<stage>-r<N>-response.md`](<stage>-r<N>-response.md)

| ID | Row | Answer | Detail |
|---|---|---|---|
| <!-- S1-M2 --> | propose | <!-- confirmed · confirmed-with-change · rejected --> | <!-- the change, or why rejected and what would be acceptable --> |
| <!-- S1-M3 --> | dispute | <!-- withdrawn · upheld --> | <!-- evidence answering the author's --> |
| <!-- S1-M4 --> | needs-human | <!-- escalated · not a human question --> | |

<!-- This is the ONLY exchange a finding gets. After `rejected` or `upheld`, the author either takes the
     reviewer's fix or marks the ID `escalated` — no second proposal or dispute. A confirmation is not a round. -->

**Next:** <!-- "Author: implement confirmed fixes; for rejected/upheld rows, take the recommended fix or escalate; then write the r<N+1> request." -->
