export function discoverCapabilities(modules = {}) {
  return Object.keys(modules)
    .filter(name => modules[name] === true);
}
