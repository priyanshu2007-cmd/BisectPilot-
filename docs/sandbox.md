# Rootless Container Sandbox Execution

BisectPilot supports executing untrusted historical revisions inside an isolated rootless container sandbox using Docker or Podman.

## Security Guarantees & Constraints

1. **Non-Root Execution**: Container runs rootless without elevated host privileges.
2. **Digest-Pinned Images**: Requires an explicit digest-pinned container image (e.g., `node:20-alpine@sha256:...`) to ensure immutability.
3. **Mount Isolation**:
   - The tool-owned session worktree is mounted as the working volume.
   - Any external scripts or overlays are mounted read-only.
   - Host filesystem access outside the session worktree is strictly blocked.
4. **Network Access**: Can be disabled or restricted via sandbox configuration.

## CLI Usage

```bash
bisectpilot start \
  --good v1.0.0 \
  --bad HEAD \
  --yes \
  --sandbox-runtime docker \
  --sandbox-image node:20-alpine@sha256:d84... \
  -- npm test
```

## Configuration Schema

```json
{
  "execution": {
    "sandbox": {
      "runtime": "docker",
      "image": "node:20-alpine@sha256:d84...",
      "network": "none",
      "resources": {
        "memory": "2g",
        "cpus": 2
      }
    }
  }
}
```
