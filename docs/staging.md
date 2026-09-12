# Private Exmachina stage

The stable website is [MoneyWave on Exmachina](https://exmachina.tail3a0b66.ts.net:9443/). It requires the owner's Tailscale identity. The source preview remains at `http://127.0.0.1:43821/`.

Run under Node 24 from the repository:

```sh
pnpm stage:deploy
pnpm stage:status
pnpm stage:rollback
```

Deployment runs verification, builds a local immutable image, checks the container/host database channel with synthetic data, creates and verifies an encrypted backup, checks a candidate on loopback port 43823, then replaces the stage on 43822. The existing Tailscale Serve mapping remains unchanged. The prior image and its matching host broker/driver snapshot are retained for rollback. Rollback changes code only; it never restores or replaces financial records. A failed cutover restores the preceding runtime configuration atomically. Concurrent deployments are rejected; the ignored `deploy.lock/pid` records the active deployment process.

When other work is changing the checkout, `MONEYWAVE_RELEASE_SOURCE` may point to an explicitly prepared local release snapshot. The command verifies and builds that exact source; deployment configuration and the canonical database remain in the calling checkout. Preserve pending source changes and commit only the reviewed release contents.

The stage and source use the same existing SQLCipher store on macOS. The container never mounts the database: a synthetic test demonstrated that Colima does not preserve host SQLite locks. Instead, the host supervisor owns a native SQLCipher connection and serves the container over an unlogged Docker attach pipe. Native and container requests therefore use the same macOS locking implementation. Startup rejects missing data or an incompatible schema; it does not migrate or initialize the store. Stop and plan a separate verified migration if a later release needs one.

Docker commands explicitly use the `colima` context. The container `moneywave-stage` runs without root, with a read-only filesystem, no capabilities, bounded memory/processes and a dedicated bridge with IP masquerading and inter-container communication disabled. Only host loopback port 43822 is published. Docker's `--internal` network is unsuitable here because it suppresses published ports. The exact Tailscale origin, owner and private bridge peer are validated before session/CSRF checks. The categorization CLI is excluded from the image; processing operators remain on macOS. The website makes no external service calls.

The launchd job `local.moneywave.stage` supervises the container and starts the existing Colima profile if necessary. It reads the database key from macOS Keychain and opens the database on the host; the key never enters the container, an image, a plaintext file or an environment variable. Only query requests and results cross the local Docker pipe. Docker logging is disabled for that pipe. The broker permits reads in SQLite query-only mode and limits writes to the existing workspace history/state tables and transaction boundaries. It reconnects after a container restart. The host broker and native driver are copied into a versioned local release so source edits cannot change the running stage.

Local configuration, supervisor snapshot, encrypted backups and release state stay under ignored `data/runtime/hosting/container/`. The configuration contains the existing origin/owner, data path and Keychain identifiers, not secret values. The previous native `local.moneywave.stable` job is disabled after a successful cutover; its plist and release remain available for recovery. Other Exmachina applications and Serve ports are untouched.

After an update, verify the private HTTPS page in a browser, the current logo and period controls, all navigation sections and container restart recovery. `stage:status` reports container/HTTP status, not browser acceptance. The Mac must be online, awake and logged in with Keychain available after reboot; `caffeinate -s` prevents AC sleep while the supervisor runs.
