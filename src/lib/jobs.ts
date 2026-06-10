// Shared job-status predicates. A job is "terminal" once it can never run
// again; everything else counts as in-flight (queued included).

import type { Job, JobStatus } from "./types";

export function isJobTerminal(status: JobStatus): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

/** Jobs still queued/running, optionally limited to a shot-path prefix
 *  (matches the path itself or anything under it). */
export function inFlightJobs(jobs: Job[], pathPrefix?: string): Job[] {
  return jobs.filter(
    (j) =>
      !isJobTerminal(j.status) &&
      (pathPrefix == null ||
        j.shotPath === pathPrefix ||
        j.shotPath.startsWith(pathPrefix + "/")),
  );
}
