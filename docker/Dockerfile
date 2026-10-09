FROM python:3.11-alpine

WORKDIR /app

# 安裝基礎工具與時區
RUN apk add --no-cache bash tzdata
ENV TZ=Asia/Taipei

# 安裝 Python 依賴
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 直接複製倉庫內建的測速核心並賦予執行權限
ADD CloudflareST_linux_amd64.tar.gz .
RUN chmod +x CloudflareST

# 複製執行腳本與配置
COPY auto_speedtest_kv.py .
COPY custom_domains.txt .
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

ENTRYPOINT ["./entrypoint.sh"]
