# dsh-plugin-jevagent (DeepSeek Harness JevAgent 插件)

面向 **DeepSeek Harness (DSH)** 的 JevAgent 编程专用扩展插件。

> **规范对照**：
> - 核心理论与架构基准：《JevAgent 设计稿 V2.0》
> - 工程落地与接口标准：《JevAgent 工程落地稿 V3.0》
> - 架构重构指南：《JevAgent 重构方案：二文件模型与库导入层》
> - 验收基准：《JevAgent 插件修复验收反馈报告》

---

## 一、定位与设计理念

JevAgent 不是替代通用 Agent 的系统，而是通用 Agent 的**编程专用扩展工具（注册于 `tools` 字段）**：
- **通用 Agent（编排层）**：负责理解用户意图、选表、编写特化语义 DSL（唯一真相源 SSOT）、在代码中打分隔符、组织全局状态与语义审查。
- **JevAgent（执行层）**：负责读分隔符逐块拆分与组装、在封闭路由树中寻址与规范化、动态符号匹配、模板填充、双向往返翻译、以及确定性的封闭集合决策。

核心价值：**把语法补全从通用 Agent 的繁重工作中剥离，在封闭集合内做精确判断，彻底消除代码层幻觉**。

---

## 二、二文件模型（Two-File Model）

高层语义层（`.high.dsl`）已彻底移除，每个模块在同目录下具有相同基名、以不同扩展名区分为二文件表示：

```text
<module>.spec.<lang>.dsl       # 特化语义 DSL（唯一真相源 SSOT / 绑定目标语言与 node: 路径）
<module>.<ext>                 # 最终可执行代码（如 .py / .c / .sh / .js / .go）
```

同目录还由插件全自动生成与维护：
- `blocks_index.json`：跟踪块 ID、二文件对应关系、符号定义/使用、块状态（`draft` / `translated` / `confirmed`）。
- `manifest.json`：统一版本绑定文件（包含 `model: "two_file_v3"`, `syntax_core: "syntax_core_v1"`, `skeleton_applied: true`, `required_imports_version`, `jevagent_version: "3.0.0"` 等 17 项元数据）。

---

## 三、块类别机制与设计心智 (Block Categories)

JevAgent 采用严格的三分块类别机制，处理对齐检查与代码落盘：

| 块类别 | 典型例子 | 存在于 spec | 存在于 code | 参与对齐检查 | 说明 |
|---|---|:---:|:---:|:---:|---|
| **`emitting`** | 普通业务逻辑块 | ✅ | ✅ | ✅ | 默认类别，生成实际目标代码，按块 ID 严格对齐。 |
| **`declaration-only`** | `names` 保留块 | ✅ | ❌ | ❌ | **仅用于符号宇宙声明**，定义符号来源、类型与库归属。 |
| **`hoisted`** | `imports` 保留块 | ✅ | ✅ | ✅ | 由工具自动提升置顶到文件首部。 |

> ⚠️ **关于 `names` 块的设计心智提醒**：  
> `names` 块属于 `declaration-only`，它的作用是为校验防火墙提供类型与库依赖推导，**绝对不会生成任何实际运行代码**。  
> **如果开发者需要声明模块运行时真实存在的全局变量、全局常量或初始状态，请写在普通的 emitting 块中**（例如在普通逻辑块中书写 `设 偏移量 = 10` 或 `设 常量_上限: int = 100`）。

---

## 四、核心机制与特性

### 1. 通用关键字核 (`syntax_core_v1`)
语言无关的核心语法表，闭集管理 12 个核心控制流关键字（`定义`、`返回`、`如果`、`否则如果`、`否则`、`对于`、`当`、`跳出`、`继续`、`设`、`输出`、`输入`）及通用运算符（如 `<=`, `并且`, `非`），各语言表通过 `core_conformance`（`supported` / `conditional` / `unsupported`）进行履约。

### 2. 校验防火墙 (`check_spec`)
在代码生成之前执行符号级引用合法性拦截，具有 100% 阻断保护：
- **未知即硬错误 (`[unknown_node]`)**：未识别写法坚决不落盘，附带编辑距离最近候选建议。
- **显式逃生舱**：仅允许显式标记 `原生 python "..."` / `原生 c "..."` 透传，逃生舱必须显式且可 grep。
- **跨语言误写纠偏 (`confusions`)**：闭集纠偏（如 C 语言中误写 `print()` 给出指导拦截）。

### 3. 库导入闭包保证 (Import Closure)
- **隐式推导**：代码中调用 `printf` 时，工具闭包自动补充 `#include <stdio.h>`；
- **显式声明**：在 spec 中书写 `引入 math`、`从 math 引入 sqrt`、`引入 numpy 作为 np`；
- **自动置顶**：工具自动合并去重并回写 spec（标记 `origin:auto` / `origin:declared`），且兼容在 spec 中直接书写 `import math` / `#include <stdio.h>`。

