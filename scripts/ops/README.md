# scripts/ops — 一次性运维脚本

这些脚本**不参与构建、测试或运行**，是开发过程中用来操作远程主机和 GitHub 的临时工具。
保留它们是为了留下操作记录，需要时可以直接复用。

| 脚本 | 用途 | 敏感信息 |
| --- | --- | --- |
| `ssh-run.mjs` | 通过 SSH 在目标主机执行单条命令，密码经临时 askpass 文件传递 | 密码从 argv 传入 |
| `container-sh.mjs` | 在 ATRI 容器内执行 shell 片段（经 stdin 传入，避免本地 shell 二次解释） | 同上 |
| `host-sh.mjs` | 在 ATRI 宿主机执行 shell 片段 | 同上 |
| `make-payload.mjs` | 从路径清单生成 Git Data API 的上传负载（`{ path, content }`，删除用 `sha: null`） | 无 |
| `push-diff.mjs` | 计算 blob SHA 并列出与远端的差异（含 CRLF→LF 归一化） | 无 |
| `push-upload.mjs` | 经 `gh api` 上传 blob → tree → commit → 更新分支 | 依赖 `gh` 登录态 |
| `push-upload2.mjs` | 同上，改用 argv 分离与 stdin 负载，避免 Windows 引号问题 | 同上 |
| `push-commit.mjs` | 用多行提交信息创建最终提交并强推 `main` | 同上 |
| `validate-payload.mjs` | 校验 jsonl 负载每行都是含 `path`+`content` 的合法 JSON | 无 |

**为什么放在子目录里**：`scripts/` 根目录只保留 `package.json` 真正调用的入口
（`build.mjs`、`test.mjs`、`backup.ts`、`restore.ts`）以及有文档引用的 `smoke.mjs`、
`check-api-pairs.mjs`。这些脚本没有任何引用，混在一起会让"这个文件还要不要"变成每次都
要重新判断的问题。

`push-*.mjs` 和 `ssh-run.mjs` 会接触仓库写权限与主机登录，因此不要在不受控的环境里运行。
