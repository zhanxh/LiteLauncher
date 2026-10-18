# 00 生命周期：一次改动从开工到提交

> 这是主线。其他 Runbook 是这条主线上的外挂细节。

## 1. 接需求

先把意图归到一条路线（[../routing.yaml](../routing.yaml)）：

- 能定位到"改哪一层"（前端 / 宿主 / 插件 / 构建 / 发布），就去读对应 Runbook；
- 定位不到，先读代码再判断，不要凭印象直接改；
- 复合需求（"加个插件并接进指令系统"）按**主意图**先走，其余按顺序补。

## 2. 开工前检查

```powershell
npm run task:current      # 有没有在建的工作
git status --porcelain    # 工作区是否干净
```

- 有在途工作 → `npm run task:switch -- <stem>` 接续，不要另起一套；
- 没有 → 建档（见第 3 步）。

## 3. 建档

```powershell
# 按 docs/standards/basic/plan-workflow.md 的模板创建
#   docs/plans/YYYYMMDD_HHMMSS_<slug>.md
#   docs/tasks/YYYYMMDD_HHMMSS_<slug>.md
npm run task:auto -- docs/plans/<文件名>.md
```

计划里至少写清：目标、关键决策、分阶段步骤、验证方式、回滚方式。
分阶段的粒度标准：**每一阶段结束时，仓库都能构建**。

## 4. 判断要不要先做设计

命中 [方案设计工作流](../standards/basic/design-workflow.md) 的任一类别（新插件、新 crate、
契约/ABI、新指令、数据模型、发布链路、跨层重构）→ 先写 `docs/design/` 并等确认。

判据一句话：**这次改动会不会产生"以后别人必须遵守的新约定"？** 会 → 先设计。

## 5. 实施

- 小步走：一次只动一个关注点，改完立刻验证（`npm run check`），别攒到最后一起编译。
- 每完成一步，立刻勾选 `docs/tasks/` 里对应的条目（它是跨会话的工作记忆）。
- 中途追加需求：**先往计划/任务里加条目，再动手**。
- 等待长命令（`cargo build`、`build.cmd ship`）时，顺手把已完成项勾掉、把结论写进任务文档。

## 6. 验证

按 [验证矩阵](README.md#验证矩阵按改动类型) 选命令，并把**实际执行的命令与结论**写进任务文档。
只写"已验证"不算证据；写清跑了什么、结果是什么。

渲染/窗口/热键类改动必须真实启动确认：离屏或单测覆盖不到平台窗口行为。

## 7. 落档与提交

1. 回填任务文档（勾选 + 结果），计划状态改 ✅；
2. `CHANGELOG.md` 的 `[Unreleased]` 记一行（用户可感知→`Added/Changed/Fixed/Removed`，重构/文档归 `Internal`）；
3. 提交前确认绑定仍在（门禁查的就是它）；
4. 提交：`git add -A && git commit -m "feat(scope): 说明"`；
5. 提交后归档并释放绑定：`npm run task:archive -- <stem>`（归档物不入库，无需再提交）；
6. 需要时 `git push`。

提交信息规范见 [编码与提交规范](../standards/basic/coding-conventions.md)。

## 8. 多会话并发

- 绑定是**每计划一份**（`.agent/contexts/<stem>.yaml`），两个会话做两件事互不覆盖；
- 收尾时**带上自己的 stem**归档，不要用无参扫描；
- 发现别人改了你正在改的文件：先看 `git diff`，不要强推覆盖。

## 9. 什么时候必须先问用户

- 不可逆动作：删除数据/库表、改发布签名、强推远端；
- 改范围：从"改个文案"变成"动 ABI"；
- 只有用户知道的信息：目标平台优先级、是否要兼容旧插件、发版窗口。

其余情况按项目既有约定自行决定，并在计划里写一句"为什么这么选"。
