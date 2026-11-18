# 占比系统前端

入口：`index.html`。

与后端一起打开（推荐，端口 8765）：

```bash
cd /workspace/hs300-etf-share-app
./scripts/run_api.sh
```

访问 <http://127.0.0.1:8765/>。

仅静态预览（请勿占用 8765）：

```bash
cd /workspace/hs300-etf-share-app/web
python3 -m http.server 8877
```

访问 <http://127.0.0.1:8877/>。完整说明见上一级 [README.md](../README.md)。
