# Hardware notes

All engines are run and costed on the same node class.

## Node class
- 4 vCPU, 16 GB memory, 500 GB local SSD, ARM architecture.
- One node of this class costs the same whichever engine runs on it.

## Test layout
- Each load test uses a single node with the engine under test, plus a separate load generator.
- Network is a single availability zone, so replication cost is not part of the measurements.
- Dana keeps the harness in the platform repository.
