# 自動優選IP保存到KV EdgeTunnel on Cloudflare Workers (動態 KV 優選版)

基於 Cloudflare Workers 的輕量級 VLESS over WebSocket 代理轉發伺服器，支援從 Workers KV 動態讀取最新優選節點與自動生成訂閱。

## 系統架構

1. **傳輸層**：客戶端 (v2rayN / Clash) -> Cloudflare 邊緣 CDN (WebSocket)。
2. **協定層**：Worker 解析 VLESS 握手標頭，驗證 UUID。
3. **出站轉發**：透過 `cloudflare:sockets` TCP 連線將流量直連轉發至目標伺服器。
4. **動態訂閱**：
   - 存取 `https://<自訂域名>/<UUID>` 下載標準 VLESS 訂閱。
   - 優先讀取 Workers KV (`KV_STORAGE` -> `PREFERRED_ADDR`) 節點清單。
   - 支援將落地節點自動切換為住宅 IP (OpenVPN 鏈式代理)。

---

## 部署與設定流程

### 1. 建立 Workers KV 命名空間
1. 登入 Cloudflare 控制台 -> **Workers 和 Pages** -> **KV**。
2. 建立命名空間，名稱為 `EDGE_KV`。
3. 新增鍵值對：
   - **金鑰 (Key)**：`PREFERRED_ADDR`
   - **值 (Value)**：貼上 `sample_ips.txt` 中的優選 IP 清單。

### 2. 部署 Worker 代碼
1. 建立一個新的 Worker，將專案中的 `worker.js` 完整貼入編輯器中。
2. 修改程式碼頂部的 `認證令牌` 為個人專屬的 UUID。
3. 進入該 Worker 的 **Settings** -> **Bindings**：
   - 新增 **KV Namespace Binding**。
   - 變數名稱 (**Variable name**) 務必設定為：`KV_STORAGE`。
   - 選擇剛才建立的 `EDGE_KV`。
4. 儲存並部署。

### 3. 綁定自訂網域 (必做)
*官方 `*.workers.dev` 網域在大陸地區存在 DNS 與 SNI 阻斷，必須綁定自己的網域。*
1. 進入 Worker 的 **Settings** -> **Domains & Routes**。
2. 點擊 **Add** -> **Custom Domain**，綁定二級或三級網域（如 `cf.yourdomain.com`）。

---

## 本地自動更新優選 IP (選用)

若未來需要透過本地測速（如 CloudflareSpeedTest）自動更新節點：

1. 進入 `scripts/` 目錄：
   ```bash
   cd scripts
   pip install -r requirements.txt
