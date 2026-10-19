# User Instruction Memory

This file records user instructions, preferences, and teachings for reference in future interactions.

## Format

[User Instruction Summary]
- Date: YYYY-MM-DD
- Context: scenario
- Instructions:
  - content

## Entries

[Frontend & Preview Workflow]
- Date: 2026-10-19
- Context: Rewriting the admin frontend and previewing it
- Category: Environment Configuration / Troubleshooting & Debugging
- Instructions:
  - 前端整体以浅色为主题，不做深色模式切换
  - 前端不使用浏览器原生下拉框（<select>），用自研 dropdown 组件（apps/api/public/app.js 的 createDropdown）
  - 服务端把 public/ 静态文件缓存在内存（server.ts staticCache）：改完前端必须重启 dev server，否则预览仍是旧文件
  - 预览启动方式：后台终端运行 `ADMIN_PASSWORD=preview-test-pass npm run dev`（端口 3000），用 request_preview 获取预览地址
  - UI 冒烟测试技巧：用全局 jsdom（NODE_PATH=$(npm root -g)）+ 自定义 fetch shim（必须维护 cookie jar，Node fetch 不会自动回传 set-cookie）模拟加载-登录-渲染；只 curl 状态码发现不了白屏类问题
