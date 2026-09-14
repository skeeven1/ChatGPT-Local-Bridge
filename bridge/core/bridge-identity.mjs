export function createBridgeIdentity({version, pid, publicUrl}) {
  return {
    version,
    pid,
    publicUrl,
    generatedAt: new Date().toISOString()
  };
}
