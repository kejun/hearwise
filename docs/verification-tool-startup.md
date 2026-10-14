# Java verification-tool startup

`checkProtocolTools` verifies the pinned Quint/Apalache files and runs one real `java -version` process before model exploration. The startup probe has a bounded 30-second deadline and the same process-group cleanup as other checks. It does not retry automatically. TLC/BMC state domains, depths, and exploration deadlines are unchanged.

The previous five-second startup deadline failed without any Java output on independent GitHub-hosted jobs, before a model was launched:

- [Import setup, run 38600341319](https://github.com/kejun/hearwise/actions/runs/38600341319)
- [Knowledge setup, run 38601676524](https://github.com/kejun/hearwise/actions/runs/38601676524)
- [Import setup, run 38605920631](https://github.com/kejun/hearwise/actions/runs/38605920631/job/115996645950)

These are right-censored startup observations (more than five seconds), not model counterexamples or successful verification. The logs identify selected Java 21 and the command deadline, but do not establish the host-level cause. The longer finite startup allowance avoids conflating delayed infrastructure startup with an unsupported Java version. It is not a measured performance SLA.

A 2026-10-14 local observation on Linux 6.18.44 x64, AMD EPYC 9V74, nine available CPUs, OpenJDK 21.0.12.1 launched six fresh JVM processes: three without added load and three with two bounded CPU workers. All exited successfully in less than 100 ms. These are new-process samples, not a claim that operating-system file caches were cold, and they do not reproduce GitHub's slow startup or substitute for its final CI result.

`probeJavaVersion` records the exact command, arguments, startup deadline, start/end timestamps, elapsed time, exit code/signal, timeout/interruption flags, and captured output. Timeout is reported as `JAVA_STARTUP_TIMEOUT`, process failure as `JAVA_STARTUP_FAILED`, and successful execution of an unsupported/unidentifiable runtime as `JAVA_VERSION_UNSUPPORTED`. Failed setup remains failed/incomplete and cannot produce a passing model result.

The regression launches actual Java after a controlled 5.5-second process delay to check the separate startup allowance. It also verifies finite timeout, a single attempt, and rejection of failed, missing, or old version output. The controlled delay is a test input, not a Java latency measurement.