### 4. 类型驱动代码生成与 C 语言定长数组
- 支持在 `names` 或 `设 ` 中声明变量类型；
- **C 语言定长数组规范转换**：支持将 `设 arr: int[7] = { ... }` 准确转换为标准 C 语法 `int arr[7] = { ... };`，参数声明 `arr: int[10]` 转换为 `int arr[10]`。
- **格式符推导**：`输出(变量)` 自动根据变量类型解析格式符（整数为 `%d`，字符串为 `%s`），避免 UB 警告。

---

## 五、工具接口清单（16 项原子能力）

插件向 DSH 注册名为 `jevagent` 的工具，提供以下 16 项能力：

| Action | 说明 |
|---|---|
| `split_blocks` | 扫描并提取文件中的 `@jev-block` 块信息（行号、嵌套、内容、自由文本） |
| `spec_to_code` | **编写流程**：读取特化语义 DSL，经过防火墙预检、闭包推导后生成最终代码 |
| `code_to_spec` | **转换流程**：反向提取已有代码为 spec DSL，支持自由区外部导入自动收纳 |
| `translate_block` | **修改流程**：按 `block_id` 仅局部翻译修改的单块，实现 O(改动块数) 的无全量重跑维护 |
| `check_alignment` | 二文件对齐检查：校验 spec 与 code 是否存在、块 ID 集合与顺序是否严格一致 |
| `check_spec` | **校验防火墙预检**：对 spec 执行纯语法与符号引用检查，不生成代码，输出完整报告 |
| `check_tables` | **履约覆盖率矩阵**：校验各语言表对核心语法核的履约完整性，输出语言 × 节点矩阵 |
| `spec_to_spec` | **跨语言迁移**：多语言间迁移转换，产出 verbatim / partial / rewrite 差异分类报告 |
| `spec_export` | **只读导出**：剥离 `node:` 路径标注，输出适合人工阅读与存档的纯净规范文本 |
| `rollback` | 恢复确认点备份（支持单块局部回滚或全文件回滚） |
| `list_tables` | 列出当前加载的所有内置与外部路由表（含 `syntax_core_v1` 等） |
| `import_table` | 动态导入外部自定义语言或领域路由树表 JSON |
| `validate_vocab` | 词表工厂验证器：对候选词表进行 schema、同义词冲突、分类合规性验证 |
| `jev_decision` | Jev 决策端点：向独立 Jev 决策模型发起 Choice / Score / Noul 结构化决策调用 |
| `get_config` | 查看当前 Jev API 地址、密钥状态、模型及独立开关配置 |
| `set_config` | 动态配置 Jev API 地址、密钥、模型及独立开关（持久化至 `~/.dsh/jevagent.json`） |

---

## 六、在 DSH 桌面版中的挂载与配置

本插件为 **DeepSeek Harness** 官方推荐的编程扩展插件：

1. 在 Profile 的 `package.json` 中作为依赖与 bundle 引入：
   ```json
   {
     "dependencies": {
       "dsh-plugin-jevagent": "^3.0.0"
     },
     "dsh": {
       "profile": {
         "bundles": [
           "@deepseek-ai/dsh-base",
           "@deepseek-ai/dsh-web-app",
           "dsh-plugin-jevagent"
         ]
       }
     }
   }
   ```
2. 在 `cordis.patch.yml` 中挂载配置：
   ```yaml
   - id: tool-jevagent
     name: dsh-plugin-jevagent
     config:
       jev_enabled: true
       jev_base_url: "" # 留空使用本地确定性规则，或填入自定义 Jev 服务端点
       jev_model: "jevk5-4b-v0.3-Q4_K_M"
       jev_timeout_s: 120
       tables_dir: "C:\\Users\\Administrator\\.dsh\\plugins\\dsh-plugin-jevagent\\tables"
   ```
3. 凭据遵循 **K1~K6 规范**，自动持久化在 `~/.dsh/jevagent.json`，重启不会回退，掩码自动防御。

---

## 七、测试与质量验收

在插件目录下运行内置测试套件：

```powershell
# 运行全部 18 项单元与集成测试
node test/test-jevagent.mjs

# 验证官方预设模式声明（标准模式、PTC模式、创造模式）
node test/verify-presets.mjs

# 运行端到端 AI 编码流程仿真
node test/e2e-ai-simulation.mjs
```

所有测试在 Windows 10/11 环境、GCC 14.2.0、bash 5.2.37 及 Python 3.12 下均 100% 全绿通过。
