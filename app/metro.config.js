// Shares ../protocol with the gateway. Its bare imports (viem) resolve as if
// they came from this app, so there is one viem in the bundle, not the repo
// root's copy as well.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const PROTOCOL = path.resolve(__dirname, '../protocol');

config.watchFolders = [...(config.watchFolders ?? []), PROTOCOL];

const resolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const fromProtocol = (context.originModulePath ?? '').startsWith(PROTOCOL) && !moduleName.startsWith('.');
  const ctx = fromProtocol ? { ...context, originModulePath: path.join(__dirname, 'index.ts') } : context;
  return (resolve ?? context.resolveRequest)(ctx, moduleName, platform);
};

module.exports = config;
