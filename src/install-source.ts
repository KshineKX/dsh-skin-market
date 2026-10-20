/** Shared by the host, embedded market, and public site. Keep browser-safe. */
export interface InstallSourceSkin {
  install: { target: string; npm?: { name: string; version: string } }
}

export function npmInstallTarget(skin: InstallSourceSkin): string | null {
  const npm = skin.install.npm
  return npm === undefined ? null : `${npm.name}@${npm.version}`
}

export function preferredInstallTarget(skin: InstallSourceSkin): string {
  return npmInstallTarget(skin) ?? skin.install.target
}

/** Manual copy fields follow the npm default tag; managed operations stay pinned. */
export function manualInstallTarget(skin: InstallSourceSkin): string {
  return skin.install.npm?.name ?? unversionedNpmTarget(skin.install.target)
}

export function unversionedNpmTarget(target: string): string {
  const match = /^((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)(?:@[^/]+)?$/i.exec(target)
  return match?.[1] ?? target
}
