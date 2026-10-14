These raw TLC logs are parser regression fixtures, captured from the declared
Quint models with the pinned toolchain. They are not a substitute for rerunning
checks on the delivery commit. Their complete states and cycle edges exercise
strict counterexample parsing, retained/omitted weak fairness, and a selector
violation that occurs on the cycle's closing edge.
