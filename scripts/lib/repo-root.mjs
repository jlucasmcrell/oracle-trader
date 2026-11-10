// The repository root, resolved from this file's own location rather than a hard-coded drive.
//
// Every recorder and grader used to name G:/PROJECTS/oracle-trader. That was the checkout on ASTRAL;
// after the 2026-10-14 move to BEAST the repo is at C:\Oracle_Recovery\oracle-trader and G: is a Google
// Drive mount, so a hard-coded root would write a parallel data/ tree into the synced drive. Forward
// slashes so the template strings built from it match the old literals.
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..').replaceAll('\\', '/')
