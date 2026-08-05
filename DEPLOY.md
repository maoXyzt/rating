# 图片评分平台部署流程

这份文档用于把当前项目部署到服务器。项目已经切换为 SQLite，不需要安装 MongoDB。

## 1. 部署架构

- `web`：前端静态页面，运行在 Nginx 容器里，对外暴露 `8080` 端口。
- `api`：Node.js / Express 服务，处理 ZIP 分片上传、图片解析、评分保存。
- `sqlite_data`：Docker volume，保存 SQLite 数据库。
- `image_uploads`：Docker volume，保存解压后的图片文件。

默认访问地址：

```bash
http://服务器IP:8080
```

## 2. 服务器准备

推荐环境：

- Linux 服务器，Ubuntu 22.04 / 24.04 或 CentOS 系均可。
- Docker 与 Docker Compose 插件。
- 至少 2GB 内存。
- 磁盘空间按图片 ZIP 包大小预留，建议至少 20GB 起。
- 放行端口：`8080`。如果配置域名和 HTTPS，再放行 `80`、`443`。

安装 Docker 的官方文档：

```bash
curl -fsSL https://get.docker.com | bash
systemctl enable docker
systemctl start docker
docker --version
docker compose version
```

## 3. 一键部署

把代码放到服务器，例如：

```bash
cd /opt
git clone <你的仓库地址> image-rating-platform
cd image-rating-platform
```

如果没有 Git 仓库，也可以把项目压缩包上传到 `/opt` 后解压，进入项目根目录即可。

首次启动：

```bash
docker compose up --build -d
```

查看容器状态：

```bash
docker compose ps
```

打开浏览器访问：

```text
http://服务器IP:8080
```

看到页面后，进入管理页上传 ZIP 图包即可。

## 4. 常用运维命令

查看日志：

```bash
docker compose logs -f api
docker compose logs -f web
```

重启服务：

```bash
docker compose restart
```

停止服务：

```bash
docker compose down
```

更新代码后重新发布：

```bash
git pull
docker compose up --build -d
```

注意：不要随意执行 `docker compose down -v`，它会删除 SQLite 数据和上传图片对应的 Docker volume。

## 5. 数据持久化位置

Docker 部署时，数据不会写在项目源码目录里，而是写入 Docker volume：

- SQLite 数据库：`sqlite_data`
- 上传图片：`image_uploads`

查看实际 volume 名称：

```bash
docker volume ls | grep sqlite_data
docker volume ls | grep image_uploads
```

Compose 会根据项目目录名给 volume 加前缀，例如 `image-rating-platform_sqlite_data`。

## 6. 备份数据

在项目根目录执行：

```bash
mkdir -p backups
docker run --rm -v image-rating-platform_sqlite_data:/data -v "$PWD/backups:/backup" alpine tar czf /backup/sqlite_data_$(date +%Y%m%d_%H%M%S).tgz -C /data .
docker run --rm -v image-rating-platform_image_uploads:/data -v "$PWD/backups:/backup" alpine tar czf /backup/image_uploads_$(date +%Y%m%d_%H%M%S).tgz -C /data .
```

如果你的 volume 前缀不同，把命令里的 `image-rating-platform_sqlite_data` 和 `image-rating-platform_image_uploads` 替换成 `docker volume ls` 看到的实际名称。

## 7. 恢复数据

先停止服务：

```bash
docker compose down
```

恢复 SQLite volume：

```bash
docker run --rm -v image-rating-platform_sqlite_data:/data -v "$PWD/backups:/backup" alpine sh -c "rm -rf /data/* && tar xzf /backup/你的_sqlite_备份文件.tgz -C /data"
```

恢复图片 volume：

```bash
docker run --rm -v image-rating-platform_image_uploads:/data -v "$PWD/backups:/backup" alpine sh -c "rm -rf /data/* && tar xzf /backup/你的_uploads_备份文件.tgz -C /data"
```

恢复后启动：

```bash
docker compose up -d
```

## 8. 域名和 HTTPS

如果你希望使用域名访问，建议让本项目继续监听 `8080`，在服务器宿主机 Nginx 上反向代理到 `127.0.0.1:8080`。

宿主机 Nginx 示例：

```nginx
server {
  listen 80;
  server_name your.domain.com;

  client_max_body_size 64m;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
  }
}
```

启用 HTTPS 可以使用 Certbot：

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d your.domain.com
```

## 9. 环境变量

`docker-compose.yml` 里已经配置了默认值：

```yaml
PORT: 3000
DB_PATH: /app/data/image-rating.sqlite
UPLOAD_DIR: /app/uploads
```

通常不需要修改。只有在你要改变容器内部存储路径或端口时才需要调整。

## 10. 常见问题

上传 ZIP 报 `413 Request Entity Too Large`：

- 检查本项目的 `client/nginx.conf` 是否包含 `client_max_body_size 64m;`。
- 如果前面还有宿主机 Nginx 或云厂商网关，也要把它们的上传限制调大。

页面能打开，但接口失败：

- 执行 `docker compose ps` 确认 `api` 和 `web` 都在运行。
- 执行 `docker compose logs -f api` 查看服务端错误。

重新部署后数据不见了：

- 检查是否误用了 `docker compose down -v`。
- 检查当前目录名是否变化，Compose 项目名变化会导致 volume 前缀变化。

上传成功但图片不可访问：

- 执行 `docker compose logs -f api` 查看解压和文件保存日志。
- 确认 `image_uploads` volume 正常挂载。

## 11. 本地开发启动

本地开发不需要 MongoDB，SQLite 会自动创建。

```bash
npm run install:all
npm run dev
```

默认前端为 Vite 地址，后端为 `3000` 端口。生产环境优先使用 Docker Compose。
