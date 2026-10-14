# Mission Control 部署指南（AWS）

这份文档按顺序走一遍，就能把 Mission Control 部署到公司的 AWS 账号上。第一次大约需要 1～2 小时，其中大部分时间是在等 AWS 创建资源。之后每次代码合并到 `main` 分支都会自动部署，不用再手动操作。

---

## 1. 整体结构

```
浏览器 ──HTTPS──▶ 负载均衡器 (ALB) ──▶ 应用容器 (ECS Fargate, Node.js)
                     │                         │
              证书 (ACM)                 PostgreSQL 数据库 (RDS，私有网络，不对外)
                                               │
                    Google Workspace 登录 ◀────┘   密码/密钥存在 Secrets Manager
```

- **应用**：一个 Node.js 服务，同时提供看板页面、API、Google 登录和实时推送。
- **数据库**：Amazon RDS PostgreSQL。它在私有子网里，只有应用能访问。每天自动备份，保留 14 天。
- **实时同步**：有人改了数据，服务器会通过 Server-Sent Events 推送给所有打开着看板的人。部署多个应用实例时，实例之间通过 PostgreSQL 的 LISTEN/NOTIFY 互相通知。
- **所有 AWS 资源都由一个 CloudFormation 模板创建**：[`deploy/cloudformation.yml`](../deploy/cloudformation.yml)。删除时也是删除这一个栈（数据库会自动留一份快照）。

### 每月费用估算（美国区域，1 个应用实例）

| 项目 | 约每月 |
|---|---|
| 负载均衡器 ALB | $18 |
| 应用容器（0.5 vCPU / 1 GB） | $18 |
| 数据库 db.t4g.micro + 20 GB 存储 | $15 |
| 公网 IPv4 地址（ALB 2 个 + 容器 1 个） | $11 |
| Secrets Manager、日志、镜像仓库 | $3 |
| **合计** | **约 $65** |

开启数据库多可用区（`DbMultiAz=true`）会多出约 $13/月；应用实例开到 2 个会多出约 $22/月。

---

## 2. 开始前需要准备

1. **AWS 账号**：要有管理员权限，至少要能创建 VPC、RDS、ECS、IAM 角色和 CloudFormation 栈。
2. **选一个区域（Region）**，后面所有步骤都在同一个区域里操作：
   - 同事主要在美国：`us-west-2`（俄勒冈）或 `us-east-1`
   - 中美两边都有人：`us-west-2` 通常是比较好的折中；如果中国同事访问慢，可以考虑 `ap-northeast-1`（东京）
3. **一个域名**，例如 `mission.arcsite.com`，并且你（或者 IT）能修改 `arcsite.com` 的 DNS 记录。
4. **Google Workspace 管理员**（或者有权限在 Google Cloud Console 里创建 OAuth 客户端的人）。
5. **GitHub 仓库的管理员权限**，用来设置 Actions 变量。

---

## 3. 第一次部署（一次性）

### 第 1 步：申请 HTTPS 证书（ACM）

1. 打开 AWS 控制台，切换到你选好的区域，进入 **Certificate Manager**，点 **Request**，选 **Request a public certificate**。
2. **Domain name** 填 `mission.arcsite.com`。**Validation method** 选 **DNS validation**。
3. 提交后，证书详情页会给出一条 **CNAME** 记录。把这条记录加到 `arcsite.com` 的 DNS 里（如果 DNS 在 Route 53，可以直接点 **Create records in Route 53**）。
4. 等状态变成 **Issued**，通常需要几分钟。然后复制证书的 **ARN**，第 3 步会用到。

### 第 2 步：创建 Google 登录客户端

