// Mango's mobile app shares the desktop's agent adapters and chat types (`../app/agents`,
// `../app/types`), imported as `~/…` exactly as the desktop does (see tsconfig `paths`).
const path = require('path')
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)
const shared = path.resolve(__dirname, '../app')

config.watchFolders = [shared]
const resolve = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, name, platform) => {
  const next = resolve ?? context.resolveRequest
  if (name.startsWith('~/')) return next(context, path.join(shared, name.slice(2)), platform)
  return next(context, name, platform)
}

module.exports = config
