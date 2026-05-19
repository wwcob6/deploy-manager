# 投产需求清单管理工具

内网部署的投产需求管理工具，支持多人协作、GitHub/GitLab 分支管理、SQL 脚本下载。

## 功能

- **投产窗口管理**：按年份组织投产窗口，新建/编辑/删除
- **需求清单**：每个窗口内管理需求，含代码模块、SQL 脚本、评审状态
- **统计面板**：一眼查看窗口内需求总数、已评审、已合并、SIT/UAT 报告收集情况
- **延期追踪**：延期需求汇总展示，支持恢复上线
- **Git 集成**：一键获取 GitHub / GitLab 项目列表和分支，下拉选择
- **SQL 管理**：支持查询/执行/回退三段式 SQL，单个下载或打包下载 ZIP
- **版本冲突检测**：多人同时编辑时，后保存者会收到冲突提示
- **搜索过滤**：按需求名称/编号实时过滤

## 文件说明

```
├── index.html    # 前端页面（内置全部 CSS/JS，无外部依赖）
├── start.js      # Node.js 后端（推荐）
├── start.py      # Python 后端（Python 3.4+ 可用）
└── README.md
```

## 部署方式

### 方式一：Node.js（推荐）

```bash
# 1. 安装 Node.js（如已安装跳过）
# 2. 启动服务
node start.js
# 3. 访问 http://localhost:3000
```

### 方式二：Python

```bash
# Python 3.4+ 自带 http 模块，无需安装任何库
python start.py
# 访问 http://localhost:3000
```

### 方式三：nginx + 后端

```
# nginx 配置
server {
    listen 80;
    location / {
        root /path/to/project;
        index index.html;
    }
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
    }
}
```

修改 `index.html` 第 290 行指向后端地址：
```js
var API_BASE = 'http://后端IP:3000';  // 前后端分离时填写
```

## 使用说明

1. **新建年份**：左侧菜单点 [+] 按钮
2. **新建投产窗口**：展开年份 → 点击「+ 新建投产窗口」→ 输入日期（格式：20260531）
3. **新建需求**：点击投产窗口 → 「+ 新建需求」→ 填写需求信息
4. **获取 Git 项目列表**：编辑需求 → 点「获取项目列表」→ 选择项目 → 分支自动加载
5. **下载 SQL**：展开需求行 → 点「下载」下载单个 SQL，或顶部「下载全部SQL」打包下载 ZIP
6. **搜索**：在需求列表上方搜索框输入关键词过滤
7. **延期**：编辑需求 → 将状态改为「延期」→ 延期需求在顶部汇总展示

## Git 仓库配置

点击左侧菜单底部「⚙ 仓库设置」：

| 配置项 | GitHub | GitLab（内网） |
|--------|--------|---------------|
| 仓库类型 | 选 GitHub | 选 GitLab |
| GitLab 地址 | 无需填写 | `https://gitlab.yourcompany.com` |
| Token | Personal Access Token | Personal Access Token |

Token 仅存储在浏览器 localStorage，不会上传到服务器。

## 数据存储

- **共享模式**：通过后端服务访问时，数据存储在服务端 `data.json`（自动创建），所有用户共享
- **本地模式**：直接打开 HTML 文件时，数据存储在浏览器 localStorage，仅自己可见
- 标题旁会显示「共享」或「本地」标识当前模式
