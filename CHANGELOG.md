# Changelog

## 0.1.0 (unreleased)

- Blocks a tool call repeated with the same input and the same result (twice in a row, or in an A, B, A, B, A loop).
- Polling commands are never blocked, and a file edit starts the count over.
- After 3 blocked calls in a row, ends the turn so a stuck model waits for the user.
