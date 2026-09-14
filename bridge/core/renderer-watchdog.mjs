// V19.8.2 Renderer Watchdog
export function checkRenderer(job, timeoutMs=30000){
  if(!job) return {healthy:false, reason:"missing_job"};
  const age=Date.now()-job.lastHeartbeat;
  return age <= timeoutMs
    ? {healthy:true, age}
    : {healthy:false, reason:"heartbeat_timeout", age};
}
