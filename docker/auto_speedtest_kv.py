#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Cloudflare IP/域名自動優選與 Workers KV 同步程式
流程：動態取得官方 IP 段 -> 調用 CloudflareST 測速 -> 篩選最優節點 -> 推送 Cloudflare KV
"""

import os
import sys
import subprocess
import requests

# ============================ 環境變數配置 ============================
ACCOUNT_ID = os.getenv("CF_ACCOUNT_ID", "")
NAMESPACE_ID = os.getenv("CF_KV_NAMESPACE_ID", "")
API_TOKEN = os.getenv("CF_API_TOKEN", "")
KV_KEY = os.getenv("CF_KV_KEY", "PREFERRED_ADDR")

# 測速參數配置
TOP_NODES_COUNT = int(os.getenv("TOP_NODES_COUNT", "10"))  # 取前幾名推送到 KV
TEST_SPEED_LIMIT = int(os.getenv("TEST_SPEED_LIMIT", "5")) # 測速下限 (MB/s)，0 代表僅測延遲
SPEEDTEST_BIN = "./CloudflareST"
IP_FILE = "ip.txt"
RESULT_FILE = "result.csv"
CUSTOM_DOMAINS_FILE = "custom_domains.txt"

CLOUDFLARE_OFFICIAL_IPV4_API = "https://www.cloudflare.com/ips-v4"


def fetch_latest_cloudflare_ips():
    """從 Cloudflare 官方端點拉取最新 IPv4 網段"""
    print("[1/4] 正在拉取 Cloudflare 官方最新 IPv4 網段...")
    ip_list = []
    try:
        resp = requests.get(CLOUDFLARE_OFFICIAL_IPV4_API, timeout=10)
        if resp.status_code == 200 and resp.text.strip():
            ip_list = [line.strip() for line in resp.text.split("\n") if line.strip()]
            print(f"      成功獲取 {len(ip_list)} 個官方 IPv4 網段。")
    except Exception as e:
        print(f"      [警告] 拉取官方 IP 段失敗 ({e})，使用本地快取/預設網段。")

    # 兜底預設官方網段（避免離線或 API 偶發異常）
    if not ip_list:
        ip_list = [
            "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22",
            "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18",
            "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22",
            "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
            "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22"
        ]

    # 寫入 CloudflareST 測速來源檔案
    with open(IP_FILE, "w", encoding="utf-8") as f:
        f.write("\n".join(ip_list) + "\n")


def run_speedtest():
    """執行 CloudflareSpeedTest 測速二進位程式"""
    print("[2/4] 開始執行本地家庭寬頻優選測速（預計耗時 1-2 分鐘）...")
    if os.path.exists(RESULT_FILE):
        os.remove(RESULT_FILE)

    # 指令參數說明：
    # -n 300: 隨機測速 300 個 IP（兼顧準確率與執行速度）
    # -t 4: 延遲測速線程數
    # -dn 5: 下載測速節點數量（針對延遲最優的前 5 個節點做實際頻寬測試）
    # -dt 5: 下載測速時間 5 秒
    # -sl: 下載測速下限
    # -o: 輸出結果檔案
    cmd = [
        SPEEDTEST_BIN,
        "-f", IP_FILE,
        "-n", "300",
        "-t", "4",
        "-dn", "5",
        "-dt", "5",
        "-sl", str(TEST_SPEED_LIMIT),
        "-o", RESULT_FILE
    ]

    try:
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        print("      測速程序執行完畢。")
    except Exception as e:
        print(f"      [錯誤] 執行 CloudflareST 失敗: {e}")
        return False
    return True


def parse_and_merge_results() -> str:
    """解析測速結果並與高品質反代域名合併"""
    print("[3/4] 整理優選節點與反代候選庫...")
    payload_nodes = []

    # 1. 讀取測速合格的 IP
    if os.path.exists(RESULT_FILE):
        try:
            with open(RESULT_FILE, "r", encoding="utf-8") as f:
                lines = [line.strip() for line in f if line.strip()]
            # 跳過標頭，取得前 N 個 IP
            for line in lines[1:TOP_NODES_COUNT + 1]:
                parts = line.split(",")
                ip = parts[0]
                port = parts[1] if len(parts) > 1 else "443"
                speed = parts[5] if len(parts) > 5 else "優選"
                payload_nodes.append(f"{ip}:{port}#家用優選-{speed}MB")
        except Exception as e:
            print(f"      解析 CSV 異常: {e}")

    # 2. 合併本地維護的高品質反代域名（確保即使純 IP 抽風時仍有備用通道）
    if os.path.exists(CUSTOM_DOMAINS_FILE):
        try:
            with open(CUSTOM_DOMAINS_FILE, "r", encoding="utf-8") as f:
                for line in f:
                    item = line.strip()
                    if item and not item.startswith("#"):
                        payload_nodes.append(item)
        except Exception as e:
            print(f"      讀取自訂域名庫異常: {e}")

    # 去重
    seen = set()
    final_nodes = []
    for node in payload_nodes:
        if node not in seen:
            seen.add(node)
            final_nodes.append(node)

    return "\n".join(final_nodes)


def update_cloudflare_kv(content: str) -> bool:
    """呼叫 Cloudflare REST API 推送至 KV"""
    print("[4/4] 正在將最新優選名單同步至 Cloudflare Workers KV...")
    if not ACCOUNT_ID or not NAMESPACE_ID or not API_TOKEN:
        print("      [錯誤] 缺少 API 認證資訊 (CF_ACCOUNT_ID / CF_KV_NAMESPACE_ID / CF_API_TOKEN)。")
        return False

    url = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/storage/kv/namespaces/{NAMESPACE_ID}/values/{KV_KEY}"
    headers = {
        "Authorization": f"Bearer {API_TOKEN}",
        "Content-Type": "text/plain; charset=utf-8"
    }

    try:
        resp = requests.put(url, headers=headers, data=content.encode("utf-8"), timeout=15)
        res_json = resp.json()
        if res_json.get("success"):
            print(f"      [成功] 節點名單已寫入 KV [{KV_KEY}]！")
            print("-" * 50)
            print("當前寫入的節點清單：")
            print(content)
            print("-" * 50)
            return True
        else:
            print(f"      [失敗] Cloudflare API 回報錯誤: {res_json.get('errors')}")
            return False
    except Exception as e:
        print(f"      [異常] 請求發送失敗: {e}")
        return False


def main():
    fetch_latest_cloudflare_ips()
    success = run_speedtest()
    if not success and not os.path.exists(CUSTOM_DOMAINS_FILE):
        print("無法取得任何有效節點，終止更新。")
        sys.exit(1)

    final_payload = parse_and_merge_results()
    if final_payload:
        update_cloudflare_kv(final_payload)
    else:
        print("沒有篩選出任何節點，取消推送。")


if __name__ == "__main__":
    main()
