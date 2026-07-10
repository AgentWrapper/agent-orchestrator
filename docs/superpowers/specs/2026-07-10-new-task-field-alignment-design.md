# New task field alignment design

## Context

In the desktop app's New task dialog, the Agent select renders at 36px while the adjacent Branch input renders at 32px. The Agent and Branch labels also use different primitives with different line-height rules. Together, the mismatched control heights and label rhythm make the two-column row appear vertically misaligned.

The Agent field already supplies an `h-8` class, but the shared `SelectTrigger` also carries the default-size selector `data-[size=default]:h-9`. That selector wins in the generated CSS, so the trigger remains 36px tall.

## Design

Set the agent field's `SelectTrigger` to the shared component's `sm` size. The small size resolves to 32px and matches the existing Branch `Input` without introducing one-off overrides. Render the Branch label with the same shared `Label` primitive as Agent so both columns use the same line height and vertical gap.

Keep the field grid, label text, Refresh agents action, responsive stacking, state, validation, and submission behavior unchanged. The shared agent field continues to use the existing select component and option catalog.

## Alternatives considered

- Increase the Branch input to 36px. Rejected because the dialog's inputs and buttons consistently use 32px controls.
- Add a stronger local height override. Rejected because selecting the supported `sm` size expresses the intended size through the component API and avoids competing utility classes.

## Verification

- Add a focused component assertion that the agent select uses the small trigger size.
- Assert that Agent and Branch use the same label primitive in the New task dialog.
- Run the focused frontend test.
- Run the frontend TypeScript check.
- Confirm the final diff contains no form behavior or refresh-action changes.
