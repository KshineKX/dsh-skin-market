import { desktopInstallPlan } from '../desktop-install.ts'
import { createInstallCommand, type InstallCommandContext } from '../install-command.ts'
import { effectiveBuildApprovalKey } from '../build-approval.ts'
import { preferredInstallTarget } from '../install-source.ts'

export const REGISTRY_REPOSITORY = 'https://github.com/kingOfSoySauce/dsh-skin-market'
export const REGISTRY_PATH = 'registry/skins'
export const CLI_INSTALL_WARNING = '安装皮肤前请先检查其他已启用的皮肤，避免全局样式冲突；可复制提示词，让 Agent 检查并指导操作。'

export function normalizeGitHubRepository(value: string): string | null {
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return null
    const parts = url.pathname.replace(/\.git$/, '').split('/').filter(Boolean)
    if (parts.length !== 2) return null
    return `https://github.com/${parts[0]}/${parts[1]}`
  } catch {
    return null
  }
}

export function createSubmissionPrompt(repositoryInput?: string): string {
  const repository = repositoryInput === undefined ? null : normalizeGitHubRepository(repositoryInput)
  if (repositoryInput !== undefined && repository === null) return ''
  const repositoryLine = repository === null
    ? '皮肤仓库：如果当前工作区就是待提交的皮肤仓库，请确认它的公开 GitHub remote；否则先向我索要公开 GitHub 仓库地址。'
    : `皮肤仓库：${repository}`

  return `请把我的 DSH 皮肤提交到 DSH Skin Market。

${repositoryLine}
目标目录仓库：${REGISTRY_REPOSITORY}
目录路径：${REGISTRY_PATH}

请自主完成以下工作：
1. 只用只读方式确认皮肤仓库是公开的 GitHub 仓库（或 monorepo 子目录），且确实是可安装的 DSH Web 皮肤。不要读取 .env、凭据或聊天记录。
2. fork/clone 目标目录仓库并新建分支。在 ${REGISTRY_PATH} 下只新增一个 YAML，文件名用 owner__repo.yml（子包用 owner__repo--path.yml）。不要覆盖已有条目，不要修改 data/catalog.json。
3. YAML 必须写成薄条目。只允许这些字段，一个都不能多：url、subpath、name、author、description、screenshots。多写 package、rowId、category、tags、modes、compatibility、install、commit 或任何其他键，CI 会按完整 schema 校验并失败。CI 会从皮肤仓库读取 package、loader id、许可证、commit 和预览图。内容只能是：

url: https://github.com/<owner>/<repo>
# subpath: packages/my-skin   # 仅 monorepo 子包需要
# name:                       # 可选
#   zh: 中文名
#   en: English name
# author: owner               # 可选；缺省用 GitHub owner
# description: 一句中文或英文描述  # 可选；缺省则用 package.json description

4. 预览图优先放在皮肤仓库自己的 screenshots.json（相对路径），或 README 里的仓库内图片。不要把 SVG、data URI、第三方图床写进市场 YAML。
5. 不要写完整 schema，不要编造 commit SHA、rowId 或许可证。若 npm run registry:check 报缺少 id/install，先删掉薄条目以外的字段再跑，不要靠补全 schema 过 CI。
6. 在目标目录仓库根目录运行 npm run registry:check。不得安装到我的真实 DSH profile。
7. git diff --name-only 应只有 ${REGISTRY_PATH}/<条目文件>.yml。提交并向 ${REGISTRY_REPOSITORY} 创建 PR，标题 feat(registry): add <皮肤名>。
8. 返回 PR 链接；没有 GitHub 权限时只准备好分支和可复制的 PR 内容。

收录不等于安全认证。不要声称该皮肤已被 DSH 官方、安全团队或市场背书。`
}

