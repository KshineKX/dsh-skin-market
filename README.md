# DSH 皮肤市场

一个嵌入 DSH 设置页的皮肤市场，可以浏览、安装、使用、停用、更新和卸载社区皮肤。
<p align="center">
  <img src="./docs/assets/skin-market-liang.png" alt="DSH 设置中的皮肤市场发现页" width="70%">
</p>

<p align="center">
  <img src="./docs/assets/skin-market-deep-whale.png" alt="DSH 皮肤市场中的 Deep Whale 皮肤详情弹窗" width="70%">
</p>

### 在线预览

[点击查看在线皮肤市场](https://kingofsoysauce.github.io/dsh-skin-market/)

### 近期收录

- **2026-09-10 至 2026-10-05**：新增 **7 条**，包括终末地主题（改版）、千夏 · 绝区零外观主题、鲸鱼娘动态壁纸等。详见[收录日志](./docs/recently-added.md#recent-since-2026-09-10)。

## 安装

### 安装方式

> 安装皮肤市场本身不要求停用现有皮肤；安装或切换具体皮肤前再检查冲突。

#### Web 版（命令行）

```sh
dsh plugin --profile web add "dsh-skin-market@latest"
```

#### 官方 Desktop

APP 左上角「插件 → 添加插件」中输入 `dsh-skin-market@latest` 安装并按应用提示启用；如果提示需要重启，请完全退出 Desktop App 并重新打开。

使用“关于 DeepSeek Harness”中的应用版本判断 Desktop 兼容性。系统终端里的 `dsh --version` 可能来自另一份 npm 安装，不能代表当前桌面应用。

### 宿主与管理接口兼容性

以下按 **2026-10-15 已核验的官方源码 tag**说明功能边界；自动化检查与 Web、原生 Desktop 的实机验收分别记录，源码支持不等于所有平台已完成实测。

| 官方 DSH 版本 | 市场可用的管理能力 | 额外接口边界 |
| --- | --- | --- |
| `0.1.5-alpha.1`～`0.1.5-rc.3`、`0.1.6-alpha.1` | 旧桌面壳的插件 IPC 属于其自有窗口；市场不接入这套私有接口 | 启动/恢复页的内部 restart 不提供给第三方插件 |
| `0.1.6-alpha.2` | 安装、更新、使用、停用、卸载与精确构建项授权，通过共享 `pluginManager` | 安装后保存使用选择，提示手动重启以加载新包；安装结果恢复、registry、`saveExact` 尚不可用 |
| `0.1.7-alpha.1`、`0.1.7-alpha.2`、`0.1.7-rc.1`、`0.1.7-rc.2` | 上述管理能力；增加安装结果恢复与 registry 选项 | 安装后保存使用选择，提示手动重启以加载新包；支持按序读取多个 bundle patch，`saveExact` 尚不可用 |
| `0.2.0-rc.1`、`0.2.0-rc.2` | 延续共享插件管理能力 | 安装后保存使用选择，提示手动重启以加载新包；`0.2.0-rc.2` 起 Desktop 自带命令支持应用退出后的离线插件维护 |
| `0.2.1-alpha.1` | 上述能力，官方管理器增加安装后的运行时包解析刷新 | 按实际管理结果判断是否仍需重启；`saveExact` 尚不可用 |
| `0.2.1-alpha.2` | 上述能力，并支持 `saveExact` | 市场可请求精确保存依赖版本 |
| `0.2.1-alpha.3` | 延续上述能力；官方修复更新/重装后的旧代码加载，并返回 `restartReason` | 可热重载的修改直接应用；其他修改保存选择后提示手动重启 |

市场同时检查实际服务的方法是否存在。官方版本无法识别、尚未核验或缺少方法时，相应按钮会说明原因；不会猜测接口可用，也不会改走另一个 profile。

`0.2.1-alpha.3` 当前已完成官方源码核对和自动化测试；原生 Desktop 实测待官方桌面安装包发布后补验。

已核验的旧版官方 Desktop 同样支持先保存启停选择。市场不会因为版本早于 `0.2.1-alpha.1` 就跳过切换：安装验证成功后继续调用官方管理接口，保存旧普通皮肤停用、目标皮肤启用的配置。较旧宿主加载新包可能仍需重启；这不等于启用配置不能保存。

官方 Desktop 点击「安装」即默认一键使用：市场安装并验证目标皮肤，自动停用目录中原先的普通皮肤、启用目标，保留常驻皮肤与无关插件。需要重启时，在切换选择保存后弹出「请手动重启 Desktop App」，完全退出并重新打开即可加载目标皮肤，无需再手动关闭旧皮肤或开启新皮肤；关闭弹窗后仍可通过横幅查看提示。macOS 使用 `⌘Q`，仅关闭窗口不算退出。更新已安装皮肤保留原有启用和常驻选择；真正的启用失败会显示原因并恢复旧选择。

表中的离线维护仅由 Desktop 自带命令提供，须先初始化 Desktop profile 并完全退出应用；npm 安装的 dsh 不能修改 Desktop profile。

<details>
<summary><strong>点击展开 API、结果与来源校验说明</strong></summary>

官方 Desktop 使用 Host 的 `ctx.pluginManager`：安装和更新调用 `installBundle(spec, options)`，组合包启停调用 `setBundleEnabled(name, enabled)`，单个条目启停调用 `setPluginEnabled(entryId, enabled)`，卸载调用 `removeBundle(name)`。安装有独立 `requestId`，取消走 `cancelInstall(requestId)`；支持结果恢复的版本可通过 `waitForInstall(requestId)`核对已有操作，不重新发起安装。安装日志和状态由 `plugin-manager/install-log`、`plugin-manager/install-state` 事件提供。

结果中的 `application` 决定管理事务状态：`applied` 表示本次管理修改已应用，安装事务的这个结果不证明插件代码已加载；市场继续核对启用结果和实际状态。`restart-required` 表示修改已保存、仍需重启，`overridden` 表示修改保留但启用状态被其他配置覆盖，`failed`/`cancelled` 分别表示失败/已确认取消。`0.2.1-alpha.3` 的 `restartReason` 区分未开启热重载、包位置变化、宿主模块、非 Loader 管理的插件或无法比较模块；这些结果不等于启用接口不可用。允许继续启用的宿主可先完成停旧、启目标，安装或切换任一步要求的重启会一直保留到应用重启。取消请求到达太晚时，以管理器最终结果为准。结果无法确认时，市场保留“等待宿主确认”，阻止重复写入并提示重新启动应用后核验。

较旧服务可能把 `1.2.3` 保存成 `^1.2.3`。市场会核对实际包版本、锁文件 importer 的 specifier/解析版本以及目录记录的 SRI；可验证的范围写法不会绕过完整性检查，也不会被直接声称为精确固定版本。缺少 SRI 的旧 Desktop 元数据只提供包名、版本与入口检查，不代表通过了哈希校验。

所有上述已核验官方 Desktop 版本都未提供供第三方调用的通用 App 退出或重启接口。只有确实需要重启时，市场提示「请手动重启 Desktop App」，用户完全退出并重新打开。`dshDesktop.updates.open()`打开桌面更新确认流程，不是通用重启 App API。市场不调用 Electron 私有 IPC 或从运行中的 Desktop 执行 `dsh plugin --profile desktop`。

第三方桌面壳提供的 `desktopProfiles`/`desktopPnpm` 与官方 `pluginManager` 分开适配。市场使用各自宿主提供的当前 profile 和安装服务；不会自动迁移第三方壳的配置、依赖、启用状态或 profile。

依据：[官方 `0.1.6-alpha.2` 发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.6-alpha.2)、[官方 `0.2.0-rc.2` Desktop 命令说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/apps/desktop/README.md#bundled-command-runtime)、[`0.2.1-alpha.3` 管理结果](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.3/packages/boot/plugin-manager/src/types.ts)、[`0.2.1-alpha.3` 启停与安装实现](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.3/packages/boot/plugin-manager/src/index.ts#L492)、[Desktop 产品接口](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.3/apps/desktop/src/ipc.ts#L72)。

</details>

#### 提示词安装
<details>
<summary><strong>点击展开安装提示词</strong></summary>

复制以下给 DSH Agent；Web 可由 Agent 执行安装，官方 Desktop 由 Agent 逐步指导你操作。

```text
请帮我安装 dsh-skin-market。先只读确认当前是 Web 版还是官方 Desktop，以及当前宿主和实际 profile。Web 查看 dsh --version；官方 Desktop 以应用“关于”中的版本为准，不把系统终端的 npm dsh 版本当作桌面版本。无法读取应用信息时，请让我提供该版本；无法判断宿主就先问我。

- Web 版：执行 dsh plugin --profile web add "dsh-skin-market@latest"，然后核对同一 web profile 中的依赖和 bundle。
- 官方 Desktop：你负责只读核查和操作指导，安装、启用及重启由我在应用界面完成。不要代我点击安装或启用，不要执行 dsh plugin --profile desktop、pnpm 或其他安装命令，也不要修改 Desktop profile。每次只给下一项操作，等我反馈后继续：打开「插件 → 添加插件」，输入 dsh-skin-market@latest，确认安装结果，再按应用提示启用；需要重启时指导我完全退出并重新打开应用。

这次只安装皮肤市场，不做其他皮肤的冲突检查，也不要求停用它们。不要替我安装其他皮肤。安装后告诉我从哪里打开「皮肤市场」；Desktop 以插件页状态和我的实际操作反馈核对结果，没有核实就不要声称安装或启用成功。不要读取 .env、凭据或聊天记录。
```

</details>

#### 官方 Desktop 安装具体皮肤

支持一键安装的 npm 皮肤，在官方 Desktop 市场中点击「安装」就会自动安装并切换使用，需要重启时弹窗提醒；Web 市场的对应主按钮为「安装并使用」，详情页另有「仅安装」。标为「需手动安装」的 GitHub 或子目录皮肤，可以复制安装面板中的提示词，让 Agent 检查冲突、核对目标并指导你在插件页安装。

<details>
<summary><strong>点击展开手动皮肤安装流程</strong></summary>

Agent 先只读确认当前 Desktop 版本和其他已启用的皮肤；发现冲突时列出名称，指导你在应用中停用，并核对停用结果后再继续。拿不到启用状态时，应请你提供插件列表或界面状态，不能把“无法确认”当成“没有冲突”。

安装目标使用面板给出的完整固定 spec。GitHub 目标保留完整 commit；monorepo 子包还要保留 `&path:/子目录`，例如 `github:owner/repo#<完整 commit>&path:/packages/skin`。没有 npm 包时，不要把该目标换成包名、`latest` 或仓库主分支。

Agent 每次只指导一项操作，等你反馈后继续：打开「插件 → 添加插件」、粘贴完整目标、确认安装结果、按提示启用，最后按当前版本要求完全退出并重新打开应用。Agent 不代点安装或启用，不执行 Desktop 安装命令，也不修改 profile。界面不支持该目标或安装失败时，先核对原始报错和维护者说明，再决定下一步；依赖伴生包的皮肤须核对完整安装要求。

这些说明不改变市场的 npm 一键安装流程，也不代表所有 GitHub 或子目录皮肤已通过官方 Desktop 实机验收。

</details>

---

<a id="install-troubleshooting"></a>
### 安装失败时，可以让 DSH 自己排查

把完整原始报错粘贴给 DSH Agent；它会先区分 Web 和官方 Desktop，再按实际 profile 排查。

<details>
<summary><strong>点击展开排查说明与提示词</strong></summary>

> 皮肤市场的安装、更新和卸载会调用 DSH 的 profile 插件管理器；当前 DSH 使用 `pnpm` 管理 profile 依赖。如果出现 `pnpm is not recognized`、`package manifest missing` 或 `allowBuilds` 相关报错，不必手动猜测 profile 状态。
>
> 含子目录路径的 GitHub 目标（`github:…#commit&path:/…`）请优先用市场页一键安装。市场安装结束后会校验 `node_modules` 中的包名是否与目录一致，避免 `&path:` 被截断时误把仓库根包装成成功。Windows 上不要把这段 spec 交给 `dsh plugin add`：cmd.exe 会在 `&` 处截断。下面的手动命令仅适用于 Web profile；官方 Desktop 请使用桌面插件管理器：
>
> ```powershell
> pnpm add "github:owner/repo#<commit>&path:/subdir" --dir $env:USERPROFILE\.dsh\profiles\web
> ```
>
> 如果报错含 `ERR_PNPM_UNEXPECTED_STORE`，是 profile 的 `node_modules` 与当前 pnpm store 代际不一致（常见于本机同时装了 pnpm 10 / store v10 和 pnpm 11 / store v11）。在 **profile 目录内** 查看 `node_modules/.modules.yaml` 的 `packageManager` 和 `storeDir`，再对比同一目录下的 `pnpm --version` 与 `pnpm store path`；不要用 DSH 源码仓库目录里的结果来判断。用 `.modules.yaml` 记录的同一版 pnpm 重试，或用当前 pnpm 重建该 profile 的 `node_modules`。Windows 上 `dsh plugin add` 走 PATH 上的 pnpm，不会因为源码仓库写了 `"packageManager": "pnpm@11"` 就自动切换。

把完整原始报错填入后复制给你的 DSH Agent。它会先判断当前是 Web 还是官方 Desktop；无法判断时先询问你：

```text
请帮我排查 DSH 皮肤市场的安装或启用失败。先判断当前宿主与实际 profile：Web 查看 dsh --version；官方 Desktop 查看应用“关于”中的版本，不用系统终端的 npm dsh 版本替代。无法判断就先问我。下面是完整原始报错：

<把完整报错粘贴到这里>

如果是官方 Desktop：只读检查桌面应用插件管理器中的 dsh-skin-market 状态和完整原始错误；不要执行 dsh plugin --profile desktop，也不要手动修改 profile。若错误是 same-origin request required，请报告该错误并停止，不要猜测或重写 profile。

如果是 Web 版，请严格按以下 3 步处理，并报告每一步的结果：

1. 确认当前使用的 profile 名称和实际目录，并检查 DSH 进程自身是否能找到 pnpm（Windows 同时检查 pnpm.cmd）。如果 pnpm 不在 PATH，先说明如何安装或修复 pnpm，并停止把问题误判为 allowBuilds 配置问题。如果报错含 ERR_PNPM_UNEXPECTED_STORE，再比较 profile 的 node_modules/.modules.yaml（packageManager、storeDir）与「在 profile 目录内」执行的 pnpm --version / pnpm store path；不要用 DSH 源码仓库目录里的 pnpm 版本来判断。用同一版 pnpm 重试，或用当前 pnpm 重建该 profile 的 node_modules。
2. 只有确认 pnpm 可用且 store 一致后，才检查 profile 的 pnpm-workspace.yaml。若 pnpm 输出了构建审批 key，只把报错中完整、精确的 key 合并到 allowBuilds，对应值设为 true；不要启用 dangerouslyAllowAllBuilds，也不要放宽其他包。不要读取 .env、凭据或聊天记录。
3. 重新执行原来的皮肤安装命令。完成后验证 profile package.json 依赖、node_modules 中目标包的 package.json、dsh.client/dsh.bundle 声明和 loader 注册项；如果仍失败，请指出具体失败阶段和完整错误，不要把 package manifest missing 当作根因。
```

</details>

### 安装来源与长时间等待

Web 市场优先使用目录中已经核验的 npm 精确版本；没有合格 npm 来源时，继续使用 GitHub 固定 commit。遇到长时间等待时，请提供皮肤名、DSH/市场版本、操作系统及市场横幅中的“复制日志”。

<details>
<summary><strong>点击展开安装来源校验与等待机制</strong></summary>

npm 来源须与目录的包名、版本、仓库、完整 commit 一致，并通过安装包完整性与已构建客户端入口检查。已有的 GitHub 安装仍然有效，不会仅因目录补充 npm 来源而要求重装。

安装横幅默认显示当前状态、皮肤名和耗时，下载时保留下载量；展开“详情”可查看具体步骤、尝试次数、pnpm 阶段和连续 30 秒无输出的提示，也可复制诊断日志。Web 安装和更新的准备、下载、重试共用 15 分钟预算，达到时限后结束当前任务；已修改 profile 的失败操作只做一次、独立限时 60 秒的依赖恢复，并核对更新前的实际版本和声明入口。恢复未完成或入口仍缺失时会明确提示。官方 Desktop 的安装事务与失败恢复由宿主插件管理器处理，市场不会额外改写它的 profile 文件。

宿主启停操作超过 10 秒仍未结束时，市场进入“等待宿主确认”并暂停新的 profile 写入；这不表示原操作已经取消。迟到的成功或失败仍会被处理、核对，结束前不会重复启停同一个 loader。读取目录和状态不受这次隔离影响。

锁文件与 manifest 不一致、锁文件缺少依赖条目、安装脚本长期无输出是不同错误，市场分别提示，不把它们都当网络错误自动重试。请保留诊断并先备份再修复，不要删除整个锁文件重新解析其他插件。

浏览器能够访问 GitHub，不能单独证明实际运行 DSH 的进程和 pnpm 已使用相同代理；也可能卡在依赖解析或构建阶段。

</details>

<a id="manual-update"></a>
## 更新本插件

### 方式一：页面更新（推荐）

在「设置 → 皮肤市场」标题右侧点击“更新”，完成后按界面提示重启 DSH Web 或官方 Desktop。

### 方式二：命令更新

#### Web 版

```bash
dsh plugin --profile web add "dsh-skin-market@latest"
```

#### 官方 Desktop

在桌面应用「插件 → 添加插件」中输入 `dsh-skin-market@latest`

> 完成后按界面提示重启对应宿主。

### 方式三：提示词更新
<details>
<summary><strong>点击展开提示词</strong></summary>

复制以下内容给 DSH Agent；它会先判断宿主，再选择更新方式：

```text
请更新已安装的 dsh-skin-market。先判断当前宿主和实际 profile：Web 查看 dsh --version；官方 Desktop 查看应用“关于”中的版本，不用系统终端的 npm dsh 版本替代。无法判断就先问我。

- Web 版：只读确认 web profile 已安装 dsh-skin-market，再执行 dsh plugin --profile web add "dsh-skin-market@latest"。
- 官方 Desktop：只读核对版本和插件状态，逐步指导我在桌面应用「插件 → 添加插件」中输入 dsh-skin-market@latest、确认更新结果并按提示启用；每次只给下一项操作，等我反馈后继续。安装、启用及重启由我在应用界面完成，不要代操作、执行 Desktop 安装命令或修改 profile。

Web 更新后验证同一宿主的 dsh-skin-market 依赖和 bundle；Desktop 根据插件页状态和我的实际反馈核对结果，没有核实就不要声称成功。告诉我更新前后版本及需要重启哪个宿主。不要替我更新或卸载其他皮肤。
```

</details>

## 收录你的皮肤

如果你开发了 DSH 皮肤，准备一个公开 GitHub 仓库后，向本仓库提 **一个** `registry/skins/<owner>__<repo>.yml` 即可。YAML 只允许 `url`、`subpath`、`name`、`author`、`description`、`screenshots`；不要写 `package`、`rowId`、`install` 等字段。CI 会补全 package、commit、loader id 和预览图：

```yaml
url: https://github.com/<owner>/<repo>
```

monorepo 子包加上 `subpath:`。也可以继续让 Agent 代为开 PR，复制下面提示词并把 `<你的皮肤仓库地址>` 换成真实地址。

这不是终端命令，而是交给 Agent 的任务说明：

<details>
<summary><strong>点击展开提示词</strong></summary>

复制以下整段提示词给你的 Agent：

```text
请把我的 DSH 皮肤提交到 DSH 皮肤市场。

皮肤仓库：<你的皮肤仓库地址>
目标目录仓库：https://github.com/kingOfSoySauce/dsh-skin-market
目录路径：registry/skins

请自主完成以下工作：
1. 只用只读方式确认皮肤仓库是公开的 GitHub 仓库（或 monorepo 子目录），且确实是可安装的 DSH Web 皮肤。不要读取 .env、凭据或聊天记录。
2. fork 或 clone 目标目录仓库并新建分支。在 registry/skins 下只新增一个 YAML，不要覆盖已有条目，不要修改 data/catalog.json。
3. YAML 必须写成薄条目。只允许 url、subpath、name、author、description、screenshots。多写 package、rowId、category、tags、modes、compatibility、install 等字段会失败；CI 会从皮肤仓库补全其余字段：

url: https://github.com/<owner>/<repo>
# subpath: packages/my-skin   # 仅 monorepo 子包需要

4. 预览图放在皮肤仓库的 screenshots.json 或 README 内；不要使用 SVG、data URI 或第三方图床。
5. 不要写完整 schema。若 registry:check 报缺少 id/install，删掉多余字段再跑，不要补全 schema。
6. 在目标目录仓库根目录运行 npm run registry:check。不得安装到我的真实 DSH profile。
7. git diff --name-only 应只有 registry/skins/<条目文件>.yml。提交并向目标目录仓库创建 PR，标题 feat(registry): add <皮肤名>。
8. 返回 PR 链接；没有 GitHub 权限时只准备好分支和可复制的 PR 内容。

收录不等于安全认证。不要声称该皮肤已被 DSH 官方、安全团队或市场背书。
```

</details>

皮肤市场里的「提交皮肤」也可以根据仓库地址生成这段提示词。

`registry/skins/` 是社区提交的唯一事实来源，每个皮肤一个 YAML 文件。`data/catalog.json` 是生成文件，不需要在社区 PR 中维护；PR 合并到 `main` 后会由仓库自动重生成。这样新增皮肤之间不会因为共同编辑一个目录文件而反复冲突。

## 收录要求

皮肤市场同时支持带 `dsh.bundle` 的完整插件和只有 `dsh.client` 的纯前端皮肤。对于后者，市场会在安装后自动、幂等地写入该皮肤已审核的 `rowId` 和 package 注册项；卸载时一并移除。维护者不必为了进入市场而额外复制一份 `cordis.patch.yml`，但仍须在 package 或 README 中提供明确的 row ID 和 DSH 兼容范围。

- 必须是公开、可安装的 DSH Web 皮肤仓库或 monorepo 子包
- 安装来源必须固定到完整 40 位 commit SHA
- 必须提供明确的 package、row ID、许可证和兼容范围
- 预览图必须是仓库中的真实界面截图
- Topic、仓库名称和 Stars 只用于发现与排序，不代表安全审核或官方背书

## 仓库健康建议

市场在同步已收录仓库时会检查三项便于用户理解和安装的基础规范，并在皮肤详情页展示结果：

- README 是否展示仓库内、可固定到版本的真实界面截图
- README 或 package 元数据是否明确声明支持的 DSH Web 版本范围
- package 名称、`dsh.client` Web 声明、row ID 和已构建客户端入口是否满足市场的一键安装要求

检查结果用于给维护者提供改进建议，不代表安全认证。暂未满足某项规范时，页面会说明如何完善，而不会把仓库描述为“不可用”。

“兼容性待验证”和“市场能否安装”是两个独立维度：

- 兼容性表示维护者是否明确声明并验证了支持的 DSH Web 版本；缺少声明时会提示风险，但不会单独阻止市场安装。
- 当前 DSH 不在作者声明范围内时，安装、更新、使用或设为常驻前会提示风险，用户可以取消或确认继续。本次确认只允许尝试该操作，不会修改作者声明、自动改写皮肤源码或保存永久豁免；官方 DSH 对插件自身依赖的兼容检查仍由宿主执行。
- 市场安装表示目录是否具备固定安装目标、package、`dsh.client` Web 声明、row ID 和可解析的已构建客户端入口。符合这些条件时，市场会调用 DSH 的 `plugin add` 命令完成安装；不要求插件仓库自行实现名为 `add` 的命令。

## 兼容性验证

目录中的安装目标固定到收录时的完整 commit。下面是 **2026-08-17 的历史验证记录**，用于说明当时的版本组合，不代表当前所有第三方皮肤都已完成同等级别的验证。

<details>
<summary><strong>点击展开历史验证记录</strong></summary>

当时面向 DSH Web `0.1.0-rc.6`；npm 的 `latest` 与 `next` 均为 `0.1.0-rc.6`。本项目使用重新安装的该版本完成了以下验证：

- 皮肤市场 `0.1.15`：132 条目录校验、70 项自动化测试、类型检查、Host/Client 构建、站点构建和 package preflight 全部通过
- DSH Web 实机启动：市场 Host 路由、客户端设置入口、在线目录和 5 分钟静默更新正常加载
- Liang Intensity `0.1.4` 联合冒烟：8 项测试和客户端 bundle 构建通过，并可在同一 DSH Web profile 中保持 active

这组结果证明上述版本组合可以启动和运行。

</details>

## 在线目录更新

已安装的皮肤市场不需要升级插件才能看到新收录或更新后的皮肤：

- 打开市场时由 DSH Host 从 GitHub Pages 拉取最新 `catalog.json`
- 页面保持打开时每 5 分钟静默检查一次；窗口重新获得焦点时也会立即静默检查
- npm 上出现更高的市场插件版本时，标题右侧会显示下载按钮；悬停后显示“更新”，安装完成后提示重启生效
- 浏览器会用 IndexedDB 保留最近一次有效目录；再次打开时先展示缓存，再在后台校验在线目录
- 列表首批只渲染 20 个皮肤，接近底部时每次无感追加 20 个；搜索和排序仍覆盖完整目录
- 首次无缓存时显示结构化骨架屏，预览图延迟加载并保留固定尺寸，避免页面跳动
- 远程目录通过 schema、唯一 ID/package/rowId、GitHub 仓库地址和固定 commit 安装目标校验后，才会进入可安装生命周期
- 验证成功的目录会缓存到当前 profile；离线、超时或远程数据不合法时自动回退到缓存，再回退到插件内置目录
- 每日抓取任务在完整测试通过后直接部署在线目录，同时继续创建 registry PR 留下可审查记录



## 本地开发

需要 Node.js 22 或更高版本。

```bash
git clone https://github.com/kingOfSoySauce/dsh-skin-market.git
cd dsh-skin-market
npm install
npm run dev
```

`npm run dev` 只启动使用 Mock Host 数据的预览页面，不会修改任何 DSH profile。

### 本地目录调试

本地开发 DSH 皮肤时，市场默认仍会从 GitHub Pages 请求远程 `catalog.json`，因此刚写入本地 `registry/skins` 的条目可能被远程目录覆盖。启动 DSH Web 前设置下面的开发环境变量，市场会固定使用当前构建包内的 `data/catalog.json`，不发起远程目录请求：

```sh
DSH_SKIN_MARKET_LOCAL_CATALOG=1 dsh web
```

该开关只影响当前进程的目录读取；安装、激活、停用、更新和卸载仍然经过本地市场的完整生命周期。未设置时保持线上行为：优先读取远程目录，并在失败时回退到缓存和内置目录。

本地条目验证完成后，再删除该环境变量运行 DSH，确认远程目录行为没有被改变。

### 本地验证生成的 WebP

WebP 是独立的市场静态资源，catalog 中的 `media` 字段会让插件和在线页默认直接请求 GitHub Pages 上的 preview/full；没有对应 WebP 或请求失败时，继续使用原始 PNG/JPG。需要重新生成资源时，先安装 `cwebp`（macOS 可用 `brew install webp`），然后运行：

```bash
npm run registry
npm run media:build
```

本地调试默认也请求线上 WebP。只有需要关闭 WebP 对比原图时，才在地址后追加：

```text
?dsh-media=0
```

对应仓库图片更新后，媒体脚本会重新下载并更新同一内容键；图片资源先发布到 ops 和 public market，插件代码可以单独发布。

常用检查命令：

```bash
npm run registry
npm test
npm run typecheck
npm run build
# 先将 VERSION 替换为目标版本，例如 0.1.58
npm run release -- VERSION --dry-run
```

正式发布时将 `VERSION` 换成目标版本并去掉 `--dry-run`；脚本会依次校验工作区、同步版本、提交并创建 Git tag、发布 npm，再推送 `main` 和 tag。需要同时创建 GitHub Release 时追加 `--github-release`。

完整的本地安装和回滚验证步骤见 [TESTING.md](./TESTING.md)。

## 目录维护

目录继续使用原来的 `data/catalog.json` URL 和 `schemaVersion: 1`。registry YAML 的 `install.npm` 在生成时移到顶层 `npmSources[skinId]`，旧版市场忽略这个字段并继续使用 GitHub；新版验证包名、版本、仓库、commit/gitHead 和完整性信息后读取 npm 来源，Host 缓存也保存同一兼容格式。

新版 Web 市场首次安装优先使用已验证的 npm 包，没有匹配包时仍使用固定 commit 的 GitHub 源。普通“更新”保留已有安装来源；通过 GitHub 安装且与目录版本及 commit 一致的皮肤，会单独显示“换用 npm”，确认后换成同版本 npm 包并保留启用、常驻状态。正在使用的皮肤完成后提示重启；迁移失败走现有恢复流程。旧版本、分支、自定义本地源及手动安装条目不自动迁移。

公共仓库保留 registry Schema、目录生成和社区提交校验。候选发现、全量收录、实机截图补录和运营报告属于维护者内部流程，不随市场运行时发布；正式目录条目仍位于 `registry/skins/`，`data/catalog.json` 是生成文件。

市场截图会作为 `marketScreenshots` 与上游截图合并展示；公共构建只负责校验和合并，不包含截图采集或提升工具。

## 安全说明

- 浏览器只能提交 registry 中的 `skinId`，不能提交任意命令或安装地址
- Web 的目录、状态、日志与修改 API 使用宿主登录检查；POST 同时核对同源和宿主声明的可信地址。宿主没有登录接口时保留原有地址限制
- Web 重启只接受直接回环连接、拒绝代理转发，并检查正在进行的插件操作和 Agent 状态；官方 Desktop 使用手动应用重启
- Web 失败恢复使用操作前的快照并核验实际构件；官方 Desktop 保留管理器的权威结果，不把未知结果或配置恢复单独当作安装成功
- GitHub Stars 由定时收录任务写入带更新时间的目录快照，页面和 Host 都不在浏览时请求 GitHub API
- 市场不会代替开发者登录 GitHub，也不会静默创建 PR

## Web 页面异常时重置皮肤

如果皮肤冲突导致 DSH Web 页面无法操作，先停止当前 DSH Web 进程，再执行：

```bash
~/.dsh/profiles/web/node_modules/.bin/dsh-skin-market-reset --profile web
```

该命令会关闭皮肤市场管理的所有皮肤并恢复默认外观，但保留已经安装的皮肤包和皮肤市场。随后重新启动 DSH 即可。命令使用原子写入；任何一步失败都会恢复执行前的 profile 文件。

官方 Desktop 请在桌面应用的插件管理器或皮肤市场中停用冲突皮肤，不要执行上面的 Web profile 命令。

## License

[MIT](./LICENSE)
