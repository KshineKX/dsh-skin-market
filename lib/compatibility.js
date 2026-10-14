import { satisfiesVersionRange } from './semver.js';
const KEYED_SLOT_CAPABILITY_PREFIX = 'slot:keyed:';
// Keep this browser-safe module independent from the host runtime detector.
const LEGACY_KEYED_SETTINGS_RANGE = '>=0.1.0-rc.7 <0.1.6-alpha.2';
/** Bind a one-operation acknowledgement to the package and runtime shown. */
export function compatibilityContext(skin, runtime) {
    const desktop = skin.install.desktop;
    return JSON.stringify([
        skin.id, skin.package, skin.install.version, skin.install.commit, skin.install.target,
        skin.install.npm?.integrity ?? null,
        desktop?.mode === 'managed' ? [desktop.packageName, desktop.packageVersion, desktop.integrity ?? null] : null,
        skin.compatibility.dsh, runtime?.version ?? null,
    ]);
}
function declaredAdapters(skin) {
    return skin.compatibility.adapters ?? [];
}
function sameAdapter(left, right) {
    return left.kind === right.kind
        && left.when === right.when
        && left.slot === right.slot
        && left.key === right.key;
}
export function applicableAdapters(skin, runtime, _legacyIncludeBuiltIns) {
    // Keep the optional argument for existing callers, but never invent source
    // migrations or expand the author's supported versions. Only a reviewed,
    // explicitly declared rule may run within that range.
    if (runtime.version === null || skin.compatibility.dsh === 'unverified' || !satisfiesVersionRange(runtime.version, skin.compatibility.dsh))
        return [];
    const declared = declaredAdapters(skin);
    const uniqueAdapters = declared.filter((adapter, index, all) => all.findIndex(item => sameAdapter(item, adapter)) === index);
    return uniqueAdapters.filter(adapter => satisfiesVersionRange(runtime.version, adapter.when)
        && (adapter.slot !== 'settings.plugin.item' || satisfiesVersionRange(runtime.version, LEGACY_KEYED_SETTINGS_RANGE))
        && runtime.capabilities.includes(`${KEYED_SLOT_CAPABILITY_PREFIX}${adapter.slot}`));
}
export function assessCompatibility(skin, runtime) {
    if (runtime.version === null)
        return {
            decision: 'unknown',
            reason: '无法确认当前 DSH 版本，兼容性需要实际验证',
            adapterIds: [],
        };
    const declared = applicableAdapters(skin, runtime, false);
    if (skin.compatibility.dsh === 'unverified')
        return {
            decision: 'unknown',
            reason: `皮肤未声明 DSH 兼容范围（当前 ${runtime.version}）`,
            adapterIds: declared.map(adapter => adapter.id),
        };
    if (declared.length > 0)
        return {
            decision: 'adaptable',
            reason: `当前 DSH ${runtime.version} 命中可选兼容适配器，安装时仍需验证源码是否可安全适配`,
            adapterIds: declared.map(adapter => adapter.id),
        };
    if (satisfiesVersionRange(runtime.version, skin.compatibility.dsh))
        return {
            decision: 'compatible',
            reason: `当前 DSH ${runtime.version} 在声明范围 ${skin.compatibility.dsh} 内`,
            adapterIds: [],
        };
    return {
        decision: 'incompatible',
        reason: `当前 DSH ${runtime.version} 不在作者声明的兼容范围 ${skin.compatibility.dsh} 内，尚未确认此版本能否正常运行该皮肤`,
        adapterIds: [],
    };
}
