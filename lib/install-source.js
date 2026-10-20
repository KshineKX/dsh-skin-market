export function npmInstallTarget(skin) {
    const npm = skin.install.npm;
    return npm === undefined ? null : `${npm.name}@${npm.version}`;
}
export function preferredInstallTarget(skin) {
    return npmInstallTarget(skin) ?? skin.install.target;
}
/** Manual copy fields follow the npm default tag; managed operations stay pinned. */
export function manualInstallTarget(skin) {
    return skin.install.npm?.name ?? unversionedNpmTarget(skin.install.target);
}
export function unversionedNpmTarget(target) {
    const match = /^((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)(?:@[^/]+)?$/i.exec(target);
    return match?.[1] ?? target;
}