1. 打开 [Google Cloud Console](https://console.cloud.google.com/)，用公司账号登录，新建一个项目，比如命名为 `mission-control`。
2. 进入 **APIs & Services → OAuth consent screen**（新版控制台里叫 **Google Auth Platform → Branding / Audience**）：
   - **User type 选 Internal**。这样只有 ArcSite Workspace 里的账号才能登录，外部的 Google 账号连授权页面都进不去。
   - App name 填 `Mission Control`，联系邮箱填你自己的。
   - Scopes 不用额外添加，默认的 `openid`、`email`、`profile` 就够了。
3. 进入 **APIs & Services → Credentials → Create credentials → OAuth client ID**（新版控制台：**Google Auth Platform → Clients → Create client**）：
   - Application type 选 **Web application**。
   - **Authorized redirect URIs** 添加：`https://mission.arcsite.com/auth/google/callback`
     （如果想在本机测试真实的 Google 登录，可以再加一条 `http://localhost:8765/auth/google/callback`）
4. 创建后，记下 **Client ID** 和 **Client secret**。

> 服务器端也会再检查一次：只有已验证、并且属于 `ALLOWED_DOMAINS`（默认 `arcsite.com`）的账号才能登录。

### 第 3 步：用 CloudFormation 创建所有 AWS 资源

1. AWS 控制台 → **CloudFormation → Create stack → With new resources**。
2. **Upload a template file**，选择仓库里的 `deploy/cloudformation.yml`。
3. Stack name 填 `mission-control`。
4. 填写参数：

   | 参数 | 填什么 |
   |---|---|
   | DomainName | `mission.arcsite.com` |
   | CertificateArn | 第 1 步复制的证书 ARN |
   | AllowedCidr | 默认 `0.0.0.0/0`，表示任何网络都能打开登录页（但必须登录才能看到内容）。如果想只允许公司网络或 VPN 访问，填对应的 IP 段 |
   | GoogleClientId / GoogleClientSecret | 第 2 步记下的值 |
   | AllowedDomains | `arcsite.com` |
   | AdminEmails | 你自己的公司邮箱，比如 `junyu@arcsite.com`（多个邮箱用逗号分隔） |
   | **DesiredCount** | **先填 `0`**。这时镜像仓库里还没有镜像，填 0 可以避免创建过程卡住 |
   | GitHubRepo | GitHub 仓库的 `所有者/仓库名`，比如 `arcsite/MissionControl` |
   | CreateGitHubOidcProvider | 一般填 `true`。如果这个 AWS 账号之前已经给别的项目配过 GitHub Actions 的 OIDC 身份提供商，填 `false` |
   | Jira 相关 | 可以先留空，以后再补（见第 6 节） |

5. 一路 Next。最后一页勾选 **I acknowledge that AWS CloudFormation might create IAM resources**，然后点 **Submit**。
6. 等状态变成 **CREATE_COMPLETE**。数据库创建比较慢，大约需要 15～25 分钟。
7. 打开栈的 **Outputs** 标签，后面几步会用到这里的值：`LoadBalancerDns`、`EcrRepository`、`ClusterName`、`ServiceName`、`DeployRoleArn`。

### 第 4 步：配置 GitHub 自动部署

1. 打开 GitHub 仓库，进入 **Settings → Secrets and variables → Actions → Variables** 标签，点 **New repository variable**，依次添加：

   | 变量名 | 值 |
   |---|---|
   | `AWS_REGION` | 你选的区域，比如 `us-west-2` |
   | `AWS_DEPLOY_ROLE_ARN` | Outputs 里的 `DeployRoleArn` |
   | `ECR_REPOSITORY` | Outputs 里的 `EcrRepository` |
   | `ECS_CLUSTER` | Outputs 里的 `ClusterName` |
   | `ECS_SERVICE` | Outputs 里的 `ServiceName` |

   这里不需要存任何 AWS 密钥。GitHub 通过 OIDC 临时扮演 `DeployRole`，而这个角色只能做两件事：推送镜像、更新这一个服务。

2. 把代码合并或推送到 `main` 分支，或者在 **Actions → Deploy → Run workflow** 手动运行一次。这次运行会构建镜像并推送到 ECR。因为 DesiredCount 还是 0，这时还不会启动任何容器。

### 第 5 步：启动应用

1. 回到 CloudFormation，选中栈，点 **Update → Use existing template**，只把 **DesiredCount** 改成 `1`，其他参数保持不变。一路 Next，然后 Submit。
2. 等状态变成 **UPDATE_COMPLETE**，大约需要 3～5 分钟。

### 第 6 步：把域名指向负载均衡器

在 `arcsite.com` 的 DNS 里加一条记录：

- **CNAME** `mission` → Outputs 里的 `LoadBalancerDns`（形如 `mission-xxxx.us-west-2.elb.amazonaws.com`）
- 如果 DNS 在 Route 53，可以改用 **A 记录的 Alias**，目标选这个负载均衡器。

### 第 7 步：第一次登录

1. 打开 `https://mission.arcsite.com`，用 Google 账号登录。
2. 用 `AdminEmails` 里的邮箱登录的人会自动成为管理员。管理员可以在右上角 **⋯ → People & sprint settings** 里：
   - 提前添加同事（填名字和邮箱），这样他们还没登录过也能被分配工作；
   - 设置 Sprint 起始周一和编号；
   - 授予或取消管理员、停用离职同事（停用后对方会立即被登出，但历史数据会保留）。
3. 其他同事第一次用 Google 登录时会自动加入。

部署完成后，看板上是空的，没有演示数据，直接点 **Add Project** 开始用就行。

---

## 4. 日常运维

### 发布新版本
把代码合并到 `main`，GitHub Actions 会自动跑测试、构建镜像并滚动更新。更新过程中旧容器会一直服务，直到新容器通过健康检查才下线，所以不会出现停机。如果新版本启动失败，ECS 会自动回滚到上一个版本。

### 手动回滚到某个旧版本
每个版本的镜像都用 commit 的 SHA 作为标签保存在 ECR 里（最多保留最近 30 个）。在本机装好 AWS CLI 并登录后，执行：

```bash
REGION=us-west-2
REPO=<EcrRepository>
SHA=<要回滚到的 commit SHA>
MANIFEST=$(aws ecr batch-get-image --region $REGION --repository-name $REPO --image-ids imageTag=$SHA --query 'images[0].imageManifest' --output text)
aws ecr put-image --region $REGION --repository-name $REPO --image-tag prod --image-manifest "$MANIFEST"
aws ecs update-service --region $REGION --cluster <ClusterName> --service <ServiceName> --force-new-deployment
```

更省事的做法：在 GitHub 上 revert 有问题的提交并合并到 `main`，会自动重新部署。

### 查看日志
CloudWatch → **Log groups** → `/ecs/mission-control`。登录失败、请求报错等信息都会记录在这里。

### 数据库备份与恢复
- RDS 每天自动备份，保留 14 天，可以恢复到这 14 天内的任意时间点：RDS 控制台 → 选中数据库 → **Actions → Restore to point in time**。
- 恢复操作会创建一个**新的**数据库实例。确认数据没问题后，需要把应用指向新实例。这一步比较复杂，建议需要时再找开发协助。
- 数据库开启了删除保护，删除 CloudFormation 栈时也会先自动生成一份最终快照。

### 修改配置
管理员邮箱、Jira 设置、实例数量、数据库规格这些，都可以在 CloudFormation 里通过 **Update → Use existing template** 修改参数。修改后服务会自动重启生效。

---

## 5. 安全相关

- **登录**：只接受 Google Workspace 里已验证、域名在白名单里的账号。会话保存在数据库中，Cookie 设置了 `HttpOnly`、`Secure` 和 `SameSite=Lax`；30 天内没有使用会自动过期。
- **防跨站请求伪造（CSRF）**：所有写操作都必须带一个自定义请求头，跨站请求无法带上这个头。
- **防 XSS**：所有用户输入在显示前都会转义。同时设置了严格的 Content-Security-Policy，页面只会执行我们自己域名下的脚本。
- **数据库**：放在私有子网，没有公网入口，只允许应用的安全组访问。存储加密，连接走 TLS 并校验 RDS 证书。
- **密钥**：数据库密码、Google client secret、Jira token 都存在 Secrets Manager 里，不会出现在代码仓库或 GitHub 中。
- **审计**：每一次修改都会记录是谁、什么时间、改了什么。右上角 **⋯ → Recent changes** 可以查看。

---

## 6. 可选：开启“从 Jira 导入”

1. 准备一个能查看相关 Jira 项目的账号（建议使用专门的服务账号），在 <https://id.atlassian.com/manage-profile/security/api-tokens> 创建一个 API token。
2. 在 CloudFormation 里更新栈参数：
   - `JiraBaseUrl`：`https://arcsite.atlassian.net`
   - `JiraEmail`：这个账号的邮箱
   - `JiraApiToken`：刚才创建的 token
   - `JiraStartDateField`（可选）：如果你们的 Epic 有“开始日期”自定义字段，填它的字段 ID，比如 `customfield_10015`。
3. 导入时会带入这些字段：标题、Jira 链接、经办人（如果对方已经在看板上，会自动设为 Owner）、开始日期和截止日期。导入是单向的，只在创建项目时读取一次，不会回写 Jira。

---

## 7. 常见问题

| 现象 | 可能原因 |
|---|---|
| 登录后提示 “Please sign in with your ArcSite Google Workspace account” | 用了个人 Gmail，或者邮箱的域名不在 `AllowedDomains` 里 |
| Google 提示 `redirect_uri_mismatch` | Google OAuth 客户端里的 redirect URI 和 `https://<DomainName>/auth/google/callback` 不一致，比如差了结尾的 `/`，或者写成了 http |
| 打开网站是 503 | 应用没有运行：检查 DesiredCount 是否大于 0、ECS 服务的 **Events** 标签，以及 CloudWatch 日志 |
| CloudFormation 创建卡在 Service 上 | 第一次创建时 DesiredCount 不是 0，而镜像仓库里还没有镜像。把 DesiredCount 改回 0，按第 4、5 步操作 |
| 页面底部显示 “Reconnecting…” | 与服务器的实时连接断了，会自动重连；重连后会把错过的改动补上 |
| GitHub Actions 部署报 `Not authorized to perform sts:AssumeRoleWithWebIdentity` | `GitHubRepo` 参数和实际仓库名不一致，或者不是从 `main` 分支触发的 |

---

## 8. 本地开发

```bash
npm install
cp .env.example .env      # 默认开启本地免 Google 登录，数据存在 .data/
npm run seed:demo         # 可选：导入原型里的演示数据
npm run dev               # 打开 http://localhost:8765
npm test                  # 运行服务端测试
```
