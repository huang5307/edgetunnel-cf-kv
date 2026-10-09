#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Cloudflare Workers KV 優選 IP 自動同步腳本
用途：將本地優選出的 IP/域名列表，透過 Cloudflare REST API 寫入指定 KV 命名空間
"""

import os
import sys
import requests

# ============================ 設定區 ============================
# 建議將機密憑證放置在系統環境變數中，亦可直接在此填入
ACCOUNT_ID = os.getenv("CF_ACCOUNT_ID", "08e093954032c162eda657de3c4c2e8b")
NAMESPACE_ID = os.getenv("CF_KV_NAMESPACE_ID", "050787dfb54442a898078ccae9675c3f")
API_TOKEN = os.getenv("CF_API_TOKEN", "cfut_EfoudVuqO6mHo0itwJdBAOGh1WYWWJHlM7bSRGOXd1a5f582")

# 存入 KV 的鍵名（必須與 worker.js 中的鍵名完全一致）
KV_KEY = "PREFERRED_ADDR"
# ================================================================


def update_preferred_ips(ip_list_str: str) -> bool:
    """調用 Cloudflare API 更新 KV 內容"""
    url = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/storage/kv/namespaces/{NAMESPACE_ID}/values/{KV_KEY}"

    headers = {
        "Authorization": f"Bearer {API_TOKEN}",
        "Content-Type": "text/plain; charset=utf-8"
    }

    try:
        response = requests.put(url, headers=headers, data=ip_list_str.encode("utf-8"), timeout=15)
        result = response.json()

        if result.get("success"):
            print(f"[成功] 已將最新優選地址寫入 KV [{KV_KEY}]！")
            return True
        else:
            print(f"[失敗] API 回傳錯誤: {result.get('errors')}")
            return False
    except Exception as e:
        print(f"[異常] 發送請求時發生錯誤: {str(e)}")
        return False


def load_ips_from_speedtest_csv(csv_path: str, top_n: int = 10) -> str:
    """
    從 CloudflareSpeedTest 產生的 result.csv 提取前 N 個最快節點
    CSV 欄位格式通常為：IP 地址, 端口, 延遲, 下載速度...
    """
    selected = []
    if not os.path.exists(csv_path):
        print(f"[警告] 找不到測速結果檔案: {csv_path}")
        return ""

    try:
        with open(csv_path, "r", encoding="utf-8") as f:
            lines = [line.strip() for line in f if line.strip()]

        # 跳過 CSV 第一行標頭
        for line in lines[1:top_n + 1]:
            parts = line.split(",")
            ip = parts[0]
            port = parts[1] if len(parts) > 1 else "443"
            speed = parts[5] if len(parts) > 5 else "優選"
            remark = f"CF優選-{speed}MB"
            selected.append(f"{ip}:{port}#{remark}")

        return "\n".join(selected)
    except Exception as e:
        print(f"[錯誤] 讀取 CSV 檔案失敗: {e}")
        return ""


if __name__ == "__main__":
    csv_file = "result.csv"

    if os.path.exists(csv_file):
        print(f"發現測速檔案 {csv_file}，正在提取前 10 個最優節點...")
        ip_payload = load_ips_from_speedtest_csv(csv_file, top_n=10)
    else:
        print("未發現測速檔案，使用內建備用測試清單...")
        ip_payload = """
104.16.160.1:443#官方優選-01
104.19.67.1:443#官方優選-02
162.159.197.1:443#ZeroTrust入口
        """.strip()

    if not ip_payload:
        print("未獲取到任何有效 IP，結束執行。")
        sys.exit(1)

    print("準備上傳的節點內容：")
    print(ip_payload)
    print("-" * 40)
    update_preferred_ips(ip_payload)
