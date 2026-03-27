# Contributing

This project accepts small fixes and improvements, but all contributions are
subject to the terms below.

By submitting any contribution to this repository, including code, tests,
documentation, or other material intended for inclusion in the project, you
represent that you have the right to submit that contribution and you agree
that:

- You retain ownership of your contribution.
- You grant Yikai Lan and their successors and assigns a perpetual, worldwide,
  non-exclusive, irrevocable, royalty-free license to use, reproduce, modify,
  distribute, sublicense, publicly display, publicly perform, and relicense
  your contribution, as part of this project or otherwise, under any license
  terms.
- To the extent you have the right to do so, you also grant a perpetual,
  worldwide, non-exclusive, irrevocable, royalty-free patent license covering
  patent claims necessarily infringed by your contribution as submitted.
- You understand that this project is distributed under the Elastic License 2.0
  and that the maintainer may offer the project, including your contribution,
  under different license terms in the future.

If you do not agree to these terms, do not submit a pull request or patch.
Issues and design feedback are still welcome.

## Code Organization

- Default to keeping production code and tests in separate files once a module
  is non-trivial. Prefer sibling test modules such as `foo/tests.rs` or a
  crate-level `tests.rs` over growing inline `mod tests` blocks inside the main
  implementation file.
- Small leaf helpers can still keep a tiny inline test block when it is the
  clearest option, but larger files should move tests out before they become a
  second concern mixed into the main code path.
