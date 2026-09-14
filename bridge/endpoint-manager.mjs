/** V19.9 Endpoint Manager
 * Keeps action endpoint state in one local file so future tunnel changes can be surfaced automatically.
 */
import fs from 'node:fs/promises';

export async function saveEndpointState(state, file='./bridge-endpoint.json') {
  await fs.writeFile(file, JSON.stringify({...state, updatedAt:new Date().toISOString()}, null, 2));
  return {saved:true,file};
}

export async function loadEndpointState(file='./bridge-endpoint.json') {
  try { return JSON.parse(await fs.readFile(file,'utf8')); }
  catch { return null; }
}
