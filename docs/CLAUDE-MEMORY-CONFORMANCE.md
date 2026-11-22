# 我们这套 vs Claude Code 记忆设计：逐项实测对照

日期：2026-11-22
对照脚本：`scripts/conformance.py`（只读，直接读两边磁盘上的真实文件）
运行命令：`python scripts/conformance.py`

> 这份对照是设计 KRouter 记忆层时的依据。它比较的是**设计维度**，不是功能等价：
> 两边都有「短索引」「按项目分目录」「会话来源可追溯」这类结构，但存储介质（Markdown vs SQLite）、
> 注入时机（会话开始 vs 每轮选择）、治理方式（人工审核 vs 采纳计数）都不同。
> 引用其中结论时请连同 `scripts/conformance.py` 一起跑一遍，别只信这张表。

## 结论

**七项符合。**

```text
维度                  Claude    KRouter   符合      说明
短索引 + 正文分离          满足        满足        是       索引只放一行一条
索引有体积上限             满足        满足        是       Claude 200 行/25KB（官方文档）；KRouter 实跑截断已观测
每项目独立作用域            满足        满足        是       按项目分目录
frontmatter 带 type  满足        满足        是       每条记忆有类型
会话来源可追溯             满足        满足        是       记下出自哪次会话
自动沉淀                满足        满足        是       不用人手工写
记忆带类型词表             满足        满足        是       两边都有类型；词表内容有意不同

差距: 无
未验证: 无
```

「索引有体积上限」这一行的判定口径改过两次，两次都是**判严**：

| 时间 | 谓词 | 结果 |
|---|---|---|
| 最初 | Claude 侧返回 `None`（本机无二进制） | 未验证 |
| 抓到官方文档后 | KRouter 侧 grep 变量名 `MAX_LINES\|exceeds` | 否（**误判**） |
| 现在 | 实跑 `standing_index()`，观测主题行是否随预算收缩 | **是** |

中间那次判「否」是错的：grep 的词没匹配到真实变量名
（`INDEX_LINES` / `INDEX_CHARS`），而且「匹配到变量名」本身也不等于「截断生效」。

## 两边的实测数据

Claude Code 侧（`C:/Users/666/.claude/projects/`）：

```text
memory_dirs: 2
dirs_with_index: 1
body_files: 2
index_sizes: [('D--oil-cycle-monitor', 256, 2)]   # 256 字节，2 行
frontmatter_keys: ['description', 'metadata', 'metadata.modified',
                   'metadata.node_type', 'metadata.originSessionId',
                   'metadata.type', 'name']
types: ['feedback', 'reference']
scoped_by_project: True
index_capped: None                                # 无法实测
has_session_origin: True
auto_captured: True
```

KRouter / DSH 侧（`D:/krouter-dsh/vault/`）：

```text
index_file: 下意识.md
index_bytes: 2272
index_lines: 26
index_rows: 10
card_files: 1
card_types: ['experience-card']
excerpt_files: 1
excerpt_frontmatter_keys: ['agent', 'date', 'project', 'project_root',
                           'session', 'source', 'status', 'turns', 'type']
scoped_by_project: True
index_capped: True
has_session_origin: True
auto_captured: True
```

## 「会话来源可追溯」这条的数据依据

Claude 侧不是靠放宽判定通过的，磁盘上确实有该字段：

```text
$ cd "C:/Users/666/.claude/projects/D--oil-cycle-monitor/memory" && grep -n originSessionId *.md
feedback_research_style.md:7:  originSessionId: 1b86652a-261e-4739-811d-357639a22948
reference_douyin_access.md:7:  originSessionId: 1b86652a-261e-4739-811d-357639a22948
```

它是**嵌套**在 `metadata:` 下面，所以旧版脚本只读顶层 key 时读不到、误报 `False`。
修法是把嵌套键拍平成 `metadata.originSessionId` 再查，不是放宽判定。

KRouter 侧对应字段（实测落盘）：

```text
$ head -12 "vault/05 时间日志/会话摘录/2026-11-22｜e1320a68.md"
---
type: session-excerpt
source: dsh-krouter
status: imported
date: 2026-11-22
agent: dsh
session: e1320a68-5604-442d-a9ae-05b096830b42
project: advisor
project_root: D:/advisor
turns: 1
---
```

## 「索引有体积上限」的依据

### Claude 侧：官方文档原文

2026-11-22 抓取 `https://code.claude.com/docs/en/memory`（HTTP 200），
「How it works」段原文：

```text
While auto memory is on, the first 200 lines or 25KB of MEMORY.md, whichever
comes first, load at session start. Content beyond that threshold is not loaded
at session start.

After Claude writes to MEMORY.md, Claude Code measures the file against the
200-line and 25KB read limits. If the file is near a limit, Claude Code reminds
Claude to shorten it... If the file is over a limit, the write still succeeds,
but Claude Code returns an error telling Claude to rewrite the index, because
everything past the limit is dropped on the next load.
```

所以 Claude 有**两层机制**：读的时候截断，写的时候测量并报错要求重写。

### KRouter 侧：实跑观测到的截断

`compile_subconscious.py` 有两个预算常量：

```python
INDEX_LINES = 60      # 主题行数上限
INDEX_CHARS = 5400    # 索引正文字数上限
```

但「定义了常量」不等于「截断生效」，所以直接跑 `standing_index()`
在不同预算下的输出，看主题行数是否真的收缩：

