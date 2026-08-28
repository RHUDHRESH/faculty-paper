/**
 * One sign-in per role, before anything runs.
 *
 * Six sessions are opened and written as `storageState` files. Every spec
 * then picks one up with `test.use({ storageState })` and starts already
 * signed in, so no test spends time on a login it is not testing — and the
 * one spec that *is* testing sign-out gets its own throwaway session so
 * ending it cannot strand anything else.
 *
 * Fixtures are cleaned first, not last. Cleaning up afterwards sounds tidier
 * and is worse: a run that crashes leaves the database dirty either way, and
 * cleaning at the start means the next run is the one that fixes it. It also
 * means the accounts are still sitting there to look at when something fails.
 */
import type { FullConfig } from "@playwright/test"

import { ROLES, cleanupFixtures, openSession, writeStorageState } from "./fixtures/backend"

async function globalSetup(_config: FullConfig) {
  cleanupFixtures()
  for (const role of ROLES) {
    writeStorageState(role, openSession(role))
  }
}

export default globalSetup