export function createSkinInstallPrompt(skin: CatalogSkin, hostKind?: MarketHostKind): string {
  const target = preferredInstallTarget(skin)
  const buildApprovalKey = skin.install.npm === undefined ? effectiveBuildApprovalKey(skin) : undefined
  const buildApproval = buildApprovalKey === undefined
    ? ''
    : `\n- 这个固定版本包含 prepare 构建脚本。只允许精确构件键 \`${buildApprovalKey}\`：在 Web profile 的 pnpm-workspace.yaml 里合并 \`allowBuilds:\n    '${buildApprovalKey}': true\`，不得开启 dangerouslyAllowAllBuilds。`
  const companions = skin.install.companions ?? []
  const companionLines = companions.length === 0
    ? ''
    : `\n${companions.map(companion => `- 伴生包：${companion.package}（rowId ${companion.rowId}）\n- 伴生安装目标：${companion.target}`).join('\n')}`
  const targets = [...new Set([target, ...companions.map(companion => companion.target)])]
  const command = targets.map(target => createInstallCommand(target)).join('\n')
  const packages = [skin.package, ...companions.map(companion => companion.package)].join('、')
  const rowIds = [skin.rowId ?? skin.package, ...companions.map(companion => companion.rowId)].join('、')
  const metadata = `- 仓库：${skin.repo}\n- 固定安装目标：${target}\n- package：${skin.package}\n- loader rowId：${skin.rowId ?? skin.package}${companionLines}\n- 版本：${skin.install.version}\n- commit：${skin.install.commit}`
  const compatibility = skin.review?.compatibility !== 'unverified' ? '' : '\n维护者尚未声明可验证的 DSH 兼容范围。先只读检查仓库，核对当前宿主版本和安装方式；先告诉我结论和风险，等待我确认后再安装，不要直接安装。\n'
  const conflictCheck = `必须先完成只读冲突检查：从当前宿主的插件清单和实际启用状态识别其他皮肤、主题或外观插件，不能把“已安装”直接当成“已启用”。排除 @deepseek-ai/dsh-base、@deepseek-ai/dsh-web-app、dsh-skin-market 和本次目标 package ${packages}。可只读核对 package.json 的名称、描述、dsh.client/dsh.bundle 声明及仓库 README。不要读取 .env、凭据、聊天记录或其他存放秘密的配置。发现可能冲突的已启用皮肤时，列出名称和依据并停在安装前，指导我通过当前宿主插件页停用；未经我确认不得修改任何 profile 文件，也不得执行安装。无法读取启用状态时，先请我提供插件页中的状态，不要声称没有冲突。确认没有其他已启用皮肤后，才说“未检测到其他已启用的皮肤插件”。`
  const desktopManual = desktopInstallPlan(skin, true).kind === 'manual'
  const desktopSteps = desktopManual
    ? `这款皮肤需要在桌面应用的官方插件面板确认安装。先只读查看仓库维护者的安装说明，确认固定安装目标及子目录（如有）可用于当前 Desktop；无法确认时说明缺少什么，不要猜测安装方式。\n${conflictCheck}\n确认可以继续后，指导我在皮肤详情点击「安装」，由市场打开官方面板并填好固定目标；入口不可用时再指导我打开桌面应用「插件 → 添加插件」。按顺序核对以下完整固定安装目标（含伴生包），由我点击安装、处理应用提示并启用：\n${targets.map(target => `- ${target}`).join('\n')}\nGitHub 目标必须保留完整 commit 和 &path: 子目录，不要改成包名、main、HEAD 或最新版本。遇到构建授权，仅指导我在应用界面确认本次目标需要的精确构建项；界面不支持或安装失败时，收集完整错误并说明卡在哪一步，不要绕过限制。`
    : `${conflictCheck}\n确认可以继续后，指导我在「设置 → 皮肤市场」打开这款皮肤，由我点击一键安装并按应用提示使用。`
  const desktop = `官方 Desktop：你负责只读检查和指导，我负责点击安装、启用、停用和重启；不要代替我操作。以应用“关于”中的版本为准，不用系统终端的 npm dsh 版本代表桌面版本。不要执行 dsh plugin --profile desktop，不要用 npm/pnpm 写入 Desktop profile，也不要修改其 package.json、cordis.patch.yml 或构建权限。\n${desktopSteps}\n每次只给我一个具体操作，等我反馈后再给下一步；不要只丢给我仓库说明。安装后只读核对当前宿主的插件安装结果、版本和启用状态；读不到时请我提供插件页状态，未核实不能宣称安装成功。按应用提示指导我重启；需要时完全退出后重新打开（macOS 使用 ⌘Q，关闭窗口不算退出），然后确认皮肤已生效。`
  const web = `Web 版：\n${conflictCheck}\n安装前只读确认实际 Web profile 的 package.json 中 dependencies 与 dsh.profile.bundles，以及当前插件启用状态；不要把 Desktop profile 当作 Web profile。\n没有冲突且兼容性确认完成后，先处理目标所需的精确构建授权，再执行下面的全部固定安装命令（含伴生包），不要改成 main、HEAD 或最新版本：${buildApproval}\n${command}\n如果目标只有 dsh.client，幂等地确认 package ${packages} 和 rowId ${rowIds} 已注册到 Web profile 的 cordis.patch.yml；不要放宽其他包的构建权限。安装后验证同一 profile 的 dependencies、dsh.profile.bundles、目标 package 的 dsh.client/dsh.bundle 声明及 loader 注册项；缺失则报告失败。告诉我如何重启当前 Web 宿主。`
  const workflow = hostKind === 'desktop' ? desktop : hostKind === 'dsh' ? web : `先判断当前是 Web 版还是官方 Desktop，并核对实际 profile；无法判断就先问我。Web 查看 dsh --version；Desktop 查看应用“关于”中的版本。只执行对应宿主的流程。\n\n${desktop}\n\n${web}`
  return `请帮我安装这个固定版本的 DSH 皮肤。${hostKind === 'desktop' ? '你负责检查和逐步指导，由我在桌面应用中操作。' : ''}\n\n${metadata}\n${compatibility}\n${workflow}\n\n不要替我安装、停用或卸载其他皮肤。`
}

