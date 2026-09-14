// V19.8.2 Job Lifecycle Manager
export class JobLifecycle {
  constructor({timeoutMs = 30000} = {}) {
    this.timeoutMs = timeoutMs;
    this.jobs = new Map();
  }
  create(id, meta={}) {
    const now = Date.now();
    const job = {id, state:"STARTING", createdAt:now, lastHeartbeat:now, heartbeats:0, ...meta};
    this.jobs.set(id, job);
    return job;
  }
  heartbeat(id, data={}) {
    const job=this.jobs.get(id);
    if(!job) return null;
    job.lastHeartbeat=Date.now();
    job.heartbeats++;
    job.state="RUNNING";
    Object.assign(job,data);
    return job;
  }
  inspect(id) {
    return this.jobs.get(id) || null;
  }
  check(id) {
    const job=this.jobs.get(id);
    if(!job) return {ok:false, reason:"unknown_job"};
    const stalled = Date.now()-job.lastHeartbeat > this.timeoutMs;
    return {ok:!stalled, stalled, state:job.state};
  }
}
