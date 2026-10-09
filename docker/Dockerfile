FROM python:3.11-alpine

WORKDIR /app

# 安裝基礎工具庫與依賴
RUN apk add --no-cache curl tar bash tzdata

# 設定時區為台北/香港 (UTC+8)
ENV TZ=Asia/Taipei

# 下載並安裝 CloudflareSpeedTest (x86_64 架構)
# 若 QNAP 為 ARM 架構 (如 Realtek/Annapurna CPU)，請將 amd64 改為 arm64
ENV CST_VERSION=v2.2.5
RUN curl -fsSL -o CloudflareST.tar.gz "https://github.com/XIU2/CloudflareSpeedTest/releases/download/${CST_VERSION}/CloudflareST_linux_amd64.tar.gz" \
    && tar -zxf CloudflareST.tar.gz \
    && rm -f CloudflareST.tar.gz \
    && chmod +x CloudflareST

# 安裝 Python 依賴
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 複製應用代碼與腳本
COPY auto_speedtest_kv.py .
COPY custom_domains.txt .
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

ENTRYPOINT ["./entrypoint.sh"]
