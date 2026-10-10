# AI 招聘副驾

K12 教师招聘的 AI 助手：Chrome 插件在智联招聘企业版页面里读取简历做 AI 初筛、给出约聊回复建议；后台管理人才池（以约聊结果为核心）和面试排程（AI 约到场时段，前台当天按面试官空闲分配）。

- 管理后台：http://101.201.77.185/hr/
- 技术文档：[docs/技术文档.md](docs/技术文档.md)

## 快速开始

```bash
# 服务器（Ubuntu，Node ≥ 22.13，已装 pm2、nginx）
git clone git@github.com:banksfarida509-stack/songtianyu.git && cd songtianyu
bash deploy/deploy.sh          # 首次会生成 /opt/hr-agent/.env 和管理员密码
```

本地开发：

```bash
cd server
HR_ADMIN_PASS=dev HR_PORT=3199 npm start   # 打开 http://127.0.0.1:3199/hr/
npm test
```

插件：后台“设置 → 下载插件”，在 `chrome://extensions` 开发者模式下加载解压后的文件夹。