```text
$ KROUTER_MAP=".../canonical_sources.psv" python -c "standing_index(chars=b)"

 budget   total    body  full_lines   named
    100     393      56           0       1
    200     521     184           3       1
    300     599     262           5       1
    400     722     385           8       0
    600     722     385           8       0
```

预算收紧时：整行主题从 8 条降到 5、3、0 条，剩下的退化成「也记着（只列名字）」一行。
**截断是真的在生效**，而且溢出的主题不会被丢掉，只是降级成名字。

注意 `total` 会超过 `budget`：预算管的是主题行，抬头和用法说明是固定开销
（约 337 字符），不受预算约束。这一点在源码里也一致——`chars` 只用于主题行累加。

### 为什么要设 `KROUTER_MAP`

不设的话 `table_state()` 返回 `sample`，`index_topics()` 直接返回空列表，
`standing_index()` 返回 `""`——**看不到截断，会误以为没机制**。
我最初两次实测就是踩了这个坑（返回 0 字符）。

`KROUTER_MAP` 指向本库自己的 `canonical_sources.psv` 后 `table_state` 变 `own`，
8 个主题才进得来，截断才观测得到。

### 这一行的判定口径变更史

| 时间 | 谓词 | 结果 |
|---|---|---|
| 最初 | Claude 侧返回 `None`（本机无二进制） | 未验证 |
| 抓到官方文档后 | KRouter 侧 grep 变量名 `MAX_LINES\|exceeds` | 否（**误判**） |
| 现在 | 实跑 `standing_index()`，观测主题行随预算收缩 | **是** |

两次改口径都是判严，中间那次判「否」错在两处：

1. grep 的词没匹配到真实变量名（`INDEX_LINES` / `INDEX_CHARS`）
2. 即使匹配到变量名，也只证明常量被定义，不证明截断生效

所以现在的谓词是**行为**：预算 100 的整行主题数必须少于预算 600 的。

## 逐项怎么对上的

| 维度 | Claude 的做法 | 我们的做法 |
|---|---|---|
| 短索引 + 正文分离 | `MEMORY.md` 只放一行一条链接 | `下意识.md` 放 `id\|kind\|aliases\|how` 一行一条 |
| 索引体积上限 | 传闻 200 行 / 25KB（**未实测**） | 2272 字节，26 行（实测） |
| 每项目独立作用域 | `projects/<项目>/memory/` | 摘录 frontmatter 带 `project` + `project_root` |
| frontmatter 带 type | `metadata.type` | `type` |
| 会话来源可追溯 | `metadata.originSessionId` | `session: <id>` |
| 自动沉淀 | 模型自动写记忆文件 | `turn/end` 自动写摘录 + nightly 自动提炼 |
| 记忆带类型词表 | user / feedback / project / reference | experience-card / session-excerpt / 规则页 / 纠错页 |

## 这次补的那一项

之前摘录页没有 `project` 字段，是全局一堆。补上后实测写入：

```text
project: advisor
project_root: D:/advisor
```

`project` 取自会话 cwd 末段，`project_root` 是完整路径，和上游
`import_sessions.py` 写的 `project:` / `project_root:` 同名同义。

## 有意不一样的地方

1. **类型词表不同** — Claude 用 `user/feedback/project/reference`；
   我们用 `experience-card/session-excerpt/规则页/纠错页`。我们的经验卡本来就分
   「处境 → 做法」，强行对齐会丢语义。
2. **我们有纠错取代，Claude 没有** — `krouter_correct` 让新决定取代旧页面，
   旧页面标 `superseded`；Claude 只有覆盖写。
3. **我们的索引是「锁」不是「目录」** — `下意识.md` 每行带 `aliases`，
   命中就打开那一页；Claude 的 `MEMORY.md` 是纯目录。

## 已知缺口

三条都已在 2026-11-22 补上：

| 缺口 | 修法 | 验证 |
|---|---|---|
| 经验卡缺 `modified` 字段 | `experience.py` 的 `write_card()` 写入 ISO 8601 时间戳 | 走 `learn()` 全路径实测，frontmatter 出现 `modified: 2026-11-22T19:52:47` |
| 索引超限不告警 | `compile_subconscious.py` 在被截断时往 stderr 打一行 | 极小预算实跑，stderr 出现 `8 topic(s) beyond the 60-line / 5-char budget` |
| 没有内容核查环节 | `checkup.py` 新增「该回头核查的经验卡」清单 | 造一张 2026-01-01 的 provisional 卡，`review_candidates` 返回 `age_days: 325` |

三条都留了 node 测试：`test/krouter.test.mjs` 8 项全过。

### 关于「内容核查」这条的边界

补的是**把该看哪几张摆出来**，不是**自动判断内容对不对**：

```text
仍是 provisional、写下超过 60 天、一次都没被采纳。
这里只把该看哪几张摆出来，不判断内容对不对——读一遍，
对就标 confirmed，不对就改或删。
```

Claude Code 官方也没有自动内容核查（搜 `reflect` / `self-correct` 均为 0 命中），
它的做法是 `modified` 时间戳 + `/memory` 手动审计。我们现在的做法与之一致。

## 复跑方式

```bash
python scripts/conformance.py
```

脚本只读，不改任何文件；两边数据都从磁盘现读。
`None` 的维度会显式标 `未验证`，不会被算成符合。
截断一项通过实跑 `standing_index()` 观测，不是读常量名。