export interface InstallCopyEntry { key: string; label: string; value: string }
export interface InstallCommandGroup { key: string; label: string; commands: InstallCopyEntry[] }

/** List the primary command for each applicable terminal. */
export function createSkinInstallCommandGroups(skin: CatalogSkin, context: InstallCommandContext = {}, target = preferredInstallTarget(skin)): InstallCommandGroup[] {
  const terminalSpecific = target.includes('&')
  const shells = context.shell !== undefined ? [context.shell] : terminalSpecific ? ['posix', 'powershell', 'cmd'] as const : ['posix'] as const
  const labels = { posix: 'macOS / Linux', powershell: 'Windows PowerShell', cmd: 'Windows CMD' }
  try {
    return shells.map(shell => ({
      key: shell, label: terminalSpecific ? labels[shell] : '',
      commands: [{ key: 'command', label: '命令', value: createInstallCommand(target, 'web', { shell }) }],
    }))
  } catch { return [] }
}

export function createSkinInstallCommand(skin: CatalogSkin): string {
  const targets = [preferredInstallTarget(skin), ...(skin.install.companions ?? []).map(companion => companion.target)]
  return [
    '# Web 版',
    [...new Set(targets)].map(target => createInstallCommand(target)).join('\n'),
    '',
    '# 官方桌面版：不要在终端执行；在「设置 → 皮肤市场」中打开该皮肤并安装',
  ].join('\n')
}

/**
 * The exact spec users can paste into the official Desktop plugin page.
 *
 * Desktop accepts both npm and Git specs. A manual-only monorepo entry often
 * has no published npm package, so its package name would just fail the same
 * lookup that caused the manual fallback in the first place.
 */
export function createSkinInstallSearchKeyword(skin: CatalogSkin): string {
  return preferredInstallTarget(skin)
}
import type { CatalogSkin, MarketHostKind } from './types.ts'
