#!/bin/sh
set -e

# 設定排程時間，預設為每天 16:00 (可透過環境變數 CRON_SCHEDULE 覆蓋)
SCHEDULE="${CRON_SCHEDULE:-0 16 * * *}"

echo "=== EdgeTunnel KV Auto-Updater 啟動 ==="
echo "目前時區: $(date '+%Z %z')"
echo "設定排程: ${SCHEDULE} (每天下午 16:00)"

# 寫入系統 crontab
echo "${SCHEDULE} cd /app && python auto_speedtest_kv.py" > /etc/crontabs/root

# 容器剛啟動時，先手動執行一次確保連線與 KV 正常 (若不需要可註解此行)
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 容器啟動，執行初次測速同步..."
python auto_speedtest_kv.py || echo "[警告] 初次執行異常，排程將持續在背景等待"

# 啟動 Alpine crond (前台運行 -f，日誌級別 -l 2)
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 排程守護程序已就緒，等待指定時間觸發..."
exec crond -f -l 2
