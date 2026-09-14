/** V19.9 Paint lifecycle guard. Does not claim success without evidence. */
export function evaluatePaintJob(job, now=Date.now()) {
  const age = now - (job.createdAt ?? now);
  if (job.state === 'starting' && age > 10000 && (job.segmentsDone ?? 0) === 0) {
    return {state:'STARTING_TIMEOUT', recovery:'recheck-window-focus-canvas'};
  }
  if ((job.segmentsDone ?? 0) > 0) return {state:'RUNNING', evidence:['segments']};
  return {state:job.state ?? 'UNKNOWN', evidence:[]};
}
