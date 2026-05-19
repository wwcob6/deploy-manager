# 投产需求清单管理工具

内网部署的投产需求管理工具，支持多人协作、GitHub/GitLab 分支管理、SQL 脚本下载、管理员认证。

## 架构

```
用户浏览器 ──→ nginx (:80) ────→ index.html (前端)
                  │
            /api/* proxy_pass
                  │
                  └──→ Windows Node.js (:3000) ←── 你的本地机器
                       ├── start.js
                       ├── data.json          (共享业务数据)
                       └── git-config.json    (Git Token，管理员配置)
```

- **前端**：纯静态 HTML，部署在 nginx 服务器，所有用户通过浏览器访问
- **后端**：Node.js，运行在你的 Windows 机器上，处理数据读写和版本控制
- **Git Token**：存在服务端 `git-config.json`，管理员配一次，全员可用

## 功能

- **投产窗口管理**：按年份组织投产窗口，新建/编辑/删除
- **需求清单**：每个窗口内管理需求，含代码模块、SQL 脚本、评审状态
- **统计面板**：一眼查看窗口内需求总数、已评审、已合并、SIT/UAT 报告收集情况
- **延期追踪**：延期需求汇总展示，支持恢复上线
- **Git 集成**：一键获取 GitHub / GitLab 项目列表和分支，下拉选择
- **SQL 管理**：支持查询/执行/回退三段式 SQL，单个下载或打包下载 ZIP
- **版本冲突检测**：多人同时编辑时，后保存者会收到冲突提示
- **搜索过滤**：按需求名称/编号实时过滤
- **管理员认证**：配置 Git Token 需要密码，普通用户只读使用

## 文件说明

```
├── index.html    # 前端页面（内置全部 CSS/JS，无外部依赖）
├── start.js      # Node.js 后端
├── start.py      # Python 后端
├── nginx.conf    # nginx 配置示例
└── README.md
```

## 部署

### 第一步：启动后端（你的 Windows 机器）

```cmd
:: 方式一：默认密码
node start.js

:: 方式二：自定义管理员密码
set ADMIN_PASSWORD=你的密码
node start.js

:: 启动后输出:
:: http://localhost:3000
```

### 第二步：部署前端（nginx 服务器）

1. 把 `index.html` 放到 nginx 的 html 目录
2. 把 `nginx.conf` 中的 `你的Windows内网IP` 改为 Windows 的实际内网 IP
3. reload nginx

### 第三步：配置 Git Token

管理员打开页面 → 点左下角「仓库设置」→ 输入管理员密码（默认 `admin123`）→ 配置 Token

## 数据存储

| 文件 | 位置 | 内容 |
|------|------|------|
| `data.json` | Windows | 投产窗口、需求数据，带版本号 |
| `git-config.json` | Windows | Git Token，管理员可写 |

## 管理员 vs 普通用户

| 操作 | 普通用户 | 管理员 |
|------|---------|--------|
| 查看需求、统计面板 | ✓ | ✓ |
| 新建/编辑/删除需求 | ✓ | ✓ |
| 搜索、下载 SQL | ✓ | ✓ |
| 获取 Git 分支列表 | ✓（Token 自动加载） | ✓ |
| 修改 Git Token | ✗ | ✓（需输密码） |
